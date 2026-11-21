import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createApp,
  createDatabase,
  createLogger,
  loadConfig,
  LocalFsStorage,
} from '@traceb3/api';
import { afterEach, describe, expect, it } from 'vitest';
import { createTraceB3Client, normalizeWeightToGrams } from '../src/index.js';

describe('@traceb3/sdk typed client', () => {
  const tempDirs: string[] = [];
  const openDbs: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      await openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('calls typed Hono RPC endpoints and re-exports core helpers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'traceb3-sdk-'));
    tempDirs.push(dir);

    const db = await createDatabase('pglite://memory');
    openDbs.push(db);
    await db.migrate();

    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'pglite://memory',
      LOCAL_STORAGE_DIR: dir,
    });
    const storage = new LocalFsStorage({
      baseDir: dir,
      apiPublicUrl: config.API_PUBLIC_URL,
      signingSecret: config.JWT_SECRET,
    });
    const app = createApp({
      config,
      logger: createLogger({ level: 'silent' }),
      db,
      storage,
    });

    const client = createTraceB3Client('http://localhost:3001', {
      fetch: (input, init) => Promise.resolve(app.request(input, init)),
    });

    const healthRes = await client.healthz.$get();
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.status).toBe('ok');

    const chainRes = await client.v1.chain.info.$get();
    expect(chainRes.status).toBe(200);
    const chainInfo = await chainRes.json();
    expect(chainInfo.chainId).toBe(31337);

    const nonceRes = await client.v1.auth.nonce.$get();
    expect(nonceRes.status).toBe(200);
    const nonce = await nonceRes.json();
    expect(nonce.chainId).toBe(31337);
    expect(nonce.nonce.length).toBeGreaterThanOrEqual(8);

    expect(normalizeWeightToGrams('850', 'kg').grams).toBe('850000');
  });
});
