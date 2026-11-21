import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DbDriver = 'pglite' | 'postgres';
export type DbSchema = typeof schema;
export type DbExecutor = PgDatabase<PgQueryResultHKT, DbSchema>;

export interface HealthCheckResult {
  ok: boolean;
  driver: DbDriver;
  detail?: string;
}

export interface DatabaseClient {
  readonly db: DbExecutor;
  readonly driver: DbDriver;
  migrate(migrationsFolder?: string): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<HealthCheckResult>;
}

/**
 * Resolves the absolute path to apps/api/drizzle relative to this module,
 * ensuring migrations work regardless of the process working directory.
 */
export function resolveDefaultMigrationsFolder(): string {
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

function assertMigrationsFolderExists(folder: string): string {
  const resolved = path.resolve(folder);
  if (!existsSync(resolved)) {
    throw new Error(`Migrations folder does not exist: ${resolved}`);
  }
  return resolved;
}

function resolvePgliteTarget(databaseUrl: string): string {
  const target = databaseUrl.slice('pglite://'.length).trim();
  if (target === '' || target === 'memory' || target === ':memory:') {
    return 'memory://';
  }
  const dataDir = path.resolve(target);
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Creates a dual-mode PostgreSQL client supporting both PGlite (memory/disk)
 * and standard PostgreSQL / Supabase connection strings.
 */
export async function createDatabase(
  databaseUrl: string,
): Promise<DatabaseClient> {
  if (databaseUrl.startsWith('pglite://')) {
    const target = resolvePgliteTarget(databaseUrl);
    const client = new PGlite(target);
    await client.waitReady;

    const pgliteDb = drizzlePglite(client, { schema });
    let closed = false;

    return {
      db: pgliteDb as unknown as DbExecutor,
      driver: 'pglite',
      async migrate(migrationsFolder?: string): Promise<void> {
        const folder = assertMigrationsFolderExists(
          migrationsFolder ?? resolveDefaultMigrationsFolder(),
        );
        await migratePglite(pgliteDb, { migrationsFolder: folder });
      },
      async close(): Promise<void> {
        if (!closed) {
          closed = true;
          await client.close();
        }
      },
      async healthCheck(): Promise<HealthCheckResult> {
        try {
          await client.query('SELECT 1 AS ok');
          return { ok: true, driver: 'pglite' };
        } catch (err) {
          return {
            ok: false,
            driver: 'pglite',
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  }

  if (
    databaseUrl.startsWith('postgres://') ||
    databaseUrl.startsWith('postgresql://')
  ) {
    const sqlClient = postgres(databaseUrl, {
      max: 10,
      prepare: false,
    });
    const pgDb = drizzlePostgres(sqlClient, { schema });
    let closed = false;

    return {
      db: pgDb as unknown as DbExecutor,
      driver: 'postgres',
      async migrate(migrationsFolder?: string): Promise<void> {
        const folder = assertMigrationsFolderExists(
          migrationsFolder ?? resolveDefaultMigrationsFolder(),
        );
        await migratePostgres(pgDb, { migrationsFolder: folder });
      },
      async close(): Promise<void> {
        if (!closed) {
          closed = true;
          await sqlClient.end({ timeout: 5 });
        }
      },
      async healthCheck(): Promise<HealthCheckResult> {
        try {
          await sqlClient`SELECT 1 AS ok`;
          return { ok: true, driver: 'postgres' };
        } catch (err) {
          return {
            ok: false,
            driver: 'postgres',
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  }

  throw new Error(
    `Unsupported DATABASE_URL scheme: expected pglite://, postgres://, or postgresql://`,
  );
}
