import { createHash } from 'node:crypto';
import {
  buildCanonicalEventRecord,
  buildCustodyIntentTypedData,
  computeEventHash,
  computeOnChainBatchId,
  deserializeTypedData,
  generateSalt,
  normalizeWeightToGrams,
  serializeTypedData,
  UnitNormalizationError,
  validateCustodyTransition,
  ZERO_BYTES32,
  type CanonicalEventRecordV1,
  type CustodyIntentTypedDataJson,
  type EventType,
  type NormalizedQuantity,
  type ReasonCode,
} from '@traceb3/core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getAddress, verifyTypedData, type Hex } from 'viem';
import type { ChainClient } from '../chain/client.js';
import type { ChainRelayWorker } from '../chain/relayer.js';
import type { DatabaseClient } from '../db/index.js';
import {
  auditLog,
  batches,
  chainJobs,
  custodyEvents,
  evidenceFiles,
  idempotencyRecords,
  intents,
  newId,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import type { AuthContext } from '../middleware/auth.js';

const INTENT_TTL_SECONDS = 600;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateIntentInput {
  kind: EventType;
  batchId?: string;
  data: {
    batchRef?: string;
    wasteCode?: string;
    wasteName?: string;
    wasteCategory?: string;
    festronikRef?: string;
    monijaRef?: string;
    quantity?: { value: string | number; unit: 'kg' | 'g' | 'ton' };
    targetSeq?: number;
    reasonCode?: ReasonCode;
    notes?: string;
  };
  evidenceIds: string[];
}

export interface CreatedIntentResult {
  intentId: string;
  batchId: string;
  seq: number;
  eventHash: string;
  typedData: CustodyIntentTypedDataJson;
  eventPreview: CanonicalEventRecordV1;
  expiresAt: string;
}

export interface SubmitIntentResult {
  eventId: string;
  batchId: string;
  seq: number;
  status: 'PENDING' | 'SUBMITTED' | 'ANCHORED' | 'FAILED';
  eventHash: string;
}

function makeBatchRef(): string {
  const year = new Date().getUTCFullYear();
  const suffix = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  return `TB3-${year}-${suffix}`;
}

/**
 * Validates role/state transitions, normalizes quantities, builds canonical JSON + EIP-712 typedData,
 * and persists an open CustodyIntent for client wallet signing.
 */
export async function createCustodyIntent(params: {
  db: DatabaseClient;
  chain: ChainClient;
  auth: AuthContext;
  input: CreateIntentInput;
}): Promise<CreatedIntentResult> {
  const { db, chain, auth, input } = params;

  let ledgerAddress: `0x${string}`;
  try {
    ledgerAddress = chain.requireLedgerAddress();
  } catch (err) {
    throw AppError.chainUnavailable(
      err instanceof Error ? err.message : 'Ledger contract address not configured',
    );
  }

  let batchId: string;
  let seq: number;
  let wasteCode: string;
  let wasteName: string | null = null;
  let batchRef: string | null = null;
  let prevEventHash: `0x${string}`;
  let fromOrgId: string | null;
  let toOrgId: string | null;
  let targetSeq: number | null = null;
  let reasonCode: ReasonCode | null = null;

  if (input.kind === 'CREATED') {
    if (input.batchId) {
      const existing = await db.db
        .select({ id: batches.id })
        .from(batches)
        .where(eq(batches.id, input.batchId))
        .limit(1);
      if (existing[0]) {
        throw AppError.conflict(
          'INVALID_TRANSITION',
          `Batch ${input.batchId} already exists`,
        );
      }
      batchId = input.batchId;
    } else {
      batchId = newId();
    }

    const transition = validateCustodyTransition({
      eventType: 'CREATED',
      actorRole: auth.role,
      actorOrgId: auth.orgId,
      currentStatus: null,
      currentCustodianOrgId: null,
    });
    if (!transition.ok) {
      if (transition.code === 'FORBIDDEN_ROLE') {
        throw AppError.forbidden(transition.message);
      }
      throw AppError.conflict(transition.code, transition.message);
    }

    if (!input.data.wasteCode || !input.data.wasteName || !input.data.quantity) {
      throw AppError.validation(
        'CREATED intents require data.wasteCode, data.wasteName, and data.quantity',
      );
    }

    seq = 1;
    wasteCode = input.data.wasteCode.trim();
    wasteName = input.data.wasteName.trim();
    batchRef = input.data.batchRef?.trim() || makeBatchRef();
    prevEventHash = ZERO_BYTES32;
    fromOrgId = transition.fromOrgId;
    toOrgId = transition.toOrgId;
  } else {
    if (!input.batchId) {
      throw AppError.validation(`batchId is required for ${input.kind} intents`);
    }
    batchId = input.batchId;

    const batchRows = await db.db
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      throw AppError.notFound(`Batch ${batchId} not found`);
    }

    const inFlightRows = await db.db
      .select({ id: custodyEvents.id })
      .from(custodyEvents)
      .where(
        and(
          eq(custodyEvents.batchId, batchId),
          inArray(custodyEvents.chainStatus, ['PENDING', 'SUBMITTED']),
        ),
      )
      .limit(1);

    if (inFlightRows[0] || batch.status === 'PENDING_CHAIN') {
      throw AppError.conflict(
        'BATCH_BUSY',
        'Batch already has an unconfirmed custody event in flight',
      );
    }

    const batchEvents = await db.db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.batchId, batchId))
      .orderBy(asc(custodyEvents.seq));

    const activeEvents = batchEvents.filter((e) => e.chainStatus !== 'FAILED');
    const lastAnchored = [...activeEvents]
      .reverse()
      .find((e) => e.chainStatus === 'ANCHORED');

    if (!lastAnchored) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        'Batch has no anchored custody events yet',
      );
    }

    let targetEventForMachine:
      | { seq: number; type: EventType; actorOrgId: string }
      | undefined;

    if (input.kind === 'REVISION') {
      if (!input.data.targetSeq || !input.data.reasonCode || !input.data.quantity) {
        throw AppError.validation(
          'REVISION intents require data.targetSeq, data.reasonCode, and data.quantity',
        );
      }
      const targetRow = activeEvents.find(
        (e) => e.seq === input.data.targetSeq && e.chainStatus === 'ANCHORED',
      );
      if (!targetRow) {
        throw AppError.conflict(
          'INVALID_TRANSITION',
          `Anchored target event sequence #${input.data.targetSeq} not found`,
        );
      }
      targetSeq = targetRow.seq;
      reasonCode = input.data.reasonCode;
      targetEventForMachine = {
        seq: targetRow.seq,
        type: targetRow.eventType,
        actorOrgId: targetRow.actorOrgId,
      };
    } else if (input.kind === 'CUSTODY_TRANSFERRED' && !input.data.quantity) {
      throw AppError.validation(
        'CUSTODY_TRANSFERRED intents require data.quantity',
      );
    }

    const transition = validateCustodyTransition({
      eventType: input.kind,
      actorRole: auth.role,
      actorOrgId: auth.orgId,
      currentStatus: batch.status,
      currentCustodianOrgId: batch.currentCustodianOrgId,
      targetEvent: targetEventForMachine,
    });
    if (!transition.ok) {
      if (transition.code === 'FORBIDDEN_ROLE') {
        throw AppError.forbidden(transition.message);
      }
      throw AppError.conflict(transition.code, transition.message);
    }

    seq = lastAnchored.seq + 1;
    wasteCode = batch.wasteCode;
    prevEventHash = lastAnchored.eventHash as `0x${string}`;
    fromOrgId = transition.fromOrgId;
    toOrgId = transition.toOrgId;
  }

  let normalizedQuantity: NormalizedQuantity | null = null;
  if (input.data.quantity) {
    try {
      normalizedQuantity = normalizeWeightToGrams(
        input.data.quantity.value,
        input.data.quantity.unit,
      );
    } catch (err) {
      if (err instanceof UnitNormalizationError) {
        throw AppError.validation(err.message);
      }
      throw err;
    }
  }

  const uniqueEvidenceIds = [...new Set(input.evidenceIds)];
  const canonicalEvidence: Array<{
    sha256: string;
    mime: string;
    size: number;
    label: string;
  }> = [];

  if (uniqueEvidenceIds.length > 0) {
    const rows = await db.db
      .select()
      .from(evidenceFiles)
      .where(inArray(evidenceFiles.id, uniqueEvidenceIds));

    if (rows.length !== uniqueEvidenceIds.length) {
      throw AppError.notFound('One or more referenced evidenceIds were not found');
    }

    for (const row of rows) {
      if (row.uploadedByOrgId !== auth.orgId) {
        throw AppError.forbidden(
          `Evidence file ${row.id} belongs to another organization`,
        );
      }
      if (row.eventId !== null) {
        throw AppError.conflict(
          'INVALID_TRANSITION',
          `Evidence file ${row.id} is already attached to event ${row.eventId}`,
        );
      }
      if (row.batchId !== null && row.batchId !== batchId) {
        throw AppError.validation(
          `Evidence file ${row.id} belongs to a different batch`,
        );
      }
      canonicalEvidence.push({
        sha256: row.sha256,
        mime: row.mimeType,
        size: row.sizeBytes,
        label: row.label,
      });
    }
  }

  let nonce: bigint;
  try {
    nonce = await chain.getActorNonce(getAddress(auth.address));
  } catch (err) {
    throw AppError.chainUnavailable(
      `Failed to read actor nonce from TraceB3Ledger: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + INTENT_TTL_SECONDS);
  const expiresAt = new Date(Number(deadlineSec) * 1000);

  const record = buildCanonicalEventRecord({
    batchId,
    seq,
    type: input.kind,
    actorWallet: auth.address,
    actorOrgId: auth.orgId,
    fromOrgId,
    toOrgId,
    wasteCode,
    quantity: normalizedQuantity,
    evidence: canonicalEvidence,
    targetSeq,
    reasonCode,
    notes: input.data.notes ?? null,
    prevEventHash,
    salt: generateSalt(),
  });

  const eventHash = computeEventHash(record);
  const onChainBatchId = computeOnChainBatchId(batchId);
  const typedData = buildCustodyIntentTypedData({
    chainId: chain.chainId,
    verifyingContract: ledgerAddress,
    batchId: onChainBatchId,
    eventType: input.kind,
    eventHash,
    prevHash: prevEventHash,
    targetSeq: targetSeq ?? 0,
    actor: getAddress(auth.address),
    nonce,
    deadline: deadlineSec,
  });
  const typedDataJson = serializeTypedData(typedData);
  const intentId = newId();

  await db.db.insert(intents).values({
    id: intentId,
    batchId,
    seq,
    eventType: input.kind,
    actorMemberId: auth.memberId,
    actorOrgId: auth.orgId,
    actorWallet: auth.address.toLowerCase(),
    wasteCode,
    wasteName,
    batchRef,
    batchMeta:
      input.kind === 'CREATED'
        ? {
            wasteCategory: input.data.wasteCategory ?? null,
            festronikRef: input.data.festronikRef ?? null,
            monijaRef: input.data.monijaRef ?? null,
          }
        : null,
    record,
    typedData: typedDataJson,
    eventHash,
    prevEventHash,
    nonce: nonce.toString(10),
    deadline: deadlineSec.toString(10),
    evidenceIds: uniqueEvidenceIds,
    status: 'OPEN',
    expiresAt,
  });

  return {
    intentId,
    batchId,
    seq,
    eventHash,
    typedData: typedDataJson,
    eventPreview: record,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verifies the client EIP-712 signature, enforces idempotency + 1-in-flight-per-batch,
 * atomically persists custody_events (PENDING) + chain_jobs outbox, and triggers the relayer.
 */
export async function submitCustodyIntent(params: {
  db: DatabaseClient;
  relayer: ChainRelayWorker;
  auth: AuthContext;
  intentId: string;
  signature: string;
  idempotencyKey: string;
  requestId?: string;
}): Promise<SubmitIntentResult> {
  const { db, relayer, auth, intentId, signature, idempotencyKey, requestId } =
    params;

  const trimmedKey = idempotencyKey.trim();
  if (!trimmedKey) {
    throw AppError.validation('Idempotency-Key header is required and must be non-empty');
  }

  const scope = `submit-intent:${auth.memberId}:${intentId}`;
  const requestHash = createHash('sha256')
    .update(`${intentId}:${signature.toLowerCase()}`)
    .digest('hex');

  const priorIdem = await db.db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, trimmedKey),
      ),
    )
    .limit(1);

  if (priorIdem[0]) {
    if (priorIdem[0].requestHash !== requestHash) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        'Idempotency-Key was already used with a different signature payload',
      );
    }
    return priorIdem[0].responseBody as unknown as SubmitIntentResult;
  }

  const intentRows = await db.db
    .select()
    .from(intents)
    .where(eq(intents.id, intentId))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) {
    throw AppError.notFound(`Intent ${intentId} not found`);
  }

  if (intent.actorMemberId !== auth.memberId) {
    throw AppError.forbidden('Intent belongs to a different member');
  }

  if (intent.status !== 'OPEN') {
    throw AppError.conflict(
      'INVALID_TRANSITION',
      `Intent ${intentId} is already ${intent.status}`,
    );
  }

  if (intent.expiresAt.getTime() <= Date.now()) {
    await db.db
      .update(intents)
      .set({ status: 'EXPIRED' })
      .where(and(eq(intents.id, intent.id), eq(intents.status, 'OPEN')));
    throw AppError.intentExpired();
  }

  const typedData = deserializeTypedData(intent.typedData);
  let validSig = false;
  try {
    validSig = await verifyTypedData({
      address: getAddress(intent.actorWallet),
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: signature as Hex,
    });
  } catch {
    validSig = false;
  }

  if (!validSig) {
    throw AppError.badSignature(
      'EIP-712 CustodyIntent signature failed verification for authenticated actor',
    );
  }

  const eventId = newId();
  const resultPayload: SubmitIntentResult = {
    eventId,
    batchId: intent.batchId,
    seq: intent.seq,
    status: 'PENDING',
    eventHash: intent.eventHash,
  };

  await db.db.transaction(async (tx) => {
    const lockedIntent = await tx
      .update(intents)
      .set({
        status: 'SUBMITTED',
        submittedAt: new Date(),
      })
      .where(and(eq(intents.id, intent.id), eq(intents.status, 'OPEN')))
      .returning();

    if (lockedIntent.length === 0) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `Intent ${intent.id} was already submitted`,
      );
    }

    if (intent.eventType === 'CREATED') {
      const existingBatch = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(eq(batches.id, intent.batchId))
        .limit(1);
      if (existingBatch[0]) {
        throw AppError.conflict(
          'INVALID_TRANSITION',
          `Batch ${intent.batchId} already exists`,
        );
      }

      await tx.insert(batches).values({
        id: intent.batchId,
        publicId: nanoid(16),
        batchRef: intent.batchRef ?? makeBatchRef(),
        onChainBatchId: computeOnChainBatchId(intent.batchId),
        wasteCode: intent.wasteCode,
        wasteName: intent.wasteName ?? intent.wasteCode,
        wasteCategory: intent.batchMeta?.wasteCategory ?? null,
        status: 'PENDING_CHAIN',
        generatorOrgId: intent.actorOrgId,
        currentCustodianOrgId: intent.actorOrgId,
        declaredWeightGrams: intent.record.quantity?.grams ?? null,
        latestEventSeq: 0,
        latestEventHash: ZERO_BYTES32,
        festronikRef: intent.batchMeta?.festronikRef ?? null,
        monijaRef: intent.batchMeta?.monijaRef ?? null,
      });
    } else {
      const inFlight = await tx
        .select({ id: custodyEvents.id })
        .from(custodyEvents)
        .where(
          and(
            eq(custodyEvents.batchId, intent.batchId),
            inArray(custodyEvents.chainStatus, ['PENDING', 'SUBMITTED']),
          ),
        )
        .limit(1);
      if (inFlight[0]) {
        throw AppError.conflict(
          'BATCH_BUSY',
          'Batch already has an unconfirmed custody event in flight',
        );
      }
    }

    await tx.insert(custodyEvents).values({
      id: eventId,
      batchId: intent.batchId,
      intentId: intent.id,
      seq: intent.seq,
      eventType: intent.eventType,
      actorMemberId: auth.memberId,
      actorWallet: intent.actorWallet,
      actorOrgId: intent.actorOrgId,
      fromOrgId: intent.record.fromOrgId,
      toOrgId: intent.record.toOrgId,
      targetSeq: intent.record.targetSeq,
      reasonCode: intent.record.reasonCode,
      quantityGrams: intent.record.quantity?.grams ?? null,
      quantityUnit: intent.record.quantity?.originalUnit ?? null,
      record: intent.record,
      eventHash: intent.eventHash,
      prevEventHash: intent.prevEventHash,
      signature,
      nonce: intent.nonce,
      deadline: intent.deadline,
      chainStatus: 'PENDING',
    });

    if (intent.evidenceIds.length > 0) {
      await tx
        .update(evidenceFiles)
        .set({
          batchId: intent.batchId,
          eventId,
        })
        .where(
          and(
            inArray(evidenceFiles.id, intent.evidenceIds),
            isNull(evidenceFiles.eventId),
          ),
        );
    }

    await tx.insert(chainJobs).values({
      id: newId(),
      jobType: 'ANCHOR_EVENT',
      batchId: intent.batchId,
      eventId,
      payload: {
        eventId,
        batchId: intent.batchId,
        seq: intent.seq,
        eventType: intent.eventType,
      },
      status: 'PENDING',
      nextRunAt: new Date(),
    });

    await tx.insert(idempotencyRecords).values({
      id: newId(),
      idempotencyKey: trimmedKey,
      scope,
      actorMemberId: auth.memberId,
      requestHash,
      responseStatus: 202,
      responseBody: resultPayload as unknown as Record<string, unknown>,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });

    await tx.insert(auditLog).values({
      id: newId(),
      actorMemberId: auth.memberId,
      actorWallet: auth.address,
      actorRole: auth.role,
      action: 'SUBMIT_CUSTODY_INTENT',
      resourceType: 'custody_event',
      resourceId: eventId,
      metadata: {
        intentId: intent.id,
        batchId: intent.batchId,
        seq: intent.seq,
        eventType: intent.eventType,
        eventHash: intent.eventHash,
      },
      requestId: requestId ?? null,
    });
  });

  void relayer.triggerDrain();

  return resultPayload;
}
