import type { Readable } from 'node:stream';

export interface StoragePutOptions {
  upsert?: boolean;
  cacheControl?: string;
}

export interface StoragePutResult {
  key: string;
  sizeBytes?: number;
}

export interface StorageHealthCheckResult {
  ok: boolean;
  driver: 'local' | 'supabase';
  detail?: string;
}

export interface StorageAdapter {
  readonly driverName: 'local' | 'supabase';
  put(
    storagePath: string,
    data: Buffer | Uint8Array | Readable,
    contentType: string,
    options?: StoragePutOptions,
  ): Promise<StoragePutResult>;
  getStream(storagePath: string): Promise<Readable | null>;
  exists(storagePath: string): Promise<boolean>;
  getSignedDownloadUrl(
    storagePath: string,
    filename: string,
    expiresInSeconds: number,
  ): Promise<string>;
  healthCheck(): Promise<StorageHealthCheckResult>;
}

/**
 * Validates and normalizes a relative storage object key, rejecting any path traversal
 * or platform-specific absolute/backslash segments.
 */
export function sanitizeStorageKey(storagePath: string): string {
  if (!storagePath || storagePath.includes('\0')) {
    throw new Error('Invalid storage path: empty or contains null byte');
  }

  if (
    storagePath.startsWith('/') ||
    storagePath.startsWith('\\') ||
    storagePath.includes('\\') ||
    /^[a-zA-Z]:/.test(storagePath)
  ) {
    throw new Error('Invalid storage path: absolute paths and backslashes are not allowed');
  }

  const segments = storagePath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid storage path segment in "${storagePath}"`);
    }
  }

  return segments.join('/');
}
