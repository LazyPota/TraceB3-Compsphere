import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { ChainClient } from './chain/client.js';
import { ChainRelayWorker } from './chain/relayer.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { ChainReconciler } from './jobs/reconciler.js';
import { createLogger } from './logger.js';
import { createStorageAdapter } from './storage/index.js';

function loadEnvFiles(): void {
  const cwdEnv = path.resolve(process.cwd(), '.env');
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  }
  if (existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv });
  }
}

export async function startServer(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.LOG_LEVEL });
  const db = await createDatabase(config.DATABASE_URL);
  await db.migrate();
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
  relayer.start();
  reconciler.start();

  const app = createApp({
    config,
    logger,
    db,
    storage,
    chain,
    relayer,
  });

  const server = serve(
    {
      fetch: app.fetch,
      port: config.PORT,
      hostname: config.HOST,
    },
    (info) => {
      logger.info(
        {
          host: config.HOST,
          port: info.port,
          dbDriver: db.driver,
          storageDriver: storage.driverName,
          chainId: chain.chainId,
          ledgerAddress: chain.ledgerAddress ?? null,
          demoMode: config.DEMO_MODE,
        },
        'TRACEB3 API server listening',
      );
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down TRACEB3 API server');
    reconciler.stop();
    await relayer.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await db.close();
    logger.info('Shutdown complete');
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start TRACEB3 API server:', err);
    process.exitCode = 1;
  });
}
