import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  ActorRoleSchema,
  ONCHAIN_ACTOR_ROLE_MAP,
  OrgTypeSchema,
  ProblemDetailsSchema,
  type ActorRole,
} from '@traceb3/core';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { getAddress } from 'viem';
import type { ChainClient } from '../chain/client.js';
import type { ChainRelayWorker } from '../chain/relayer.js';
import type { DatabaseClient } from '../db/index.js';
import { auditLog, custodyEvents, evidenceFiles, newId } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  markMemberOnChainRegistered,
  seedDemoData,
} from '../services/seed.js';
import type { StorageAdapter } from '../storage/adapter.js';

const DevSeedBodySchema = z
  .object({
    wallets: z.record(ActorRoleSchema, z.string()).optional(),
  })
  .optional();

const DevSeedResponseSchema = z.object({
  createdOrganizations: z.number().int().nonnegative(),
  createdMembers: z.number().int().nonnegative(),
  onChainRegisteredCount: z.number().int().nonnegative(),
  organizations: z.array(
    z.object({
      id: z.string().uuid(),
      code: z.string(),
      name: z.string(),
      orgType: OrgTypeSchema,
      onChainOrgId: z.string(),
    }),
  ),
  members: z.array(
    z.object({
      id: z.string().uuid(),
      orgId: z.string().uuid(),
      orgCode: z.string(),
      onChainOrgId: z.string(),
      walletAddress: z.string(),
      displayName: z.string(),
      role: ActorRoleSchema,
      status: z.string(),
    }),
  ),
});

const DevTamperBodySchema = z.object({
  mode: z.enum(['db', 'file']),
  batchId: z.string().uuid(),
  eventSeq: z.number().int().positive().optional(),
  tamperedWeightGrams: z.string().regex(/^\d+$/).optional(),
  evidenceId: z.string().uuid().optional(),
});

const DevTamperResponseSchema = z.object({
  tampered: z.literal(true),
  mode: z.enum(['db', 'file']),
  batchId: z.string().uuid(),
  eventId: z.string().uuid().optional(),
  seq: z.number().int().positive().optional(),
  evidenceId: z.string().uuid().optional(),
  filename: z.string().optional(),
  detail: z.string(),
});

const devSeedRoute = createRoute({
  method: 'post',
  path: '/v1/dev/seed',
  tags: ['Demo'],
  summary:
    'DEMO_MODE only: idempotently seed Jababeka demo orgs/members and sync active roles on-chain',
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: DevSeedBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Seeded demo directory',
      content: { 'application/json': { schema: DevSeedResponseSchema } },
    },
  },
});

const devTamperRoute = createRoute({
  method: 'post',
  path: '/v1/dev/tamper',
  tags: ['Demo'],
  summary:
    'DEMO_MODE only: simulate off-chain DB or storage tampering to demonstrate tamper-evident detection',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: DevTamperBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Simulated tamper applied',
      content: { 'application/json': { schema: DevTamperResponseSchema } },
    },
    404: {
      description: 'Target event or evidence file not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const OPERATIONAL_ROLE_TO_UINT8: Partial<Record<ActorRole, 1 | 2 | 3>> = {
  GENERATOR: ONCHAIN_ACTOR_ROLE_MAP.GENERATOR,
  TRANSPORTER: ONCHAIN_ACTOR_ROLE_MAP.TRANSPORTER,
  FACILITY: ONCHAIN_ACTOR_ROLE_MAP.FACILITY,
};

export function createDevRouter(deps: {
  db: DatabaseClient;
  storage: StorageAdapter;
  chain: ChainClient;
  relayer: ChainRelayWorker;
}) {
  const router = new OpenAPIHono<{ Variables: { requestId?: string } }>();

  router.openapi(devSeedRoute, async (c) => {
    let body: { wallets?: Partial<Record<ActorRole, string>> } | undefined;
    try {
      const text = await c.req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text) as { wallets?: Partial<Record<ActorRole, string>> };
      }
    } catch {
      throw AppError.validation('Malformed JSON body');
    }

    const seeded = await seedDemoData(deps.db.db, {
      wallets: body?.wallets,
    });

    const requestedWalletRoles = body?.wallets
      ? Object.entries(body.wallets)
          .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
          .map(([role]) => role as ActorRole)
      : [];
    const requestedRoles =
      requestedWalletRoles.length > 0 ? new Set<ActorRole>(requestedWalletRoles) : null;

    let onChainRegisteredCount = 0;
    if (deps.chain.ledgerAddress && deps.chain.relayerAccount) {
      for (const member of seeded.members) {
        if (requestedRoles && !requestedRoles.has(member.role)) {
          continue;
        }
        const onChainRole = OPERATIONAL_ROLE_TO_UINT8[member.role];
        if (!onChainRole) {
          continue;
        }
        const info = await deps.chain.getActorInfo(
          getAddress(member.walletAddress),
        );
        if (
          info.active &&
          info.role === onChainRole &&
          info.orgId.toLowerCase() === member.onChainOrgId.toLowerCase()
        ) {
          continue;
        }

        const reg = await deps.relayer.registerActorOnChain(
          getAddress(member.walletAddress),
          onChainRole,
          member.onChainOrgId as `0x${string}`,
        );
        await markMemberOnChainRegistered(deps.db.db, member.id, reg.txHash);
        onChainRegisteredCount += 1;
      }
    }

    return c.json(
      {
        createdOrganizations: seeded.createdOrganizations,
        createdMembers: seeded.createdMembers,
        onChainRegisteredCount,
        organizations: seeded.organizations,
        members: seeded.members,
      },
      200,
    );
  });

  router.openapi(devTamperRoute, async (c) => {
    const body = c.req.valid('json');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    if (body.mode === 'db') {
      const targetSeq = body.eventSeq ?? 1;
      const rows = await deps.db.db
        .select()
        .from(custodyEvents)
        .where(
          and(
            eq(custodyEvents.batchId, body.batchId),
            eq(custodyEvents.seq, targetSeq),
            ne(custodyEvents.chainStatus, 'FAILED'),
          ),
        )
        .limit(1);

      const targetEvent = rows[0];
      if (!targetEvent) {
        throw AppError.notFound(
          `Custody event seq #${targetSeq} not found for batch ${body.batchId}`,
        );
      }

      const mutatedRecord = {
        ...targetEvent.record,
        quantity: targetEvent.record.quantity
          ? {
              ...targetEvent.record.quantity,
              grams: body.tamperedWeightGrams ?? '999999',
            }
          : {
              grams: body.tamperedWeightGrams ?? '999999',
              originalValue: '999.999',
              originalUnit: 'kg' as const,
            },
        notes: '[TAMPERED_DEMO_RECORD]',
      };

      // Simulate a compromised DBA temporarily bypassing the local trigger while leaving the chain anchor untouched.
      await deps.db.db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            'ALTER TABLE custody_events DISABLE TRIGGER trg_custody_events_append_only',
          ),
        );
        try {
          await tx
            .update(custodyEvents)
            .set({ record: mutatedRecord })
            .where(eq(custodyEvents.id, targetEvent.id));
        } finally {
          await tx.execute(
            sql.raw(
              'ALTER TABLE custody_events ENABLE TRIGGER trg_custody_events_append_only',
            ),
          );
        }

        await tx.insert(auditLog).values({
          id: newId(),
          actorMemberId: null,
          actorWallet: null,
          actorRole: null,
          action: 'DEV_TAMPER_DB',
          resourceType: 'custody_event',
          resourceId: targetEvent.id,
          metadata: {
            batchId: body.batchId,
            seq: targetEvent.seq,
            tamperedWeightGrams: mutatedRecord.quantity.grams,
          },
          requestId,
        });
      });

      return c.json(
        {
          tampered: true as const,
          mode: 'db' as const,
          batchId: body.batchId,
          eventId: targetEvent.id,
          seq: targetEvent.seq,
          detail: `Mutated canonical record JSON for event #${targetEvent.seq} in PostgreSQL without touching on-chain anchor`,
        },
        200,
      );
    }

    const fileRows = body.evidenceId
      ? await deps.db.db
          .select()
          .from(evidenceFiles)
          .where(eq(evidenceFiles.id, body.evidenceId))
          .limit(1)
      : await deps.db.db
          .select()
          .from(evidenceFiles)
          .where(eq(evidenceFiles.batchId, body.batchId))
          .orderBy(asc(evidenceFiles.createdAt))
          .limit(1);

    const targetFile = fileRows[0];
    if (!targetFile) {
      throw AppError.notFound(
        `No evidence file found to tamper for batch ${body.batchId}`,
      );
    }

    const tamperedPayload = Buffer.from(
      `%PDF-1.4\n%%TRACEB3_TAMPERED_DEMO_BLOB_${Date.now()}%%\n`,
      'utf8',
    );
    await deps.storage.put(
      targetFile.storageKey,
      tamperedPayload,
      targetFile.mimeType,
      { upsert: true },
    );

    await deps.db.db.insert(auditLog).values({
      id: newId(),
      actorMemberId: null,
      actorWallet: null,
      actorRole: null,
      action: 'DEV_TAMPER_FILE',
      resourceType: 'evidence_file',
      resourceId: targetFile.id,
      metadata: {
        batchId: body.batchId,
        storageKey: targetFile.storageKey,
        filename: targetFile.originalFilename,
      },
      requestId,
    });

    return c.json(
      {
        tampered: true as const,
        mode: 'file' as const,
        batchId: body.batchId,
        evidenceId: targetFile.id,
        filename: targetFile.originalFilename,
        detail: `Overwrote stored blob "${targetFile.originalFilename}" (${targetFile.id}) in ${deps.storage.driverName} storage`,
      },
      200,
    );
  });

  return router;
}
