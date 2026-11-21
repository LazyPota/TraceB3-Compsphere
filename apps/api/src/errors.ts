import type { ApiErrorCode, ProblemDetails } from '@traceb3/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface AppErrorOptions {
  status: ContentfulStatusCode;
  code: ApiErrorCode;
  title: string;
  detail: string;
  type?: string;
  errors?: Array<Record<string, unknown>>;
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * Application error mapped cleanly to RFC 9457 application/problem+json responses.
 */
export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly type: string;
  readonly errors?: Array<Record<string, unknown>>;
  readonly headers?: Record<string, string>;

  constructor(options: AppErrorOptions) {
    super(options.detail, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.type =
      options.type ??
      `https://traceb3.dev/errors/${options.code.toLowerCase().replace(/_/g, '-')}`;
    this.errors = options.errors;
    this.headers = options.headers;
  }

  static validation(
    detail: string,
    errors?: Array<Record<string, unknown>>,
  ): AppError {
    return new AppError({
      status: 400,
      code: 'VALIDATION_ERROR',
      title: 'Validation Error',
      detail,
      errors,
    });
  }

  static unauthenticated(detail = 'Authentication is required'): AppError {
    return new AppError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Unauthenticated',
      detail,
    });
  }

  static forbidden(detail = 'Insufficient role or organization permissions'): AppError {
    return new AppError({
      status: 403,
      code: 'FORBIDDEN_ROLE',
      title: 'Forbidden',
      detail,
    });
  }

  static notFound(detail = 'Resource not found'): AppError {
    return new AppError({
      status: 404,
      code: 'NOT_FOUND',
      title: 'Not Found',
      detail,
    });
  }

  static conflict(
    code: 'BATCH_BUSY' | 'INVALID_TRANSITION',
    detail: string,
  ): AppError {
    return new AppError({
      status: 409,
      code,
      title: code === 'BATCH_BUSY' ? 'Batch Busy' : 'Invalid Transition',
      detail,
    });
  }

  static internal(detail = 'An unexpected internal error occurred', cause?: unknown): AppError {
    return new AppError({
      status: 500,
      code: 'INTERNAL_ERROR',
      title: 'Internal Server Error',
      detail,
      cause,
    });
  }
}

/**
 * Serializes an AppError or ProblemDetails payload as RFC 9457 application/problem+json.
 */
export function problemResponse(
  c: Context,
  err: AppError | ProblemDetails,
  overrideStatus?: ContentfulStatusCode,
): Response {
  const status: ContentfulStatusCode =
    overrideStatus ?? (err instanceof AppError ? err.status : (err.status as ContentfulStatusCode));
  const requestId =
    typeof c.get('requestId') === 'string' ? (c.get('requestId') as string) : undefined;

  const body: ProblemDetails = {
    type: err.type,
    title: err.title,
    status,
    detail: err.detail,
    instance: c.req.path,
    code: err.code,
    ...(requestId ? { requestId } : {}),
    ...(err.errors && err.errors.length > 0 ? { errors: err.errors } : {}),
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json; charset=utf-8',
    ...(err instanceof AppError && err.headers ? err.headers : {}),
  };

  return c.newResponse(JSON.stringify(body), status, headers);
}
