import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  sanitizeStorageKey,
  type StorageAdapter,
  type StorageHealthCheckResult,
  type StoragePutOptions,
  type StoragePutResult,
} from './adapter.js';

export interface LocalFsStorageOptions {
  baseDir: string;
  apiPublicUrl: string;
  signingSecret: string;
}

export interface VerifiedLocalSignedToken {
  path: string;
  filename: string;
  exp: number;
}

interface LocalSignedTokenPayload {
  p: string;
  fn: string;
  exp: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function signPayload(payloadB64: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret)
    .update(payloadB64)
    .digest('base64url');
}

/**
 * Verifies an HMAC-SHA256 local download token and checks expiry and key safety.
 */
export function verifyLocalSignedToken(
  token: string,
  signingSecret: string,
  options?: { nowSeconds?: number },
): VerifiedLocalSignedToken {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid signed download token format');
  }

  const [payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig) {
    throw new Error('Invalid signed download token parts');
  }

  const expectedSig = signPayload(payloadB64, signingSecret);
  const providedBuf = Buffer.from(providedSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new Error('Invalid signed download token signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed signed download token payload');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as LocalSignedTokenPayload).p !== 'string' ||
    typeof (parsed as LocalSignedTokenPayload).fn !== 'string' ||
    typeof (parsed as LocalSignedTokenPayload).exp !== 'number' ||
    !Number.isFinite((parsed as LocalSignedTokenPayload).exp)
  ) {
    throw new Error('Invalid signed download token claims');
  }

  const claims = parsed as LocalSignedTokenPayload;
  const cleanKey = sanitizeStorageKey(claims.p);
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (nowSeconds >= claims.exp) {
    throw new Error('Signed download token has expired');
  }

  return {
    path: cleanKey,
    filename: claims.fn,
    exp: claims.exp,
  };
}

/**
 * Local filesystem StorageAdapter with strict traversal guards and HMAC-signed URLs.
 */
export class LocalFsStorage implements StorageAdapter {
  readonly driverName = 'local' as const;
  readonly baseDir: string;
  private readonly apiPublicUrl: string;
  private readonly signingSecret: string;

  constructor(options: LocalFsStorageOptions) {
    this.baseDir = path.resolve(options.baseDir);
    this.apiPublicUrl = options.apiPublicUrl.replace(/\/+$/, '');
    this.signingSecret = options.signingSecret;
  }

  private resolveSafeTarget(storagePath: string): {
    key: string;
    fullPath: string;
  } {
    const key = sanitizeStorageKey(storagePath);
    const fullPath = path.resolve(this.baseDir, ...key.split('/'));
    const rel = path.relative(this.baseDir, fullPath);

    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Invalid storage path: escapes base storage directory');
    }

    return { key, fullPath };
  }

  async put(
    storagePath: string,
    data: Buffer | Uint8Array | Readable,
    _contentType: string,
    options?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const { key, fullPath } = this.resolveSafeTarget(storagePath);

    if (options?.upsert === false && (await this.exists(key))) {
      throw new Error(`Storage object already exists at "${key}"`);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    if (data instanceof Readable) {
      await pipeline(data, createWriteStream(fullPath));
      const stat = await fs.stat(fullPath);
      return { key, sizeBytes: stat.size };
    }

    await fs.writeFile(fullPath, data);
    return { key, sizeBytes: data.byteLength };
  }

  async getStream(storagePath: string): Promise<Readable | null> {
    const { fullPath } = this.resolveSafeTarget(storagePath);

    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        return null;
      }
      return createReadStream(fullPath);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    const { fullPath } = this.resolveSafeTarget(storagePath);

    try {
      const stat = await fs.stat(fullPath);
      return stat.isFile();
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  async getSignedDownloadUrl(
    storagePath: string,
    filename: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const key = sanitizeStorageKey(storagePath);
    const payload: LocalSignedTokenPayload = {
      p: key,
      fn: filename,
      exp: Math.floor(Date.now() / 1000) + Math.trunc(expiresInSeconds),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const sig = signPayload(payloadB64, this.signingSecret);
    return `${this.apiPublicUrl}/v1/evidence/signed/${payloadB64}.${sig}`;
  }

  async healthCheck(): Promise<StorageHealthCheckResult> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.access(this.baseDir, fsConstants.R_OK | fsConstants.W_OK);
      return { ok: true, driver: 'local' };
    } catch (err) {
      return {
        ok: false,
        driver: 'local',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
