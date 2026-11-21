import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  CanonicalEventRecordV1Schema,
  ChainStatusSchema,
  CustodyIntentTypedDataJsonSchema,
  EventTypeSchema,
  ProblemDetailsSchema,
  QuantityInputSchema,
  ReasonCodeSchema,
} from '@traceb3/core';
import { eq } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import type { ChainClient } from '../chain/client.js';
import type { ChainRelayWorker, EventStatusUpdate } from '../chain/relayer.js';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { batches, custodyEvents } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  createRequireAuth,
  getAuthContext,
  requireRoles,
  type AuthContext,
  type AuthEnv,
} from '../middleware/auth.js';
import {
  createCustodyIntent,
  submitCustodyIntent,
} from '../services/intents.js';

const CreateIntentBodySchema = z.object({
  kind: EventTypeSchema,
  batchId: z.string().uuid().optional(),
  data: z.object({
    batchRef: z.string().min(1).max(64).optional(),
    wasteCode: z.string().min(1).max(64).optional(),
    wasteName: z.string().min(1).max(200).optional(),
    wasteCategory: z.string().max(100).optional(),
    festronikRef: z.string().max(100).optional(),
    monijaRef: z.string().max(100).optional(),
    quantity: QuantityInputSchema.optional(),
    targetSeq: z.number().int().positive().optional(),
    reasonCode: ReasonCodeSchema.optional(),
    notes: z.string().max(2000).optional(),
  }),
  evidenceIds: z.array(z.string().uuid()).default([]),
});

const CreateIntentResponseSchema = z.object({
  intentId: z.string().uuid(),
  batchId: z.string().uuid(),
  seq: z.number().int().positive(),
  eventHash: z.string(),
  typedData: CustodyIntentTypedDataJsonSchema,
  eventPreview: CanonicalEventRecordV1Schema,
  expiresAt: z.string(),
});

const SubmitIntentBodySchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'Invalid EIP-712 hex signature'),
});

const SubmitIntentResponseSchema = z.object({
  eventId: z.string().uuid(),
  batchId: z.string().uuid(),
  seq: z.number().int().positive(),
  status: ChainStatusSchema,
  eventHash: z.string(),
});

const EventStatusResponseSchema = z.object({
  eventId: z.string().uuid(),
  batchId: z.string().uuid(),
  seq: z.number().int().positive(),
  eventType: EventTypeSchema,
  chainStatus: ChainStatusSchema,
  txHash: z.string().nullable(),
  blockNumber: z.number().int().nullable(),
  anchoredAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  explorerUrl: z.string().nullable(),
});

const createIntentRoute = createRoute({
  method: 'post',
  path: '/v1/intents',
  tags: ['Custody'],
  summary: 'Prepare canonical event record and EIP-712 CustodyIntent for wallet signing',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateIntentBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Unsigned CustodyIntent typed data ready for wallet signature',
      content: { 'application/json': { schema: CreateIntentResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Forbidden role or organization',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Batch or evidence not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description: 'Batch busy (in-flight event) or invalid transition',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const submitIntentRoute = createRoute({
  method: 'post',
  path: '/v1/intents/{id}/submit',
  tags: ['Custody'],
  summary: 'Submit signed CustodyIntent to outbox and enqueue on-chain relay',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    headers: z.object({
      'idempotency-key': z.string().min(1),
    }),
    body: {
      required: true,
      content: { 'application/json': { schema: SubmitIntentBodySchema } },
    },
  },
  responses: {
    202: {
      description: 'Signed event accepted into outbox for asynchronous anchoring',
      content: { 'application/json': { schema: SubmitIntentResponseSchema } },
    },
    400: {
      description: 'Bad signature or missing Idempotency-Key',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Intent owned by different member',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Intent not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description: 'Batch busy or intent already submitted',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    410: {
      description: 'Intent expired',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const eventStatusRoute = createRoute({
  method: 'get',
  path: '/v1/events/{id}/status',
  tags: ['Custody'],
  summary: 'Inspect chain anchoring status for a submitted custody event',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Event chain status',
      content: { 'application/json': { schema: EventStatusResponseSchema } },
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
      description: 'Event not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const eventStreamRoute = createRoute({
  method: 'get',
  path: '/v1/events/{id}/stream',
  tags: ['Custody'],
  summary: 'Subscribe to Server-Sent Events (SSE) for real-time event chain anchoring updates',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'text/event-stream delivering status updates until ANCHORED or FAILED',
      content: {
        'text/event-stream': {
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
      description: 'Event not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

async function loadAuthorizedEvent(
  db: DatabaseClient,
  auth: AuthContext,
  eventId: string,
) {
  const rows = await db.db
    .select()
    .from(custodyEvents)
    .where(eq(custodyEvents.id, eventId))
    .limit(1);
  const event = rows[0];
  if (!event) {
    throw AppError.notFound(`Custody event ${eventId} not found`);
  }

  if (auth.role !== 'ADMIN' && auth.role !== 'AUDITOR') {
    const batchRows = await db.db
      .select()
      .from(batches)
      .where(eq(batches.id, event.batchId))
      .limit(1);
    const batch = batchRows[0];
    const batchEvents = await db.db
      .select({
        actorOrgId: custodyEvents.actorOrgId,
        fromOrgId: custodyEvents.fromOrgId,
        toOrgId: custodyEvents.toOrgId,
      })
      .from(custodyEvents)
      .where(eq(custodyEvents.batchId, event.batchId));

    const allowed =
      (batch &&
        (batch.generatorOrgId === auth.orgId ||
          batch.currentCustodianOrgId === auth.orgId)) ||
      batchEvents.some(
        (e) =>
          e.actorOrgId === auth.orgId ||
          e.fromOrgId === auth.orgId ||
          e.toOrgId === auth.orgId,
      );

    if (!allowed) {
      throw AppError.forbidden(
        'Member organization is not authorized to view this event status',
      );
    }
  }

  return event;
}

export function createIntentsRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  chain: ChainClient;
  relayer: ChainRelayWorker;
}) {
  const router = new OpenAPIHono<AuthEnv & { Variables: { requestId?: string } }>();
  const requireAuth = createRequireAuth(deps.config, deps.db);
  const requireCustodyActor = requireRoles('GENERATOR', 'TRANSPORTER', 'FACILITY');

  router.use('/v1/intents', requireAuth, requireCustodyActor);
  router.use('/v1/intents/*', requireAuth, requireCustodyActor);
  router.use('/v1/events/*', requireAuth);

  return router
    .openapi(createIntentRoute, async (c) => {
    const auth = getAuthContext(c);
    const body = c.req.valid('json');
    const created = await createCustodyIntent({
      db: deps.db,
      chain: deps.chain,
      auth,
      input: body,
    });
    return c.json(
      {
        ...created,
        typedData: {
          ...created.typedData,
          types: {
            CustodyIntent: [...created.typedData.types.CustodyIntent],
          },
        },
      },
      201,
    );
  })
    .openapi(submitIntentRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const headers = c.req.valid('header');
    const body = c.req.valid('json');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : undefined;

    const result = await submitCustodyIntent({
      db: deps.db,
      relayer: deps.relayer,
      auth,
      intentId: id,
      signature: body.signature,
      idempotencyKey: headers['idempotency-key'],
      requestId,
    });
    return c.json(result, 202);
  })
    .openapi(eventStatusRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const event = await loadAuthorizedEvent(deps.db, auth, id);

    return c.json(
      {
        eventId: event.id,
        batchId: event.batchId,
        seq: event.seq,
        eventType: event.eventType,
        chainStatus: event.chainStatus,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        anchoredAt: event.anchoredAt ? event.anchoredAt.toISOString() : null,
        failureReason: event.failureReason,
        explorerUrl: event.txHash
          ? deps.chain.getExplorerTxUrl(event.txHash)
          : null,
      },
      200,
    );
  })
    .openapi(eventStreamRoute, async (c) => {
    const auth = getAuthContext(c);
    const { id } = c.req.valid('param');
    const initial = await loadAuthorizedEvent(deps.db, auth, id);

    return streamSSE(c, async (stream) => {
      const formatPayload = (u: {
        eventId: string;
        batchId: string;
        seq: number;
        chainStatus: string;
        txHash: string | null;
        blockNumber: number | null;
        anchoredAt: string | null;
        failureReason: string | null;
      }) =>
        JSON.stringify({
          ...u,
          explorerUrl: u.txHash ? deps.chain.getExplorerTxUrl(u.txHash) : null,
        });

      await stream.writeSSE({
        event: 'status',
        data: formatPayload({
          eventId: initial.id,
          batchId: initial.batchId,
          seq: initial.seq,
          chainStatus: initial.chainStatus,
          txHash: initial.txHash,
          blockNumber: initial.blockNumber,
          anchoredAt: initial.anchoredAt
            ? initial.anchoredAt.toISOString()
            : null,
          failureReason: initial.failureReason,
        }),
      });

      if (
        initial.chainStatus === 'ANCHORED' ||
        initial.chainStatus === 'FAILED'
      ) {
        return;
      }

      let closed = false;
      let finishStream!: () => void;
      const donePromise = new Promise<void>((resolve) => {
        finishStream = resolve;
      });

      const unsubscribe = deps.relayer.onEventUpdate(
        initial.id,
        (update: EventStatusUpdate) => {
          if (closed) return;
          void stream
            .writeSSE({
              event: 'status',
              data: formatPayload(update),
            })
            .then(() => {
              if (
                update.chainStatus === 'ANCHORED' ||
                update.chainStatus === 'FAILED'
              ) {
                closed = true;
                finishStream();
              }
            })
            .catch(() => {
              closed = true;
              finishStream();
            });
        },
      );

      const pingTimer = setInterval(() => {
        if (!closed) {
          void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {
            closed = true;
            finishStream();
          });
        }
      }, 15_000);
      pingTimer.unref();

      let pollBusy = false;
      const dbPollTimer = setInterval(() => {
        if (closed || pollBusy) return;
        pollBusy = true;
        void loadAuthorizedEvent(deps.db, auth, id)
          .then(async (polled) => {
            if (
              closed ||
              (polled.chainStatus !== 'ANCHORED' &&
                polled.chainStatus !== 'FAILED')
            ) {
              return;
            }
            closed = true;
            await stream.writeSSE({
              event: 'status',
              data: formatPayload({
                eventId: polled.id,
                batchId: polled.batchId,
                seq: polled.seq,
                chainStatus: polled.chainStatus,
                txHash: polled.txHash,
                blockNumber: polled.blockNumber,
                anchoredAt: polled.anchoredAt
                  ? polled.anchoredAt.toISOString()
                  : null,
                failureReason: polled.failureReason,
              }),
            });
            finishStream();
          })
          .catch(() => {
            // Keep stream active until maxTimer or unsubscribe terminates it
          })
          .finally(() => {
            pollBusy = false;
          });
      }, 2_000);
      dbPollTimer.unref();

      const maxTimer = setTimeout(() => {
        closed = true;
        finishStream();
      }, 60_000);
      maxTimer.unref();

      stream.onAbort(() => {
        closed = true;
        finishStream();
      });

      try {
        // Re-check DB once after subscribing to prevent missing an anchor completed during subscription setup
        const latest = await loadAuthorizedEvent(deps.db, auth, id);
        if (
          latest.chainStatus === 'ANCHORED' ||
          latest.chainStatus === 'FAILED'
        ) {
          await stream.writeSSE({
            event: 'status',
            data: formatPayload({
              eventId: latest.id,
              batchId: latest.batchId,
              seq: latest.seq,
              chainStatus: latest.chainStatus,
              txHash: latest.txHash,
              blockNumber: latest.blockNumber,
              anchoredAt: latest.anchoredAt
                ? latest.anchoredAt.toISOString()
                : null,
              failureReason: latest.failureReason,
            }),
          });
          return;
        }

        await donePromise;
      } finally {
        clearInterval(pingTimer);
        clearInterval(dbPollTimer);
        clearTimeout(maxTimer);
        unsubscribe();
      }
    });
  });
}
