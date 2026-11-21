import type { AppConfig } from '../config.js';
import type { StorageAdapter } from './adapter.js';
import { LocalFsStorage } from './local-fs.js';
import { SupabaseStorage } from './supabase.js';

export {
  sanitizeStorageKey,
  type StorageAdapter,
  type StorageHealthCheckResult,
  type StoragePutOptions,
  type StoragePutResult,
} from './adapter.js';
export {
  LocalFsStorage,
  verifyLocalSignedToken,
  type LocalFsStorageOptions,
  type VerifiedLocalSignedToken,
} from './local-fs.js';
export { SupabaseStorage, type SupabaseStorageOptions } from './supabase.js';

/**
 * Instantiates the configured evidence storage adapter (local filesystem or Supabase).
 */
export function createStorageAdapter(config: AppConfig): StorageAdapter {
  if (config.STORAGE_DRIVER === 'supabase') {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORAGE_DRIVER=supabase',
      );
    }
    return new SupabaseStorage({
      supabaseUrl: config.SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
      bucket: config.SUPABASE_STORAGE_BUCKET,
    });
  }

  return new LocalFsStorage({
    baseDir: config.LOCAL_STORAGE_DIR,
    apiPublicUrl: config.API_PUBLIC_URL,
    signingSecret: config.JWT_SECRET,
  });
}
