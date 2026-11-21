import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors.js';

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window rate limiter returning RFC 9457 429 RATE_LIMITED responses.
 */
export function createRateLimiter(
  options: RateLimiterOptions,
): MiddlewareHandler {
  const buckets = new Map<string, BucketEntry>();
  const prefix = options.keyPrefix ?? 'rl';

  return async (c, next) => {
    const forwardedFor = c.req.header('x-forwarded-for');
    const clientIp =
      forwardedFor?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip')?.trim() ||
      'local';
    const key = `${prefix}:${clientIp}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        count: 0,
        resetAt: now + options.windowMs,
      };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.maxRequests - bucket.count);
    c.header('X-RateLimit-Limit', String(options.maxRequests));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw AppError.rateLimited(
        `Rate limit exceeded (${options.maxRequests} requests per ${Math.round(options.windowMs / 1000)}s)`,
        retryAfterSec,
      );
    }

    await next();
  };
}
