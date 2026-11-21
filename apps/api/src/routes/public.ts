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
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
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

const PublicPassportSummarySchema = z.object({
  batchId: z.string().uuid(),
  publicId: z.string(),
  batchRef: z.string(),
  wasteCode: z.string(),
  wasteName: z.string(),
  status: BatchStatusSchema,
  generatorOrgName: z.string().nullable(),
  currentCustodianOrgName: z.string().nullable(),
  hasDiscrepancy: z.boolean(),
  maxDiscrepancySeverity: DiscrepancySeveritySchema,
  latestEventSeq: z.number().int().nonnegative(),
  latestEventHash: z.string(),
  hasRevisions: z.boolean(),
  declaredWeightGrams: z.string().nullable(),
  effectiveWeights: z.object({
    declaredGrams: z.string().nullable(),
    pickupGrams: z.string().nullable(),
    deliveryGrams: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const PublicPassportListResponseSchema = z.object({
  viewLevel: PublicViewLevelSchema,
  items: z.array(PublicPassportSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

const PublicLookupResponseSchema = z.object({
  publicId: z.string(),
  batchId: z.string().uuid(),
  batchRef: z.string(),
  matchedBy: z.enum([
    'publicId',
    'batchRef',
    'batchId',
    'txHash',
    'eventHash',
    'onChainBatchId',
  ]),
});

const listPublicPassportsRoute = createRoute({
  method: 'get',
  path: '/v1/public/passports',
  tags: ['Public'],
  summary: 'List recent public waste passports (redacted or full per PUBLIC_VIEW_LEVEL)',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      offset: z.coerce.number().int().min(0).default(0),
      flagged: z.enum(['true', 'false']).optional(),
      status: BatchStatusSchema.optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated list of public waste passports',
      content: { 'application/json': { schema: PublicPassportListResponseSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const lookupPublicPassportRoute = createRoute({
  method: 'get',
  path: '/v1/public/lookup',
  tags: ['Public'],
  summary: 'Resolve a publicId, batchRef, batch UUID, txHash, eventHash, or onChainBatchId to a public passport',
  request: {
    query: z.object({
      q: z.string().trim().min(1).max(128),
    }),
  },
  responses: {
    200: {
      description: 'Resolved public passport reference',
      content: { 'application/json': { schema: PublicLookupResponseSchema } },
    },
    404: {
      description: 'No matching passport found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
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
    .openapi(listPublicPassportsRoute, async (c) => {
      const query = c.req.valid('query');
      const conditions: SQL[] = [];
      if (query.flagged === 'true') {
        conditions.push(eq(batches.hasDiscrepancy, true));
      } else if (query.flagged === 'false') {
        conditions.push(eq(batches.hasDiscrepancy, false));
      }
      if (query.status) {
        conditions.push(eq(batches.status, query.status));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countRows, orgMap] = await Promise.all([
        deps.db.db
          .select()
          .from(batches)
          .where(whereClause)
          .orderBy(desc(batches.updatedAt))
          .limit(query.limit)
          .offset(query.offset),
        deps.db.db
          .select({ count: sql<number>`count(*)::int` })
          .from(batches)
          .where(whereClause),
        loadOrganizationNameMap(deps.db),
      ]);

      const pageIds = rows.map((b) => b.id);
      const eventRows =
        pageIds.length > 0
          ? await deps.db.db
              .select()
              .from(custodyEvents)
              .where(inArray(custodyEvents.batchId, pageIds))
              .orderBy(asc(custodyEvents.seq))
          : [];

      const eventsByBatch = new Map<string, typeof eventRows>();
      for (const ev of eventRows) {
        if (ev.chainStatus === 'FAILED') continue;
        const list = eventsByBatch.get(ev.batchId) ?? [];
        list.push(ev);
        eventsByBatch.set(ev.batchId, list);
      }

      const isFull = deps.config.PUBLIC_VIEW_LEVEL === 'full';
      const items = rows.map((batch) => {
        const activeEvents = eventsByBatch.get(batch.id) ?? [];
        const hasRevisions = activeEvents.some((ev) => ev.eventType === 'REVISION');

        let effectiveWeights = {
          declaredGrams: null as string | null,
          pickupGrams: null as string | null,
          deliveryGrams: null as string | null,
        };
        if (isFull && activeEvents.length > 0) {
          const report = evaluateDiscrepancies(
            activeEvents.map((ev) => ({
              id: ev.id,
              seq: ev.seq,
              type: ev.eventType,
              quantity: ev.record.quantity,
              targetSeq: ev.targetSeq,
              reasonCode: ev.reasonCode,
              anchoredAt: ev.anchoredAt,
              chainStatus: ev.chainStatus,
            })),
            {
              weightTolerancePct: deps.config.WEIGHT_TOLERANCE_PCT,
              custodyGapHours: deps.config.CUSTODY_GAP_HOURS,
            },
          );
          effectiveWeights = report.effectiveWeights;
        }

        return {
          batchId: batch.id,
          publicId: batch.publicId,
          batchRef: batch.batchRef,
          wasteCode: batch.wasteCode,
          wasteName: batch.wasteName,
          status: batch.status,
          generatorOrgName: orgMap.get(batch.generatorOrgId)?.name ?? null,
          currentCustodianOrgName: batch.currentCustodianOrgId
            ? (orgMap.get(batch.currentCustodianOrgId)?.name ?? null)
            : null,
          hasDiscrepancy: batch.hasDiscrepancy,
          maxDiscrepancySeverity: batch.maxDiscrepancySeverity,
          latestEventSeq: batch.latestEventSeq,
          latestEventHash: batch.latestEventHash,
          hasRevisions,
          declaredWeightGrams: isFull ? batch.declaredWeightGrams : null,
          effectiveWeights,
          createdAt: batch.createdAt.toISOString(),
          updatedAt: batch.updatedAt.toISOString(),
        };
      });

      return c.json(
        {
          viewLevel: deps.config.PUBLIC_VIEW_LEVEL,
          items,
          total: countRows[0]?.count ?? items.length,
          limit: query.limit,
          offset: query.offset,
        },
        200,
      );
    })
    .openapi(lookupPublicPassportRoute, async (c) => {
      const { q } = c.req.valid('query');
      const normalized = q.trim();
      const lower = normalized.toLowerCase();

      const byPublicId = (
        await deps.db.db
          .select()
          .from(batches)
          .where(eq(batches.publicId, normalized))
          .limit(1)
      )[0];
      if (byPublicId) {
        return c.json(
          {
            publicId: byPublicId.publicId,
            batchId: byPublicId.id,
            batchRef: byPublicId.batchRef,
            matchedBy: 'publicId' as const,
          },
          200,
        );
      }

      const byBatchRef = (
        await deps.db.db
          .select()
          .from(batches)
          .where(sql`lower(${batches.batchRef}) = ${lower}`)
          .limit(1)
      )[0];
      if (byBatchRef) {
        return c.json(
          {
            publicId: byBatchRef.publicId,
            batchId: byBatchRef.id,
            batchRef: byBatchRef.batchRef,
            matchedBy: 'batchRef' as const,
          },
          200,
        );
      }

      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
        const byUuid = (
          await deps.db.db
            .select()
            .from(batches)
            .where(eq(batches.id, lower))
            .limit(1)
        )[0];
        if (byUuid) {
          return c.json(
            {
              publicId: byUuid.publicId,
              batchId: byUuid.id,
              batchRef: byUuid.batchRef,
              matchedBy: 'batchId' as const,
            },
            200,
          );
        }
      }

      if (/^0x[0-9a-f]{64}$/i.test(normalized)) {
        const txMatch = (
          await deps.db.db
            .select({
              publicId: batches.publicId,
              batchId: batches.id,
              batchRef: batches.batchRef,
            })
            .from(custodyEvents)
            .innerJoin(batches, eq(custodyEvents.batchId, batches.id))
            .where(sql`lower(${custodyEvents.txHash}) = ${lower}`)
            .limit(1)
        )[0];
        if (txMatch) {
          return c.json({ ...txMatch, matchedBy: 'txHash' as const }, 200);
        }

        const hashMatch = (
          await deps.db.db
            .select({
              publicId: batches.publicId,
              batchId: batches.id,
              batchRef: batches.batchRef,
            })
            .from(custodyEvents)
            .innerJoin(batches, eq(custodyEvents.batchId, batches.id))
            .where(sql`lower(${custodyEvents.eventHash}) = ${lower}`)
            .limit(1)
        )[0];
        if (hashMatch) {
          return c.json({ ...hashMatch, matchedBy: 'eventHash' as const }, 200);
        }

        const onChainMatch = (
          await deps.db.db
            .select()
            .from(batches)
            .where(sql`lower(${batches.onChainBatchId}) = ${lower}`)
            .limit(1)
        )[0];
        if (onChainMatch) {
          return c.json(
            {
              publicId: onChainMatch.publicId,
              batchId: onChainMatch.id,
              batchRef: onChainMatch.batchRef,
              matchedBy: 'onChainBatchId' as const,
            },
            200,
          );
        }
      }

      throw AppError.notFound(`No passport found matching "${normalized}"`);
    })
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
