import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  ActorRoleSchema,
  BatchStatusSchema,
  CanonicalEventRecordV1Schema,
  ChainStatusSchema,
  DiscrepancyReportSchema,
  DiscrepancySeveritySchema,
  evaluateDiscrepancies,
  EventTypeSchema,
  NormalizedQuantitySchema,
  ProblemDetailsSchema,
  ReasonCodeSchema,
  type DiscrepancyEventInput,
} from '@traceb3/core';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
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
  createRequireAuth,
  getAuthContext,
  requireRoles,
  type AuthContext,
  type AuthEnv,
} from '../middleware/auth.js';
import { loadOrganizationNameMap } from '../services/verification.js';

const OrgRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  orgType: z.string(),
});

const BatchSummarySchema = z.object({
  id: z.string().uuid(),
  publicId: z.string(),
  batchRef: z.string(),
  onChainBatchId: z.string(),
  wasteCode: z.string(),
  wasteName: z.string(),
  wasteCategory: z.string().nullable(),
  status: BatchStatusSchema,
  generatorOrgId: z.string().uuid(),
  generatorOrg: OrgRefSchema.nullable(),
  currentCustodianOrgId: z.string().uuid().nullable(),
  currentCustodianOrg: OrgRefSchema.nullable(),
  declaredWeightGrams: z.string().nullable(),
  latestEventSeq: z.number().int().nonnegative(),
  latestEventHash: z.string(),
  hasDiscrepancy: z.boolean(),
  maxDiscrepancySeverity: DiscrepancySeveritySchema,
  festronikRef: z.string().nullable(),
  monijaRef: z.string().nullable(),
  publicPassportUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const BatchListResponseSchema = z.object({
  items: z.array(BatchSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

const TimelineEventSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int().positive(),
  eventType: EventTypeSchema,
  actorWallet: z.string(),
  actorOrgId: z.string().uuid(),
  actorOrg: OrgRefSchema.nullable(),
  fromOrgId: z.string().uuid().nullable(),
  fromOrg: OrgRefSchema.nullable(),
  toOrgId: z.string().uuid().nullable(),
  toOrg: OrgRefSchema.nullable(),
  targetSeq: z.number().int().positive().nullable(),
  revisedBySeqs: z.array(z.number().int().positive()),
  reasonCode: ReasonCodeSchema.nullable(),
  quantity: NormalizedQuantitySchema.nullable(),
  evidence: z.array(
    z.object({
      id: z.string().uuid().nullable(),
      sha256: z.string(),
      mime: z.string(),
      size: z.number().int().nonnegative(),
      label: z.string(),
      filename: z.string().nullable(),
    }),
  ),
  eventHash: z.string(),
  prevEventHash: z.string(),
  chainStatus: ChainStatusSchema,
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  blockNumber: z.number().int().nullable(),
  anchoredAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  record: CanonicalEventRecordV1Schema,
  createdAt: z.string(),
});

const BatchTimelineResponseSchema = z.object({
  batchId: z.string().uuid(),
  publicId: z.string(),
  batchRef: z.string(),
  events: z.array(TimelineEventSchema),
});

const BatchDiscrepanciesResponseSchema = DiscrepancyReportSchema.extend({
  batchId: z.string().uuid(),
  batchRef: z.string(),
});

const AuditLogItemSchema = z.object({
  id: z.string().uuid(),
  actorMemberId: z.string().uuid().nullable(),
  actorWallet: z.string().nullable(),
  actorRole: ActorRoleSchema.nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});

const AuditLogListResponseSchema = z.object({
  items: z.array(AuditLogItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

const listBatchesRoute = createRoute({
  method: 'get',
  path: '/v1/batches',
  tags: ['Batches'],
  summary: 'List waste batches visible to the authenticated organization (or all for ADMIN/AUDITOR)',
  request: {
    query: z.object({
      status: BatchStatusSchema.optional(),
      org: z.string().uuid().optional(),
      has_discrepancy: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      description: 'Paginated batch list',
      content: { 'application/json': { schema: BatchListResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const getBatchRoute = createRoute({
  method: 'get',
  path: '/v1/batches/{id}',
  tags: ['Batches'],
  summary: 'Get details for a single waste batch',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Batch passport detail',
      content: { 'application/json': { schema: BatchSummarySchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden organization access',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Batch not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const getBatchTimelineRoute = createRoute({
  method: 'get',
  path: '/v1/batches/{id}/timeline',
  tags: ['Batches'],
  summary: 'Get chronological custody & revision timeline for a batch',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Ordered custody timeline',
      content: { 'application/json': { schema: BatchTimelineResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden organization access',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Batch not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const getBatchDiscrepanciesRoute = createRoute({
  method: 'get',
  path: '/v1/batches/{id}/discrepancies',
  tags: ['Batches'],
  summary: 'Compute weight, unit, revision, and custody-gap discrepancies for a batch',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Discrepancy report',
      content: { 'application/json': { schema: BatchDiscrepanciesResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden organization access',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Batch not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const getBatchQrRoute = createRoute({
  method: 'get',
  path: '/v1/batches/{id}/qr',
  tags: ['Batches'],
  summary: 'Generate QR code image (PNG or SVG) pointing to the public waste passport URL',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    query: z.object({
      format: z.enum(['png', 'svg']).default('png'),
    }),
  },
  responses: {
    200: {
      description: 'QR code image',
      content: {
        'image/png': {
          schema: z.string().openapi({ format: 'binary' }),
        },
        'image/svg+xml': {
          schema: z.string(),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden organization access',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Batch not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const listAuditLogsRoute = createRoute({
  method: 'get',
  path: '/v1/audit-logs',
  tags: ['Audit'],
  summary: 'Query compliance audit log entries (ADMIN & AUDITOR only)',
  request: {
    query: z.object({
      action: z.string().optional(),
      resourceType: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      description: 'Paginated audit log entries',
      content: { 'application/json': { schema: AuditLogListResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

async function assertBatchReadAccess(
  db: DatabaseClient,
  auth: AuthContext,
  batch: typeof batches.$inferSelect,
  requestId: string | null,
  actionName: string,
): Promise<void> {
  if (auth.role === 'ADMIN' || auth.role === 'AUDITOR') {
    if (auth.role === 'AUDITOR') {
      await db.db.insert(auditLog).values({
        id: newId(),
        actorMemberId: auth.memberId,
        actorWallet: auth.address,
        actorRole: auth.role,
        action: actionName,
        resourceType: 'batch',
        resourceId: batch.id,
        metadata: { batchRef: batch.batchRef },
        requestId,
      });
    }
    return;
  }

  if (
    batch.generatorOrgId === auth.orgId ||
    batch.currentCustodianOrgId === auth.orgId
  ) {
    return;
  }

  const participation = await db.db
    .select({ id: custodyEvents.id })
    .from(custodyEvents)
    .where(
      and(
        eq(custodyEvents.batchId, batch.id),
        or(
          eq(custodyEvents.actorOrgId, auth.orgId),
          eq(custodyEvents.fromOrgId, auth.orgId),
          eq(custodyEvents.toOrgId, auth.orgId),
        ),
      ),
    )
    .limit(1);

  if (participation.length === 0) {
    throw AppError.forbidden(
      'Member organization is not authorized to view this batch',
    );
  }
}

export function createBatchesRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  chain: ChainClient;
}) {
  const router = new OpenAPIHono<AuthEnv & { Variables: { requestId?: string } }>();
  const requireAuth = createRequireAuth(deps.config, deps.db);
  const publicBaseUrl = deps.config.PUBLIC_APP_URL.replace(/\/+$/, '');

  router.use('/v1/batches', requireAuth);
  router.use('/v1/batches/*', requireAuth);
  router.use('/v1/audit-logs', requireAuth, requireRoles('ADMIN', 'AUDITOR'));

  const toOrgRef = (
    orgMap: Map<string, { name: string; code: string; orgType: string }>,
    orgId: string | null,
  ) => {
    if (!orgId) return null;
    const found = orgMap.get(orgId);
    if (!found) return null;
    return { id: orgId, name: found.name, code: found.code, orgType: found.orgType };
  };

  const formatBatch = (
    row: typeof batches.$inferSelect,
    orgMap: Map<string, { name: string; code: string; orgType: string }>,
  ) => ({
    id: row.id,
    publicId: row.publicId,
    batchRef: row.batchRef,
    onChainBatchId: row.onChainBatchId,
    wasteCode: row.wasteCode,
    wasteName: row.wasteName,
    wasteCategory: row.wasteCategory,
    status: row.status,
    generatorOrgId: row.generatorOrgId,
    generatorOrg: toOrgRef(orgMap, row.generatorOrgId),
    currentCustodianOrgId: row.currentCustodianOrgId,
    currentCustodianOrg: toOrgRef(orgMap, row.currentCustodianOrgId),
    declaredWeightGrams: row.declaredWeightGrams,
    latestEventSeq: row.latestEventSeq,
    latestEventHash: row.latestEventHash,
    hasDiscrepancy: row.hasDiscrepancy,
    maxDiscrepancySeverity: row.maxDiscrepancySeverity,
    festronikRef: row.festronikRef,
    monijaRef: row.monijaRef,
    publicPassportUrl: `${publicBaseUrl}/p/${row.publicId}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  router.openapi(listBatchesRoute, async (c) => {
    const auth = getAuthContext(c);
    const query = c.req.valid('query');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const conditions = [];
    if (query.status) {
      conditions.push(eq(batches.status, query.status));
    }
    if (query.has_discrepancy !== undefined) {
      conditions.push(
        eq(batches.hasDiscrepancy, query.has_discrepancy === 'true'),
      );
    }

    const scopedOrgId =
      auth.role === 'ADMIN' || auth.role === 'AUDITOR'
        ? query.org
        : auth.orgId;

    if (scopedOrgId) {
      const eventParticipations = await deps.db.db
        .select({ batchId: custodyEvents.batchId })
        .from(custodyEvents)
        .where(
          or(
            eq(custodyEvents.actorOrgId, scopedOrgId),
            eq(custodyEvents.fromOrgId, scopedOrgId),
            eq(custodyEvents.toOrgId, scopedOrgId),
          ),
        );
      const participatedIds = [
        ...new Set(eventParticipations.map((r) => r.batchId)),
      ];
      conditions.push(
        participatedIds.length > 0
          ? or(
              eq(batches.generatorOrgId, scopedOrgId),
              eq(batches.currentCustodianOrgId, scopedOrgId),
              inArray(batches.id, participatedIds),
            )!
          : or(
              eq(batches.generatorOrgId, scopedOrgId),
              eq(batches.currentCustodianOrgId, scopedOrgId),
            )!,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows, orgMap] = await Promise.all([
      deps.db.db
        .select()
        .from(batches)
        .where(whereClause)
        .orderBy(desc(batches.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      deps.db.db
        .select({ count: sql<number>`count(*)::int` })
        .from(batches)
        .where(whereClause),
      loadOrganizationNameMap(deps.db),
    ]);

    if (auth.role === 'AUDITOR') {
      await deps.db.db.insert(auditLog).values({
        id: newId(),
        actorMemberId: auth.memberId,
        actorWallet: auth.address,
        actorRole: auth.role,
        action: 'AUDITOR_LIST_BATCHES',
        resourceType: 'batch',
        resourceId: null,
        metadata: {
          status: query.status ?? null,
          org: query.org ?? null,
          hasDiscrepancy: query.has_discrepancy ?? null,
        },
        requestId,
      });
    }

    return c.json(
      {
        items: rows.map((row) => formatBatch(row, orgMap)),
        total: Number(countRows[0]?.count ?? 0),
        limit: query.limit,
        offset: query.offset,
      },
      200,
    );
  });

  router.openapi(getBatchRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const batchRows = await deps.db.db
      .select()
      .from(batches)
      .where(eq(batches.id, id))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      throw AppError.notFound(`Batch ${id} not found`);
    }

    await assertBatchReadAccess(deps.db, auth, batch, requestId, 'AUDITOR_READ_BATCH');
    const orgMap = await loadOrganizationNameMap(deps.db);
    return c.json(formatBatch(batch, orgMap), 200);
  });

  router.openapi(getBatchTimelineRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const batchRows = await deps.db.db
      .select()
      .from(batches)
      .where(eq(batches.id, id))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      throw AppError.notFound(`Batch ${id} not found`);
    }

    await assertBatchReadAccess(
      deps.db,
      auth,
      batch,
      requestId,
      'AUDITOR_READ_TIMELINE',
    );

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

    const revisionsByTarget = new Map<number, number[]>();
    for (const ev of events) {
      if (
        ev.chainStatus !== 'FAILED' &&
        ev.eventType === 'REVISION' &&
        ev.targetSeq !== null
      ) {
        const list = revisionsByTarget.get(ev.targetSeq) ?? [];
        list.push(ev.seq);
        revisionsByTarget.set(ev.targetSeq, list);
      }
    }

    return c.json(
      {
        batchId: batch.id,
        publicId: batch.publicId,
        batchRef: batch.batchRef,
        events: events.map((ev) => ({
          id: ev.id,
          seq: ev.seq,
          eventType: ev.eventType,
          actorWallet: ev.actorWallet,
          actorOrgId: ev.actorOrgId,
          actorOrg: toOrgRef(orgMap, ev.actorOrgId),
          fromOrgId: ev.fromOrgId,
          fromOrg: toOrgRef(orgMap, ev.fromOrgId),
          toOrgId: ev.toOrgId,
          toOrg: toOrgRef(orgMap, ev.toOrgId),
          targetSeq: ev.targetSeq,
          revisedBySeqs: revisionsByTarget.get(ev.seq) ?? [],
          reasonCode: ev.reasonCode,
          quantity: ev.record.quantity,
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
              filename: matched?.originalFilename ?? null,
            };
          }),
          eventHash: ev.eventHash,
          prevEventHash: ev.prevEventHash,
          chainStatus: ev.chainStatus,
          txHash: ev.txHash,
          explorerUrl: ev.txHash ? deps.chain.getExplorerTxUrl(ev.txHash) : null,
          blockNumber: ev.blockNumber,
          anchoredAt: ev.anchoredAt ? ev.anchoredAt.toISOString() : null,
          failureReason: ev.failureReason,
          record: ev.record,
          createdAt: ev.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  router.openapi(getBatchDiscrepanciesRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const batchRows = await deps.db.db
      .select()
      .from(batches)
      .where(eq(batches.id, id))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      throw AppError.notFound(`Batch ${id} not found`);
    }

    await assertBatchReadAccess(
      deps.db,
      auth,
      batch,
      requestId,
      'AUDITOR_READ_DISCREPANCIES',
    );

    const events = await deps.db.db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.batchId, batch.id))
      .orderBy(asc(custodyEvents.seq));

    const inputs: DiscrepancyEventInput[] = events.map((ev) => ({
      id: ev.id,
      seq: ev.seq,
      type: ev.eventType,
      quantity: ev.record.quantity,
      targetSeq: ev.targetSeq,
      reasonCode: ev.reasonCode,
      anchoredAt: ev.anchoredAt,
      chainStatus: ev.chainStatus,
    }));

    const report = evaluateDiscrepancies(inputs, {
      weightTolerancePct: deps.config.WEIGHT_TOLERANCE_PCT,
      custodyGapHours: deps.config.CUSTODY_GAP_HOURS,
    });

    return c.json(
      {
        batchId: batch.id,
        batchRef: batch.batchRef,
        ...report,
      },
      200,
    );
  });

  router.openapi(getBatchQrRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const { format } = c.req.valid('query');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : null;

    const batchRows = await deps.db.db
      .select()
      .from(batches)
      .where(eq(batches.id, id))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      throw AppError.notFound(`Batch ${id} not found`);
    }

    await assertBatchReadAccess(deps.db, auth, batch, requestId, 'AUDITOR_READ_QR');

    const passportUrl = `${publicBaseUrl}/p/${batch.publicId}`;
    if (format === 'svg') {
      const svg = await QRCode.toString(passportUrl, {
        type: 'svg',
        margin: 2,
      });
      return new Response(svg, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'private, max-age=60',
        },
      });
    }

    const pngBuffer = await QRCode.toBuffer(passportUrl, {
      type: 'png',
      width: 320,
      margin: 2,
    });
    return new Response(new Uint8Array(pngBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=60',
      },
    });
  });

  router.openapi(listAuditLogsRoute, async (c) => {
    const query = c.req.valid('query');
    const conditions = [];
    if (query.action) {
      conditions.push(eq(auditLog.action, query.action));
    }
    if (query.resourceType) {
      conditions.push(eq(auditLog.resourceType, query.resourceType));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      deps.db.db
        .select()
        .from(auditLog)
        .where(whereClause)
        .orderBy(desc(auditLog.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      deps.db.db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(whereClause),
    ]);

    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          actorMemberId: r.actorMemberId,
          actorWallet: r.actorWallet,
          actorRole: r.actorRole,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          metadata: r.metadata,
          requestId: r.requestId,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(countRows[0]?.count ?? 0),
        limit: query.limit,
        offset: query.offset,
      },
      200,
    );
  });

  return router;
}
