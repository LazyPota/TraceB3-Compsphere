import { Readable } from 'node:stream';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { ProblemDetailsSchema } from '@traceb3/core';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { AppError } from '../errors.js';
import {
  createRequireAuth,
  getAuthContext,
  requireRoles,
  type AuthEnv,
} from '../middleware/auth.js';
import {
  ingestEvidenceUpload,
  issueEvidenceDownloadUrl,
} from '../services/evidence.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { verifyLocalSignedToken } from '../storage/local-fs.js';

const EvidenceUploadResponseSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid().nullable(),
  eventId: z.string().uuid().nullable(),
  filename: z.string(),
  label: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string(),
  createdAt: z.string(),
});

const SignedDownloadResponseSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string(),
});

const uploadEvidenceRoute = createRoute({
  method: 'post',
  path: '/v1/batches/{id}/evidence',
  tags: ['Evidence'],
  summary:
    'Upload waste manifest or weighbridge evidence (use batchId="staging" prior to batch creation)',
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z
              .custom<File>(
                (val) => typeof File !== 'undefined' && val instanceof File,
                'Multipart field "file" must be a valid File',
              )
              .openapi({ type: 'string', format: 'binary' }),
            label: z.string().max(160).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Evidence stored and hashed server-side',
      content: { 'application/json': { schema: EvidenceUploadResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Batch not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    413: {
      description: 'Evidence file exceeds MAX_UPLOAD_MB',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    415: {
      description: 'Unsupported evidence file magic bytes',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const downloadEvidenceRoute = createRoute({
  method: 'get',
  path: '/v1/evidence/{id}/download',
  tags: ['Evidence'],
  summary: 'Generate a short-lived signed download URL for an evidence file',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Short-lived signed download URL and expected SHA-256',
      content: { 'application/json': { schema: SignedDownloadResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden organization access',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Evidence not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

export function createEvidenceRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  storage: StorageAdapter;
}) {
  const router = new OpenAPIHono<AuthEnv & { Variables: { requestId?: string } }>();
  const requireAuth = createRequireAuth(deps.config, deps.db);
  const requireUploaderRole = requireRoles(
    'GENERATOR',
    'TRANSPORTER',
    'FACILITY',
    'ADMIN',
  );

  router.use('/v1/batches/*/evidence', requireAuth, requireUploaderRole);
  router.use('/v1/evidence/*/download', requireAuth);

  return router
    .openapi(uploadEvidenceRoute, async (c) => {
      const auth = getAuthContext(c);
      const { id } = c.req.valid('param');
      const form = c.req.valid('form');
      const requestId =
        typeof c.get('requestId') === 'string' ? c.get('requestId') : undefined;

      const uploaded = await ingestEvidenceUpload({
        db: deps.db,
        storage: deps.storage,
        config: deps.config,
        auth,
        batchParam: id,
        file: form.file,
        label: form.label,
        requestId,
      });

      return c.json(uploaded, 201);
    })
    .openapi(downloadEvidenceRoute, async (c) => {
      const auth = getAuthContext(c);
      const { id } = c.req.valid('param');
      const signed = await issueEvidenceDownloadUrl({
        db: deps.db,
        storage: deps.storage,
        auth,
        evidenceId: id,
      });
      return c.json(signed, 200);
    })
    .get('/v1/evidence/signed/:token', async (c) => {
      const token = c.req.param('token');
      let verified: ReturnType<typeof verifyLocalSignedToken>;
      try {
        verified = verifyLocalSignedToken(token, deps.config.JWT_SECRET);
      } catch (err) {
        throw AppError.unauthenticated(
          err instanceof Error ? err.message : 'Invalid signed download token',
        );
      }

      const stream = await deps.storage.getStream(verified.path);
      if (!stream) {
        throw AppError.notFound('Evidence blob no longer exists in storage');
      }

      const safeFilename = verified.filename.replace(/["\\\r\n]/g, '_');
      const webStream = Readable.toWeb(stream) as ReadableStream;

      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${safeFilename}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    });
}
