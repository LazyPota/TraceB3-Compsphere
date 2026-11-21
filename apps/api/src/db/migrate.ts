import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import {
  createDatabase,
  resolveDefaultMigrationsFolder,
  type DatabaseClient,
} from './index.js';

export function resolveMigrationsFolder(): string {
  return resolveDefaultMigrationsFolder();
}

export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = resolveMigrationsFolder(),
): Promise<void> {
  const client: DatabaseClient = await createDatabase(databaseUrl);
  try {
    await client.migrate(migrationsFolder);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const cwdEnv = path.resolve(process.cwd(), '.env');
  const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  }
  if (existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv });
  }
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.LOG_LEVEL, name: 'traceb3-migrate' });
  const folder = resolveMigrationsFolder();

  logger.info(
    { driver: config.DATABASE_URL.startsWith('pglite://') ? 'pglite' : 'postgres', migrationsFolder: folder },
    'Applying database migrations',
  );
  await runMigrations(config.DATABASE_URL, folder);
  logger.info('Database migrations completed');
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  });
}
