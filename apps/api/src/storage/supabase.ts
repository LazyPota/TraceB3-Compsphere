import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  sanitizeStorageKey,
  type StorageAdapter,
  type StorageHealthCheckResult,
  type StoragePutOptions,
  type StoragePutResult,
} from './adapter.js';

export interface SupabaseStorageOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  bucket: string;
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function isNotFoundStorageError(error: {
  message?: string;
  status?: number;
  statusCode?: string;
  code?: string;
}): boolean {
  return (
    error.status === 404 ||
    error.statusCode === '404' ||
    error.code === 'NoSuchKey'
  );
}

/**
 * Supabase Storage adapter targeting a private bucket via service-role credentials.
 */
export class SupabaseStorage implements StorageAdapter {
  readonly driverName = 'supabase' as const;
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(options: SupabaseStorageOptions) {
    this.bucket = options.bucket;
    this.client = createClient(options.supabaseUrl, options.serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async put(
    storagePath: string,
    data: Buffer | Uint8Array | Readable,
    contentType: string,
    options?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const key = sanitizeStorageKey(storagePath);
    const body = data instanceof Readable ? await readableToBuffer(data) : Buffer.from(data);

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(key, body, {
        contentType,
        upsert: options?.upsert ?? false,
        cacheControl: options?.cacheControl,
      });

    if (error) {
      throw new Error(`Supabase storage upload failed: ${error.message}`);
    }

    return { key, sizeBytes: body.byteLength };
  }

  async getStream(storagePath: string): Promise<Readable | null> {
    const key = sanitizeStorageKey(storagePath);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(key);

    if (error) {
      if (isNotFoundStorageError(error)) {
        return null;
      }
      throw new Error(`Supabase storage download failed: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return Readable.fromWeb(data.stream() as unknown as NodeWebReadableStream);
  }

  async exists(storagePath: string): Promise<boolean> {
    const key = sanitizeStorageKey(storagePath);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .exists(key);

    if (data === false) {
      return false;
    }

    if (error) {
      throw new Error(`Supabase storage exists check failed: ${error.message}`);
    }

    return Boolean(data);
  }

  async getSignedDownloadUrl(
    storagePath: string,
    filename: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const key = sanitizeStorageKey(storagePath);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, Math.max(1, Math.trunc(expiresInSeconds)), {
        download: filename,
      });

    if (error || !data?.signedUrl) {
      throw new Error(
        `Supabase signed URL generation failed: ${error?.message ?? 'missing signedUrl'}`,
      );
    }

    return data.signedUrl;
  }

  async healthCheck(): Promise<StorageHealthCheckResult> {
    try {
      const { data, error } = await this.client.storage.getBucket(this.bucket);
      if (error) {
        return {
          ok: false,
          driver: 'supabase',
          detail: error.message,
        };
      }
      if (data.public) {
        return {
          ok: true,
          driver: 'supabase',
          detail: 'Warning: storage bucket is marked public; expected private bucket',
        };
      }
      return { ok: true, driver: 'supabase' };
    } catch (err) {
      return {
        ok: false,
        driver: 'supabase',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
