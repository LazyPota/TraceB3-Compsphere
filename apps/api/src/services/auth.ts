import { createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { getAddress, type Hex } from 'viem';
import {
  generateSiweNonce,
  parseSiweMessage,
  validateSiweMessage,
  verifySiweMessage,
} from 'viem/siwe';
import type { ChainClient } from '../chain/client.js';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { auditLog, members, newId, organizations, siweNonces } from '../db/schema.js';
import { AppError } from '../errors.js';
import { getJwtSecretKey } from '../middleware/auth.js';

const SIWE_NONCE_TTL_MS = 5 * 60 * 1000;
const JWT_TTL_SECONDS = 3600;

export interface IssuedNonce {
  nonce: string;
  domain: string;
  chainId: number;
  expiresAt: string;
}

export interface VerifiedSession {
  token: string;
  expiresAt: string;
  member: {
    id: string;
    orgId: string;
    orgName: string;
    orgType: 'generator' | 'transporter' | 'facility' | 'regulator';
    onChainOrgId: string;
    walletAddress: string;
    displayName: string;
    role: 'GENERATOR' | 'TRANSPORTER' | 'FACILITY' | 'AUDITOR' | 'ADMIN';
  };
}

/**
 * Generates and stores a single-use SIWE nonce bound to domain + chainId (5-minute TTL).
 */
export async function issueSiweNonce(
  db: DatabaseClient,
  config: Pick<AppConfig, 'SIWE_DOMAIN' | 'CHAIN_ID'>,
): Promise<IssuedNonce> {
  const nonce = generateSiweNonce();
  const expiresAt = new Date(Date.now() + SIWE_NONCE_TTL_MS);

  await db.db.insert(siweNonces).values({
    id: newId(),
    nonce,
    expiresAt,
  });

  return {
    nonce,
    domain: config.SIWE_DOMAIN,
    chainId: config.CHAIN_ID,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verifies an EIP-4361 SIWE message + signature, consumes the nonce atomically,
 * verifies active B2B membership, and mints a short-lived HS256 JWT.
 */
export async function verifySiweAndMintJwt(
  db: DatabaseClient,
  chain: ChainClient,
  config: Pick<AppConfig, 'SIWE_DOMAIN' | 'CHAIN_ID' | 'JWT_SECRET'>,
  input: { message: string; signature: string; requestId?: string },
): Promise<VerifiedSession> {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(input.message);
  } catch (err) {
    throw AppError.validation(
      `Malformed EIP-4361 SIWE message: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed.address || !parsed.nonce || !parsed.domain || parsed.chainId === undefined) {
    throw AppError.validation(
      'SIWE message must include address, domain, chainId, and nonce',
    );
  }

  if (parsed.domain !== config.SIWE_DOMAIN) {
    throw AppError.unauthenticated(
      `SIWE domain mismatch: expected "${config.SIWE_DOMAIN}", received "${parsed.domain}"`,
    );
  }

  if (parsed.chainId !== config.CHAIN_ID) {
    throw AppError.unauthenticated(
      `SIWE chainId mismatch: expected ${config.CHAIN_ID}, received ${parsed.chainId}`,
    );
  }

  const now = new Date();
  const fieldsValid = validateSiweMessage({
    message: parsed,
    domain: config.SIWE_DOMAIN,
    nonce: parsed.nonce,
    time: now,
  });
  if (!fieldsValid) {
    throw AppError.unauthenticated('SIWE message validation failed (expired or invalid fields)');
  }

  const nonceRows = await db.db
    .select()
    .from(siweNonces)
    .where(eq(siweNonces.nonce, parsed.nonce))
    .limit(1);
  const nonceRow = nonceRows[0];
  if (!nonceRow) {
    throw AppError.unauthenticated('Unknown SIWE nonce');
  }
  if (nonceRow.usedAt !== null) {
    throw AppError.unauthenticated('SIWE nonce has already been consumed');
  }
  if (nonceRow.expiresAt.getTime() <= now.getTime()) {
    throw AppError.unauthenticated('SIWE nonce has expired');
  }

  let signatureValid = false;
  try {
    signatureValid = await verifySiweMessage(chain.publicClient, {
      message: input.message,
      signature: input.signature as Hex,
      domain: config.SIWE_DOMAIN,
      nonce: parsed.nonce,
      time: now,
    });
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    throw AppError.badSignature('SIWE signature verification failed');
  }

  const normalizedWallet = getAddress(parsed.address).toLowerCase();

  const consumed = await db.db
    .update(siweNonces)
    .set({
      usedAt: now,
      walletAddress: normalizedWallet,
    })
    .where(
      and(
        eq(siweNonces.id, nonceRow.id),
        isNull(siweNonces.usedAt),
        gt(siweNonces.expiresAt, now),
      ),
    )
    .returning({ id: siweNonces.id });

  if (consumed.length === 0) {
    throw AppError.unauthenticated('SIWE nonce has already been consumed or expired');
  }

  const memberRows = await db.db
    .select({
      id: members.id,
      orgId: members.orgId,
      walletAddress: members.walletAddress,
      displayName: members.displayName,
      role: members.role,
      status: members.status,
      orgName: organizations.name,
      orgType: organizations.orgType,
      onChainOrgId: organizations.onChainOrgId,
    })
    .from(members)
    .innerJoin(organizations, eq(members.orgId, organizations.id))
    .where(eq(members.walletAddress, normalizedWallet))
    .limit(1);

  const member = memberRows[0];
  if (!member) {
    throw AppError.forbidden(
      'Wallet address is not registered in the TRACEB3 B2B directory',
    );
  }
  if (member.status !== 'ACTIVE') {
    throw AppError.forbidden('Member account has been revoked');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + JWT_TTL_SECONDS;
  const secretKey = getJwtSecretKey(config);

  const token = await new SignJWT({
    address: member.walletAddress,
    memberId: member.id,
    orgId: member.orgId,
    role: member.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('traceb3-api')
    .setSubject(member.id)
    .setIssuedAt(nowSec)
    .setExpirationTime(expSec)
    .sign(secretKey);

  await db.db.insert(auditLog).values({
    id: newId(),
    actorMemberId: member.id,
    actorWallet: member.walletAddress,
    actorRole: member.role,
    action: 'AUTH_LOGIN_SIWE',
    resourceType: 'member',
    resourceId: member.id,
    metadata: {
      chainId: config.CHAIN_ID,
      domain: config.SIWE_DOMAIN,
      tokenDigest: createHash('sha256').update(token).digest('hex').slice(0, 16),
    },
    requestId: input.requestId ?? null,
  });

  return {
    token,
    expiresAt: new Date(expSec * 1000).toISOString(),
    member: {
      id: member.id,
      orgId: member.orgId,
      orgName: member.orgName,
      orgType: member.orgType,
      onChainOrgId: member.onChainOrgId,
      walletAddress: member.walletAddress,
      displayName: member.displayName,
      role: member.role,
    },
  };
}
