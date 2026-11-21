import {
  ChainClient,
  ChainReconciler,
  ChainRelayWorker,
  createApp,
  createDatabase,
  createLogger,
  createStorageAdapter,
  loadConfig,
  type AppConfig,
  type DatabaseClient,
} from '@traceb3/api';

export interface EmbeddedApiRuntime {
  app: ReturnType<typeof createApp>;
  db: DatabaseClient;
  relayer: ChainRelayWorker;
  reconciler: ChainReconciler;
  config: AppConfig;
}

const globalForApi = globalThis as typeof globalThis & {
  __traceb3EmbeddedApiPromise?: Promise<EmbeddedApiRuntime>;
};

function buildServerEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const vercelHost =
    env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || env.VERCEL_URL?.trim();

  const derivedPublicAppUrl =
    env.PUBLIC_APP_URL?.trim() ||
    env.NEXT_PUBLIC_PUBLIC_APP_URL?.trim() ||
    (vercelHost ? `https://${vercelHost}` : undefined);

  if (!env.PUBLIC_APP_URL && derivedPublicAppUrl) {
    env.PUBLIC_APP_URL = derivedPublicAppUrl;
  }

  if (!env.SIWE_DOMAIN) {
    if (derivedPublicAppUrl) {
      try {
        env.SIWE_DOMAIN = new URL(derivedPublicAppUrl).host;
      } catch {
        if (vercelHost) {
          env.SIWE_DOMAIN = vercelHost;
        }
      }
    } else if (vercelHost) {
      env.SIWE_DOMAIN = vercelHost;
    }
  }

  if (!env.API_PUBLIC_URL && derivedPublicAppUrl) {
    env.API_PUBLIC_URL = `${derivedPublicAppUrl.replace(/\/+$/, '')}/api`;
  }

  const existingOrigins = (
    env.FRONTEND_ORIGINS || 'http://localhost:3000,http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const candidateOrigins = [
    ...existingOrigins,
    derivedPublicAppUrl,
    env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`
      : undefined,
    env.VERCEL_URL ? `https://${env.VERCEL_URL.trim()}` : undefined,
  ].filter((origin): origin is string => Boolean(origin && origin.length > 0));

  env.FRONTEND_ORIGINS = [...new Set(candidateOrigins)].join(',');
  return env;
}

async function initEmbeddedApiRuntime(): Promise<EmbeddedApiRuntime> {
  const config = loadConfig(buildServerEnv());
  const logger = createLogger({
    level: config.LOG_LEVEL,
    name: 'traceb3-api-vercel',
  });
  const db = await createDatabase(config.DATABASE_URL);
  if (config.DATABASE_URL.startsWith('pglite://')) {
    await db.migrate();
  }
  const storage = createStorageAdapter(config);
  const chain = new ChainClient(config);
  const relayer = new ChainRelayWorker({
    config,
    logger,
    db,
    chain,
  });
  const reconciler = new ChainReconciler({
    config,
    logger,
    db,
    chain,
  });
  const app = createApp({
    config,
    logger,
    db,
    storage,
    chain,
    relayer,
  });

  return { app, db, relayer, reconciler, config };
}

/**
 * Lazily initializes and reuses the embedded Hono API runtime across warm Node.js invocations.
 */
export async function getEmbeddedApiRuntime(): Promise<EmbeddedApiRuntime> {
  if (!globalForApi.__traceb3EmbeddedApiPromise) {
    globalForApi.__traceb3EmbeddedApiPromise = initEmbeddedApiRuntime().catch(
      (err) => {
        globalForApi.__traceb3EmbeddedApiPromise = undefined;
        throw err;
      },
    );
  }
  return globalForApi.__traceb3EmbeddedApiPromise;
}
