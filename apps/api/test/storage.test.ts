import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase, type DatabaseClient } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';
import { LocalFsStorage, verifyLocalSignedToken } from '../src/storage/local-fs.js';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe('LocalFsStorage & API Scaffold Smoke Tests', () => {
  const tempDirs: string[] = [];
  const openDbs: DatabaseClient[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      const db = openDbs.pop();
      if (db) {
        await db.close();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function createTempStorage() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'traceb3-storage-'));
    tempDirs.push(dir);
    const signingSecret = 'test-signing-secret-at-least-32-chars';
    const storage = new LocalFsStorage({
      baseDir: dir,
      apiPublicUrl: 'http://localhost:3001',
      signingSecret,
    });
    return { dir, signingSecret, storage };
  }

  it('stores, streams, verifies SHA-256, and handles missing files as null', async () => {
    const { storage } = await createTempStorage();
    const payload = Buffer.from('Jababeka B3 Weighbridge Slip #001\nweight=250kg\n');
    const key = 'batches/b3-001/weighbridge-slip.txt';

    expect(await storage.exists(key)).toBe(false);
    expect(await storage.getStream(key)).toBeNull();

    const putRes = await storage.put(key, payload, 'text/plain');
    expect(putRes.key).toBe(key);
    expect(putRes.sizeBytes).toBe(payload.byteLength);
    expect(await storage.exists(key)).toBe(true);

    const stream = await storage.getStream(key);
    expect(stream).not.toBeNull();
    const downloaded = await readStreamToBuffer(stream!);
    expect(sha256Hex(downloaded)).toBe(sha256Hex(payload));

    // Stream upload via Readable
    const streamKey = 'batches/b3-001/manifest-copy.txt';
    await storage.put(streamKey, Readable.from([payload]), 'text/plain');
    const stream2 = await storage.getStream(streamKey);
    expect(sha256Hex(await readStreamToBuffer(stream2!))).toBe(sha256Hex(payload));

    // Upsert=false rejects duplicate put
    await expect(
      storage.put(key, payload, 'text/plain', { upsert: false }),
    ).rejects.toThrow(/already exists/i);
  });

  it('signs download URLs with HMAC-SHA256 and rejects tampered or expired tokens', async () => {
    const { storage, signingSecret } = await createTempStorage();
    const key = 'evidence/manifest.pdf';
    const signedUrl = await storage.getSignedDownloadUrl(
      key,
      'manifest.pdf',
      300,
    );

    expect(signedUrl.startsWith('http://localhost:3001/v1/evidence/signed/')).toBe(
      true,
    );
    const token = signedUrl.split('/').pop()!;
    const verified = verifyLocalSignedToken(token, signingSecret);
    expect(verified.path).toBe(key);
    expect(verified.filename).toBe('manifest.pdf');

    // Tampered token signature or payload fails
    const [payloadPart, sigPart] = token.split('.');
    const tamperedSig = `${payloadPart}.${sigPart!.slice(0, -1)}${sigPart!.endsWith('a') ? 'b' : 'a'}`;
    expect(() => verifyLocalSignedToken(tamperedSig, signingSecret)).toThrow(
      /signature/i,
    );

    const tamperedPayload = Buffer.from(
      JSON.stringify({ p: 'evidence/other.pdf', fn: 'other.pdf', exp: verified.exp }),
      'utf8',
    ).toString('base64url');
    expect(() =>
      verifyLocalSignedToken(`${tamperedPayload}.${sigPart}`, signingSecret),
    ).toThrow(/signature/i);

    // Expired token fails
    const expiredUrl = await storage.getSignedDownloadUrl(key, 'manifest.pdf', -5);
    const expiredToken = expiredUrl.split('/').pop()!;
    expect(() => verifyLocalSignedToken(expiredToken, signingSecret)).toThrow(
      /expired/i,
    );
  });

  it('blocks path traversal across put, getStream, exists, and signed URLs', async () => {
    const { storage } = await createTempStorage();
    const maliciousPaths = [
      '../escape.txt',
      '..\\escape.txt',
      'nested/../../escape.txt',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'bad\0null.txt',
      '',
      '.',
    ];

    for (const badPath of maliciousPaths) {
      await expect(
        storage.put(badPath, Buffer.from('x'), 'text/plain'),
      ).rejects.toThrow();
      await expect(storage.getStream(badPath)).rejects.toThrow();
      await expect(storage.exists(badPath)).rejects.toThrow();
      await expect(
        storage.getSignedDownloadUrl(badPath, 'file.txt', 60),
      ).rejects.toThrow();
    }
  });

  it('serves /healthz, /openapi.json (3.1.0), /docs, CORS, and RFC 9457 errors', async () => {
    const { storage } = await createTempStorage();
    const db = await createDatabase('pglite://memory');
    openDbs.push(db);
    await db.migrate();

    const config = loadConfig({
      DATABASE_URL: 'pglite://memory',
      FRONTEND_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    });
    const logger = createLogger({ level: 'silent' });
    const app = createApp({ config, logger, db, storage });

    const healthRes = await app.request('/healthz', {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get('x-request-id')).toBeTruthy();
    expect(healthRes.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
    const healthJson = (await healthRes.json()) as {
      status: string;
      checks: { database: { ok: boolean }; storage: { ok: boolean } };
    };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.checks.database.ok).toBe(true);
    expect(healthJson.checks.storage.ok).toBe(true);

    // Disallowed origin must not receive CORS allow-origin header
    const badOriginRes = await app.request('/healthz', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(badOriginRes.headers.get('access-control-allow-origin')).toBeNull();

    // OpenAPI 3.1.0 spec
    const specRes = await app.request('/openapi.json');
    expect(specRes.status).toBe(200);
    const specJson = (await specRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(specJson.openapi).toBe('3.1.0');
    expect(specJson.paths['/healthz']).toBeDefined();

    // Scalar docs page
    const docsRes = await app.request('/docs');
    expect(docsRes.status).toBe(200);
    const docsHtml = await docsRes.text();
    expect(docsHtml).toContain('/openapi.json');

    // RFC 9457 404 problem+json
    const notFoundRes = await app.request('/v1/does-not-exist');
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    const problem = (await notFoundRes.json()) as {
      status: number;
      code: string;
      title: string;
      requestId?: string;
    };
    expect(problem.status).toBe(404);
    expect(problem.code).toBe('NOT_FOUND');
    expect(problem.requestId).toBeTruthy();
  });
});
