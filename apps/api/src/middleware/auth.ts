import type { ActorRole, OrgType } from '@traceb3/core';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { members, organizations } from '../db/schema.js';
import { AppError } from '../errors.js';

export interface AuthContext {
  address: `0x${string}`;
  memberId: string;
  orgId: string;
  orgName: string;
  orgType: OrgType;
  onChainOrgId: string;
  role: ActorRole;
  displayName: string;
}

export interface AuthEnv {
  Variables: {
    auth?: AuthContext;
  };
}

export function getJwtSecretKey(config: Pick<AppConfig, 'JWT_SECRET'>): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

/**
 * Middleware validating the Bearer JWT and verifying the member remains ACTIVE in PostgreSQL.
 */
export function createRequireAuth(
  config: Pick<AppConfig, 'JWT_SECRET'>,
  db: DatabaseClient,
): MiddlewareHandler {
  const secretKey = getJwtSecretKey(config);

  return async (c, next) => {
    const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw AppError.unauthenticated('Missing or malformed Bearer authorization header');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw AppError.unauthenticated('Empty Bearer token');
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, secretKey, {
        algorithms: ['HS256'],
        issuer: 'traceb3-api',
      });
      payload = verified.payload as Record<string, unknown>;
    } catch {
      throw AppError.unauthenticated('Invalid or expired access token');
    }

    if (
      typeof payload.memberId !== 'string' ||
      typeof payload.address !== 'string' ||
      typeof payload.orgId !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      throw AppError.unauthenticated('Invalid access token claims');
    }

    const rows = await db.db
      .select({
        memberId: members.id,
        walletAddress: members.walletAddress,
        orgId: members.orgId,
        role: members.role,
        status: members.status,
        displayName: members.displayName,
        orgName: organizations.name,
        orgType: organizations.orgType,
        onChainOrgId: organizations.onChainOrgId,
      })
      .from(members)
      .innerJoin(organizations, eq(members.orgId, organizations.id))
      .where(eq(members.id, payload.memberId))
      .limit(1);

    const record = rows[0];
    if (!record) {
      throw AppError.unauthenticated('Authenticated member record no longer exists');
    }
    if (record.status !== 'ACTIVE') {
      throw AppError.forbidden('Member account has been revoked');
    }

    c.set('auth', {
      address: record.walletAddress as `0x${string}`,
      memberId: record.memberId,
      orgId: record.orgId,
      orgName: record.orgName,
      orgType: record.orgType,
      onChainOrgId: record.onChainOrgId,
      role: record.role,
      displayName: record.displayName,
    });

    await next();
  };
}

/**
 * Middleware requiring one of the specified TRACEB3 actor roles.
 */
export function requireRoles(...allowedRoles: readonly ActorRole[]): MiddlewareHandler {
  const allowed = new Set<ActorRole>(allowedRoles);
  return async (c, next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth) {
      throw AppError.unauthenticated();
    }
    if (!allowed.has(auth.role)) {
      throw AppError.forbidden(
        `Role ${auth.role} is not permitted to access this resource`,
      );
    }
    await next();
  };
}

/**
 * Helper retrieving the authenticated member context after requireAuth middleware.
 */
export function getAuthContext(c: { get: (key: 'auth') => unknown }): AuthContext {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) {
    throw AppError.unauthenticated();
  }
  return auth;
}
