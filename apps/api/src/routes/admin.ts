import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  ActorRoleSchema,
  computeOnChainOrgId,
  EvmAddressSchema,
  MemberStatusSchema,
  ONCHAIN_ACTOR_ROLE_MAP,
  OrgTypeSchema,
  ProblemDetailsSchema,
  type ActorRole,
} from '@traceb3/core';
import { eq } from 'drizzle-orm';
import { getAddress } from 'viem';
import type { ChainRelayWorker } from '../chain/relayer.js';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { auditLog, members, newId, organizations } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  createRequireAuth,
  getAuthContext,
  requireRoles,
  type AuthEnv,
} from '../middleware/auth.js';

function isOperationalRole(
  role: ActorRole,
): role is 'GENERATOR' | 'TRANSPORTER' | 'FACILITY' {
  return role === 'GENERATOR' || role === 'TRANSPORTER' || role === 'FACILITY';
}

const CreateOrganizationBodySchema = z.object({
  name: z.string().trim().min(2).max(200),
  orgType: OrgTypeSchema,
  code: z.string().trim().min(2).max(64),
  estate: z.string().trim().max(200).optional(),
  klhkPermitNo: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
});

const OrganizationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  orgType: OrgTypeSchema,
  code: z.string(),
  onChainOrgId: z.string(),
  estate: z.string().nullable(),
  klhkPermitNo: z.string().nullable(),
  address: z.string().nullable(),
  createdAt: z.string(),
});

const CreateMemberBodySchema = z.object({
  orgId: z.string().uuid(),
  walletAddress: EvmAddressSchema,
  displayName: z.string().trim().min(2).max(160),
  role: ActorRoleSchema,
});

const UpdateMemberBodySchema = z
  .object({
    status: MemberStatusSchema.optional(),
    displayName: z.string().trim().min(2).max(160).optional(),
  })
  .refine(
    (data) => data.status !== undefined || data.displayName !== undefined,
    'At least one of status or displayName must be provided',
  );

const MemberResponseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  walletAddress: z.string(),
  displayName: z.string(),
  role: ActorRoleSchema,
  status: MemberStatusSchema,
  onChainTxHash: z.string().nullable(),
  onChainRegisteredAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

const createOrgRoute = createRoute({
  method: 'post',
  path: '/v1/admin/organizations',
  tags: ['Admin'],
  summary: 'Create a B2B organization in the TRACEB3 registry',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateOrganizationBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Organization created',
      content: { 'application/json': { schema: OrganizationResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description: 'Duplicate organization code',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const createMemberRoute = createRoute({
  method: 'post',
  path: '/v1/admin/members',
  tags: ['Admin'],
  summary: 'Register a member wallet and sync operational role on-chain',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateMemberBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Member registered',
      content: { 'application/json': { schema: MemberResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Organization not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description: 'Wallet already registered',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const updateMemberRoute = createRoute({
  method: 'patch',
  path: '/v1/admin/members/{id}',
  tags: ['Admin'],
  summary: 'Revoke or update a registered member wallet (with on-chain sync)',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateMemberBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Member updated',
      content: { 'application/json': { schema: MemberResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Member not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

export function createAdminRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  relayer: ChainRelayWorker;
}) {
  const router = new OpenAPIHono<AuthEnv & { Variables: { requestId?: string } }>();
  const requireAuth = createRequireAuth(deps.config, deps.db);
  const requireAdmin = requireRoles('ADMIN');

  router.use('/v1/admin/*', requireAuth, requireAdmin);

  router.openapi(createOrgRoute, async (c) => {
    const auth = getAuthContext(c);
    const body = c.req.valid('json');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const existing = await deps.db.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.code, body.code))
      .limit(1);
    if (existing[0]) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `Organization with code "${body.code}" already exists`,
      );
    }

    const id = newId();
    const onChainOrgId = computeOnChainOrgId(id);

    const inserted = await deps.db.db.transaction(async (tx) => {
      const rows = await tx
        .insert(organizations)
        .values({
          id,
          name: body.name,
          orgType: body.orgType,
          code: body.code,
          onChainOrgId,
          estate: body.estate ?? null,
          klhkPermitNo: body.klhkPermitNo ?? null,
          address: body.address ?? null,
        })
        .returning();

      await tx.insert(auditLog).values({
        id: newId(),
        actorMemberId: auth.memberId,
        actorWallet: auth.address,
        actorRole: auth.role,
        action: 'ADMIN_CREATE_ORGANIZATION',
        resourceType: 'organization',
        resourceId: id,
        metadata: { code: body.code, orgType: body.orgType, onChainOrgId },
        requestId,
      });

      return rows[0]!;
    });

    return c.json(
      {
        id: inserted.id,
        name: inserted.name,
        orgType: inserted.orgType,
        code: inserted.code,
        onChainOrgId: inserted.onChainOrgId,
        estate: inserted.estate,
        klhkPermitNo: inserted.klhkPermitNo,
        address: inserted.address,
        createdAt: inserted.createdAt.toISOString(),
      },
      201,
    );
  });

  router.openapi(createMemberRoute, async (c) => {
    const auth = getAuthContext(c);
    const body = c.req.valid('json');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const checksummed = getAddress(body.walletAddress);
    const normalizedWallet = checksummed.toLowerCase();

    const orgRows = await deps.db.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, body.orgId))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      throw AppError.notFound(`Organization ${body.orgId} not found`);
    }

    const dupRows = await deps.db.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.walletAddress, normalizedWallet))
      .limit(1);
    if (dupRows[0]) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `Wallet ${normalizedWallet} is already registered`,
      );
    }

    let onChainTxHash: string | null = null;
    let onChainRegisteredAt: Date | null = null;

    if (isOperationalRole(body.role)) {
      const reg = await deps.relayer.registerActorOnChain(
        checksummed,
        ONCHAIN_ACTOR_ROLE_MAP[body.role],
        org.onChainOrgId as `0x${string}`,
      );
      onChainTxHash = reg.txHash;
      onChainRegisteredAt = new Date();
    }

    const memberId = newId();
    const inserted = await deps.db.db.transaction(async (tx) => {
      const rows = await tx
        .insert(members)
        .values({
          id: memberId,
          orgId: org.id,
          walletAddress: normalizedWallet,
          displayName: body.displayName,
          role: body.role,
          status: 'ACTIVE',
          onChainTxHash,
          onChainRegisteredAt,
        })
        .returning();

      await tx.insert(auditLog).values({
        id: newId(),
        actorMemberId: auth.memberId,
        actorWallet: auth.address,
        actorRole: auth.role,
        action: 'ADMIN_REGISTER_MEMBER',
        resourceType: 'member',
        resourceId: memberId,
        metadata: {
          orgId: org.id,
          walletAddress: normalizedWallet,
          role: body.role,
          onChainTxHash,
        },
        requestId,
      });

      return rows[0]!;
    });

    return c.json(
      {
        id: inserted.id,
        orgId: inserted.orgId,
        walletAddress: inserted.walletAddress,
        displayName: inserted.displayName,
        role: inserted.role,
        status: inserted.status,
        onChainTxHash: inserted.onChainTxHash,
        onChainRegisteredAt: inserted.onChainRegisteredAt
          ? inserted.onChainRegisteredAt.toISOString()
          : null,
        revokedAt: inserted.revokedAt ? inserted.revokedAt.toISOString() : null,
        createdAt: inserted.createdAt.toISOString(),
      },
      201,
    );
  });

  router.openapi(updateMemberRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const existingRows = await deps.db.db
      .select({
        member: members,
        onChainOrgId: organizations.onChainOrgId,
      })
      .from(members)
      .innerJoin(organizations, eq(members.orgId, organizations.id))
      .where(eq(members.id, id))
      .limit(1);

    const found = existingRows[0];
    if (!found) {
      throw AppError.notFound(`Member ${id} not found`);
    }

    const { member, onChainOrgId } = found;
    let onChainTxHash = member.onChainTxHash;
    let onChainRegisteredAt = member.onChainRegisteredAt;
    let revokedAt = member.revokedAt;

    if (
      body.status &&
      body.status !== member.status &&
      isOperationalRole(member.role)
    ) {
      const checksummed = getAddress(member.walletAddress);
      if (body.status === 'REVOKED') {
        const rev = await deps.relayer.revokeActorOnChain(checksummed);
        onChainTxHash = rev.txHash;
        revokedAt = new Date();
      } else {
        const reg = await deps.relayer.registerActorOnChain(
          checksummed,
          ONCHAIN_ACTOR_ROLE_MAP[member.role],
          onChainOrgId as `0x${string}`,
        );
        onChainTxHash = reg.txHash;
        onChainRegisteredAt = new Date();
        revokedAt = null;
      }
    } else if (body.status === 'REVOKED') {
      revokedAt = new Date();
    } else if (body.status === 'ACTIVE') {
      revokedAt = null;
    }

    const updated = await deps.db.db.transaction(async (tx) => {
      const rows = await tx
        .update(members)
        .set({
          status: body.status ?? member.status,
          displayName: body.displayName ?? member.displayName,
          onChainTxHash,
          onChainRegisteredAt,
          revokedAt,
          updatedAt: new Date(),
        })
        .where(eq(members.id, id))
        .returning();

      await tx.insert(auditLog).values({
        id: newId(),
        actorMemberId: auth.memberId,
        actorWallet: auth.address,
        actorRole: auth.role,
        action:
          body.status === 'REVOKED'
            ? 'ADMIN_REVOKE_MEMBER'
            : 'ADMIN_UPDATE_MEMBER',
        resourceType: 'member',
        resourceId: id,
        metadata: {
          previousStatus: member.status,
          nextStatus: body.status ?? member.status,
          onChainTxHash,
        },
        requestId,
      });

      return rows[0]!;
    });

    return c.json(
      {
        id: updated.id,
        orgId: updated.orgId,
        walletAddress: updated.walletAddress,
        displayName: updated.displayName,
        role: updated.role,
        status: updated.status,
        onChainTxHash: updated.onChainTxHash,
        onChainRegisteredAt: updated.onChainRegisteredAt
          ? updated.onChainRegisteredAt.toISOString()
          : null,
        revokedAt: updated.revokedAt ? updated.revokedAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
      },
      200,
    );
  });

  return router;
}
