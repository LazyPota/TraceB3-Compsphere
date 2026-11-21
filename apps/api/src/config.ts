import { PublicViewLevelSchema, type PublicViewLevel } from '@traceb3/core';
import { z } from 'zod';

const DEV_JWT_SECRET_FALLBACK = 'traceb3-dev-jwt-secret-change-me-0001';

function emptyToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}

function parseEnvBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') {
        return defaultValue;
      }
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
      }
    }
    return value;
  }, z.boolean());
}

const RawConfigSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(65535).default(3001),
  ),
  HOST: z.preprocess(emptyToUndefined, z.string().min(1).default('0.0.0.0')),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  ),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('pglite://.data/pglite')
      .refine(
        (val) =>
          val.startsWith('pglite://') ||
          val.startsWith('postgres://') ||
          val.startsWith('postgresql://'),
        'DATABASE_URL must start with pglite://, postgres://, or postgresql://',
      ),
  ),
  STORAGE_DRIVER: z.preprocess(
    emptyToUndefined,
    z.enum(['local', 'supabase']).default('local'),
  ),
  LOCAL_STORAGE_DIR: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default('.data/storage'),
  ),
  SUPABASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  SUPABASE_STORAGE_BUCKET: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default('traceb3-evidence'),
  ),
  CHAIN_RPC_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('http://127.0.0.1:8545'),
  ),
  CHAIN_ID: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(31337),
  ),
  LEDGER_ADDRESS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'LEDGER_ADDRESS must be a valid EVM address')
      .optional(),
  ),
  RELAYER_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^(0x)?[0-9a-fA-F]{64}$/,
        'RELAYER_PRIVATE_KEY must be a 32-byte hex private key',
      )
      .optional(),
  ),
  JWT_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .min(16, 'JWT_SECRET must be at least 16 characters')
      .optional(),
  ),
  SIWE_DOMAIN: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default('localhost:3001'),
  ),
  FRONTEND_ORIGINS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('http://localhost:3000,http://localhost:3001')
      .transform((raw) =>
        raw
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
  ),
  PUBLIC_APP_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('http://localhost:3000'),
  ),
  API_PUBLIC_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('http://localhost:3001'),
  ),
  WEIGHT_TOLERANCE_PCT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().min(0).max(100).default(2),
  ),
  CUSTODY_GAP_HOURS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().default(24),
  ),
  PUBLIC_VIEW_LEVEL: z.preprocess(
    emptyToUndefined,
    PublicViewLevelSchema.default('redacted'),
  ),
  DEMO_MODE: parseEnvBoolean(false),
  MAX_UPLOAD_MB: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().max(100).default(10),
  ),
});

export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  HOST: string;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  DATABASE_URL: string;
  STORAGE_DRIVER: 'local' | 'supabase';
  LOCAL_STORAGE_DIR: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_STORAGE_BUCKET: string;
  CHAIN_RPC_URL: string;
  CHAIN_ID: number;
  LEDGER_ADDRESS?: string;
  RELAYER_PRIVATE_KEY?: string;
  JWT_SECRET: string;
  SIWE_DOMAIN: string;
  FRONTEND_ORIGINS: string[];
  PUBLIC_APP_URL: string;
  API_PUBLIC_URL: string;
  WEIGHT_TOLERANCE_PCT: number;
  CUSTODY_GAP_HOURS: number;
  PUBLIC_VIEW_LEVEL: PublicViewLevel;
  DEMO_MODE: boolean;
  MAX_UPLOAD_MB: number;
}

const ConfigSchema = RawConfigSchema.superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && !data.JWT_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_SECRET'],
      message: 'JWT_SECRET is required in production (>= 16 characters)',
    });
  }

  if (data.STORAGE_DRIVER === 'supabase') {
    if (!data.SUPABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_URL'],
        message: 'SUPABASE_URL is required when STORAGE_DRIVER=supabase',
      });
    }
    if (!data.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_SERVICE_ROLE_KEY'],
        message:
          'SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_DRIVER=supabase',
      });
    }
  }
}).transform((data): AppConfig => ({
  ...data,
  JWT_SECRET: data.JWT_SECRET ?? DEV_JWT_SECRET_FALLBACK,
}));

/**
 * Parses and validates TRACEB3 API runtime configuration from environment variables.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return ConfigSchema.parse(env);
}
