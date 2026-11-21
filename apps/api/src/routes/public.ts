import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  BatchStatusSchema,
  ChainStatusSchema,
  DiscrepancyReportSchema,
  DiscrepancySeveritySchema,
  evaluateDiscrepancies,
  EventTypeSchema,
  EventVerificationVerdictSchema,
  NormalizedQuantitySchema,
  OverallVerificationVerdictSchema,
  ProblemDetailsSchema,
  ProofBundleSchema,
  PublicViewLevelSchema,
  ReasonCodeSchema,
  type DiscrepancyEventInput,
} from '@traceb3/core';
import { asc, eq } from 'drizzle-orm';
import type { ChainClient } from '../chain/client.js';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import {
  auditLog,
  batches,
  custodyEvents,
  evidenceFiles,
  newId,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  buildPortableProofBundle,
  loadOrganizationNameMap,
  verifyBatchIntegrity,
} from '../services/verification.js';
import type { StorageAdapter } from '../storage/adapter.js';

const PublicPassportEventSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int().positive(),
  eventType: EventTypeSchema,
  actorOrgName: z.string().nullable(),
  fromOrgName: z.string().nullable(),
  toOrgName: z.string().nullable(),
  targetSeq: z.number().int().positive().nullable(),
  reasonCode: ReasonCodeSchema.nullable(),
  chainStatus: ChainStatusSchema,
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  anchoredAt: z.string().nullable(),
  eventHash: z.string(),
  quantity: NormalizedQuantitySchema.nullable().optional(),
  notes: z.string().nullable().optional(),
  evidenceCount: z.number().int().nonnegative(),
  evidence: z
    .array(
      z.object({
        id: z.string().uuid().nullable(),
        sha256: z.string(),
        mime: z.string(),
        size: z.number().int().nonnegative(),
        label: z.string(),
      }),
    )
    .optional(),
});

const PublicPassportResponseSchema = z.object({
  viewLevel: PublicViewLevelSchema,
  batchId: z.string().uuid(),
  publicId: z.string(),
  batchRef: z.string(),
  onChainBatchId: z.string(),
  wasteCode: z.string(),
  wasteName: z.string(),
  wasteCategory: z.string().nullable(),
  status: BatchStatusSchema,
  generatorOrgName: z.string().nullable(),
  currentCustodianOrgName: z.string().nullable(),
  hasDiscrepancy: z.boolean(),
  maxDiscrepancySeverity: DiscrepancySeveritySchema,
  declaredWeightGrams: z.string().nullable().optional(),
  festronikRef: z.string().nullable(),
  monijaRef: z.string().nullable(),
  events: z.array(PublicPassportEventSchema),
  discrepancies: DiscrepancyReportSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const VerificationResponseSchema = z.object({
  batchId: z.string().uuid(),
  publicId: z.string(),
  batchRef: z.string(),
  onChainBatchId: z.string(),
  verdict: OverallVerificationVerdictSchema,
  chainId: z.number().int().positive(),
  ledgerAddress: z.string().nullable(),
  onChainEventCount: z.number().int().nonnegative(),
  checkedAt: z.string(),
  affectedEvents: z.array(
    z.object({
      eventId: z.string().uuid(),
      seq: z.number().int().positive(),
      verdict: EventVerificationVerdictSchema,
      reason: z.string(),
    }),
  ),
  affectedFiles: z.array(
    z.object({
      evidenceId: z.string().uuid().nullable(),
      eventId: z.string().uuid(),
      seq: z.number().int().positive(),
      filename: z.string(),
      issue: z.enum(['FILE_MISSING', 'FILE_MISMATCH']),
      expectedSha256: z.string(),
      actualSha256: z.string().nullable(),
    }),
  ),
  missingOnChainSeqs: z.array(z.number().int().positive()),
  events: z.array(
    z.object({
      eventId: z.string().uuid(),
      seq: z.number().int().positive(),
      eventType: EventTypeSchema,
      chainStatus: z.string(),
      verdict: EventVerificationVerdictSchema,
      reasons: z.array(z.string()),
      recomputedHash: z.string(),
      storedHash: z.string(),
      onChainHash: z.string().nullable(),
      txHash: z.string().nullable(),
      explorerUrl: z.string().nullable(),
      anchoredAt: z.string().nullable(),
      filesChecked: z.number().int().nonnegative(),
    }),
  ),
});

const getPublicPassportRoute = createRoute({
  method: 'get',
  path: '/v1/public/passports/{publicId}',
  tags: ['Public'],
  summary: 'Retrieve public QR waste passport (redacted or full per PUBLIC_VIEW_LEVEL)',
  request: {
    params: z.object({
      publicId: z.string().min(1).openapi({ param: { name: 'publicId', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Public waste passport summary',
      content: { 'application/json': { schema: PublicPassportResponseSchema } },
    },
    404: {
      description: 'Passport not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const verifyPublicPassportRoute = createRoute({
  method: 'get',
  path: '/v1/public/passports/{publicId}/verify',
  tags: ['Public'],
  summary:
    'Cryptographically verify database records, EIP-712 signatures, hash-chain continuity, and stored evidence against TraceB3Ledger',
  request: {
    params: z.object({
      publicId: z.string().min(1).openapi({ param: { name: 'publicId', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Tamper-evident verification report',
      content: { 'application/json': { schema: VerificationResponseSchema } },
    },
    404: {
      description: 'Passport not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const proofBundleRoute = createRoute({
  method: 'get',
  path: '/v1/public/passports/{publicId}/proof-bundle',
  tags: ['Public'],
  summary: 'Export portable ProofBundle JSON verifiable offline with only an EVM RPC URL',
  request: {
    params: z.object({
      publicId: z.string().min(1).openapi({ param: { name: 'publicId', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Portable ProofBundle JSON',
      content: { 'application/json': { schema: ProofBundleSchema } },
    },
    404: {
      description: 'Passport not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

export function createPublicRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  storage: StorageAdapter;
  chain: ChainClient;
}) {
  const router = new OpenAPIHono<{ Variables: { requestId?: string } }>();

  return router
    .openapi(getPublicPassportRoute, async (c) => {
    const { publicId } = c.req.valid('param');
    const batchRows = await deps.db.db
      .select()
      .from(batches)
      .where(eq(batches.publicId, publicId))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      throw AppError.notFound(`Public passport ${publicId} not found`);
    }

    const [events, files, orgMap] = await Promise.all([
      deps.db.db
        .select()
        .from(custodyEvents)
        .where(eq(custodyEvents.batchId, batch.id))
        .orderBy(asc(custodyEvents.seq)),
      deps.db.db
        .select()
        .from(evidenceFiles)
        .where(eq(evidenceFiles.batchId, batch.id)),
      loadOrganizationNameMap(deps.db),
    ]);

    const activeEvents = events.filter((e) => e.chainStatus !== 'FAILED');
    const isFull = deps.config.PUBLIC_VIEW_LEVEL === 'full';

    let discrepancies: ReturnType<typeof evaluateDiscrepancies> | undefined;
    if (isFull) {
      const inputs: DiscrepancyEventInput[] = activeEvents.map((ev) => ({
        id: ev.id,
        seq: ev.seq,
        type: ev.eventType,
        quantity: ev.record.quantity,
        targetSeq: ev.targetSeq,
        reasonCode: ev.reasonCode,
        anchoredAt: ev.anchoredAt,
        chainStatus: ev.chainStatus,
      }));
      discrepancies = evaluateDiscrepancies(inputs, {
        weightTolerancePct: deps.config.WEIGHT_TOLERANCE_PCT,
        custodyGapHours: deps.config.CUSTODY_GAP_HOURS,
      });
    }

    return c.json(
      {
        viewLevel: deps.config.PUBLIC_VIEW_LEVEL,
        batchId: batch.id,
        publicId: batch.publicId,
        batchRef: batch.batchRef,
        onChainBatchId: batch.onChainBatchId,
        wasteCode: batch.wasteCode,
        wasteName: batch.wasteName,
        wasteCategory: batch.wasteCategory,
        status: batch.status,
        generatorOrgName: orgMap.get(batch.generatorOrgId)?.name ?? null,
        currentCustodianOrgName: batch.currentCustodianOrgId
          ? (orgMap.get(batch.currentCustodianOrgId)?.name ?? null)
          : null,
        hasDiscrepancy: batch.hasDiscrepancy,
        maxDiscrepancySeverity: batch.maxDiscrepancySeverity,
        ...(isFull ? { declaredWeightGrams: batch.declaredWeightGrams } : {}),
        festronikRef: batch.festronikRef,
        monijaRef: batch.monijaRef,
        events: activeEvents.map((ev) => ({
          id: ev.id,
          seq: ev.seq,
          eventType: ev.eventType,
          actorOrgName: orgMap.get(ev.actorOrgId)?.name ?? null,
          fromOrgName: ev.fromOrgId
            ? (orgMap.get(ev.fromOrgId)?.name ?? null)
            : null,
          toOrgName: ev.toOrgId
            ? (orgMap.get(ev.toOrgId)?.name ?? null)
            : null,
          targetSeq: ev.targetSeq,
          reasonCode: ev.reasonCode,
          chainStatus: ev.chainStatus,
          txHash: ev.txHash,
          explorerUrl: ev.txHash ? deps.chain.getExplorerTxUrl(ev.txHash) : null,
          anchoredAt: ev.anchoredAt ? ev.anchoredAt.toISOString() : null,
          eventHash: ev.eventHash,
          evidenceCount: ev.record.evidence.length,
          ...(isFull
            ? {
                quantity: ev.record.quantity,
                notes: ev.record.notes,
                evidence: ev.record.evidence.map((item) => {
                  const matched =
                    files.find(
                      (f) => f.eventId === ev.id && f.sha256 === item.sha256,
                    ) ?? files.find((f) => f.sha256 === item.sha256);
                  return {
                    id: matched?.id ?? null,
                    sha256: item.sha256,
                    mime: item.mime,
                    size: item.size,
                    label: item.label,
                  };
                }),
              }
            : {}),
        })),
        ...(isFull && discrepancies ? { discrepancies } : {}),
        createdAt: batch.createdAt.toISOString(),
        updatedAt: batch.updatedAt.toISOString(),
      },
      200,
    );
  })
    .openapi(verifyPublicPassportRoute, async (c) => {
    const { publicId } = c.req.valid('param');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const result = await verifyBatchIntegrity({
      db: deps.db,
      storage: deps.storage,
      chain: deps.chain,
      batchLookup: { publicId },
    });

    await deps.db.db.insert(auditLog).values({
      id: newId(),
      actorMemberId: null,
      actorWallet: null,
      actorRole: null,
      action: 'PUBLIC_VERIFY_PASSPORT',
      resourceType: 'batch',
      resourceId: result.batchId,
      metadata: {
        publicId,
        verdict: result.verdict,
        affectedEvents: result.affectedEvents.length,
        affectedFiles: result.affectedFiles.length,
      },
      requestId,
    });

    return c.json(result, 200);
  })
    .openapi(proofBundleRoute, async (c) => {
    const { publicId } = c.req.valid('param');
    const bundle = await buildPortableProofBundle({
      db: deps.db,
      chain: deps.chain,
      publicId,
    });
    return c.json(bundle, 200);
  });
}
