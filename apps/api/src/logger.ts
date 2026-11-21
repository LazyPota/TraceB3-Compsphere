import {
  pino,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions,
} from 'pino';
import type { AppConfig } from './config.js';

export type Logger = PinoLogger;

export const LOGGER_REDACT_PATHS: string[] = [
  'RELAYER_PRIVATE_KEY',
  'JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  '*.RELAYER_PRIVATE_KEY',
  '*.JWT_SECRET',
  '*.SUPABASE_SERVICE_ROLE_KEY',
  'req.headers.authorization',
  'req.headers.Authorization',
  'headers.authorization',
  'headers.Authorization',
  '*.authorization',
  '*.Authorization',
  '*.privateKey',
  '*.secret',
  '*.token',
];

export interface CreateLoggerOptions {
  level?: AppConfig['LOG_LEVEL'];
  name?: string;
  destination?: DestinationStream;
}

/**
 * Creates a structured pino logger with strict secret and credential redaction.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions: LoggerOptions = {
    name: options.name ?? 'traceb3-api',
    level: options.level ?? 'info',
    redact: {
      paths: LOGGER_REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}
