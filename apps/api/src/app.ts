import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ChainClient } from './chain/client.js';
import { ChainRelayWorker } from './chain/relayer.js';
import type { AppConfig } from './config.js';
import type { DatabaseClient } from './db/index.js';
import { AppError, problemResponse } from './errors.js';
import type { Logger } from './logger.js';
import type { AuthContext } from './middleware/auth.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createEvidenceRouter } from './routes/evidence.js';
import { createIntentsRouter } from './routes/intents.js';
import { createSystemRouter } from './routes/system.js';
import type { StorageAdapter } from './storage/index.js';

export const API_VERSION = '0.1.0';

export interface AppEnv {
  Variables: RequestIdVariables & {
    auth?: AuthContext;
  };
}

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: DatabaseClient;
  storage: StorageAdapter;
  chain?: ChainClient;
  relayer?: ChainRelayWorker;
}

const ComponentCheckSchema = z.object({
  ok: z.boolean(),
  driver: z.string(),
  detail: z.string().optional(),
});

const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  timestamp: z.string(),
  checks: z.object({
    database: ComponentCheckSchema,
    storage: ComponentCheckSchema,
  }),
});

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  tags: ['System'],
  summary: 'Service health check',
  description:
    'Verifies connectivity to PostgreSQL (PGlite or Supabase Postgres) and the configured evidence storage adapter.',
  responses: {
    200: {
      description: 'Service is healthy',
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
    },
    503: {
      description: 'One or more dependencies are degraded',
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

/**
 * Builds the configured Hono OpenAPI application with security headers, CORS,
 * structured request logging, RFC 9457 error handling, OpenAPI 3.1 spec, and Scalar docs.
 */
export function createApp(deps: AppDeps) {
  const allowedOrigins = new Set(deps.config.FRONTEND_ORIGINS);
  const chain = deps.chain ?? new ChainClient(deps.config);
  const relayer =
    deps.relayer ??
    new ChainRelayWorker({
      config: deps.config,
      logger: deps.logger,
      db: deps.db,
      chain,
    });

  const baseApp = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        }));
        return problemResponse(
          c,
          AppError.validation('Request validation failed', issues),
        );
      }
      return undefined;
    },
  });

  baseApp.use('*', requestId());
  baseApp.use('*', secureHeaders());
  baseApp.use(
    '*',
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Request-Id',
      ],
      exposeHeaders: ['X-Request-Id', 'Content-Disposition'],
      credentials: true,
      maxAge: 600,
    }),
  );

  baseApp.use('*', async (c, next) => {
    const startMs = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      },
      'HTTP request completed',
    );
  });

  baseApp.notFound((c) =>
    problemResponse(
      c,
      AppError.notFound(`Route ${c.req.method} ${c.req.path} not found`),
    ),
  );

  baseApp.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.status >= 500) {
        deps.logger.error(
          {
            err,
            requestId: c.get('requestId'),
            method: c.req.method,
            path: c.req.path,
          },
          'Application server error',
        );
      }
      return problemResponse(c, err);
    }

    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      const mapped = new AppError({
        status,
        code:
          status === 401
            ? 'UNAUTHENTICATED'
            : status === 403
              ? 'FORBIDDEN_ROLE'
              : status === 404
                ? 'NOT_FOUND'
                : status >= 500
                  ? 'INTERNAL_ERROR'
                  : 'VALIDATION_ERROR',
        title: err.message || 'HTTP Error',
        detail: err.message || 'Request failed',
      });
      return problemResponse(c, mapped);
    }

    deps.logger.error(
      {
        err,
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
      },
      'Unhandled request error',
    );
    return problemResponse(c, AppError.internal());
  });

  const typedApp = baseApp
    .openapi(healthRoute, async (c) => {
      const [database, storage] = await Promise.all([
        deps.db.healthCheck(),
        deps.storage.healthCheck(),
      ]);

      const healthy = database.ok && storage.ok;
      const payload = {
        status: healthy ? ('ok' as const) : ('degraded' as const),
        version: API_VERSION,
        timestamp: new Date().toISOString(),
        checks: {
          database,
          storage,
        },
      };

      return healthy ? c.json(payload, 200) : c.json(payload, 503);
    })
    .route(
      '/',
      createSystemRouter({
        db: deps.db,
        storage: deps.storage,
        chain,
      }),
    )
    .route(
      '/',
      createAuthRouter({
        config: deps.config,
        db: deps.db,
        chain,
      }),
    )
    .route(
      '/',
      createAdminRouter({
        config: deps.config,
        db: deps.db,
        relayer,
      }),
    )
    .route(
      '/',
      createEvidenceRouter({
        config: deps.config,
        db: deps.db,
        storage: deps.storage,
      }),
    )
    .route(
      '/',
      createIntentsRouter({
        config: deps.config,
        db: deps.db,
        chain,
        relayer,
      }),
    );

  typedApp.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  typedApp.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'TRACEB3 Digital Waste Passport API',
      version: API_VERSION,
      description:
        'Shared, tamper-evident industrial B3 waste custody API complementing Festronik and MONIJA.',
    },
  });

  typedApp.get(
    '/docs',
    Scalar({
      url: '/openapi.json',
      pageTitle: 'TRACEB3 API Reference',
    }),
  );

  return typedApp;
}

export type AppType = ReturnType<typeof createApp>;
