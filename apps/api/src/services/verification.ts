import { createHash } from 'node:crypto';
import {
  buildCustodyIntentTypedData,
  computeEventHash,
  computeOnChainBatchId,
  ProofBundleSchema,
  ZERO_BYTES32,
  type EventType,
  type EventVerificationVerdict,
  type OverallVerificationVerdict,
  type ProofBundle,
} from '@traceb3/core';
import { asc, eq } from 'drizzle-orm';
import { getAddress, verifyTypedData, type Hex } from 'viem';
import type { ChainClient, OnChainAnchoredEvent } from '../chain/client.js';
import type { DatabaseClient } from '../db/index.js';
import {
  batches,
  custodyEvents,
  evidenceFiles,
  organizations,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import type { StorageAdapter } from '../storage/adapter.js';

export interface AffectedFileIssue {
  evidenceId: string | null;
  eventId: string;
  seq: number;
  filename: string;
  issue: 'FILE_MISSING' | 'FILE_MISMATCH';
  expectedSha256: string;
  actualSha256: string | null;
}

export interface AffectedEventIssue {
  eventId: string;
  seq: number;
  verdict: Exclude<EventVerificationVerdict, 'MATCH' | 'NOT_YET_ANCHORED'>;
  reason: string;
}

export interface EventVerificationDetail {
  eventId: string;
  seq: number;
  eventType: EventType;
  chainStatus: string;
  verdict: EventVerificationVerdict;
  reasons: string[];
  recomputedHash: string;
  storedHash: string;
  onChainHash: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  anchoredAt: string | null;
  filesChecked: number;
}

export interface BatchVerificationResult {
  batchId: string;
  publicId: string;
  batchRef: string;
  onChainBatchId: string;
  verdict: OverallVerificationVerdict;
  chainId: number;
  ledgerAddress: string | null;
  onChainEventCount: number;
  checkedAt: string;
  affectedEvents: AffectedEventIssue[];
  affectedFiles: AffectedFileIssue[];
  missingOnChainSeqs: number[];
  events: EventVerificationDetail[];
}

const VERDICT_PRIORITY: EventVerificationVerdict[] = [
  'HASH_MISMATCH',
  'CHAIN_LINK_BROKEN',
  'FILE_MISSING',
  'FILE_MISMATCH',
  'SIGNATURE_INVALID',
  'NOT_YET_ANCHORED',
  'MATCH',
];

function pickHighestPriorityVerdict(
  detected: ReadonlySet<EventVerificationVerdict>,
): EventVerificationVerdict {
  for (const verdict of VERDICT_PRIORITY) {
    if (detected.has(verdict)) {
      return verdict;
    }
  }
  return 'MATCH';
}

function safeComputeEventHash(record: unknown): string {
  try {
    return computeEventHash(record as Parameters<typeof computeEventHash>[0]);
  } catch {
    return '0x' + '0'.repeat(64);
  }
}

async function hashStorageStream(
  storage: StorageAdapter,
  storageKey: string,
): Promise<string | null> {
  const stream = await storage.getStream(storageKey);
  if (!stream) {
    return null;
  }
  const hasher = createHash('sha256');
  for await (const chunk of stream) {
    hasher.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return hasher.digest('hex').toLowerCase();
}

/**
 * Performs full end-to-end cryptographic integrity verification of a waste batch:
 * 1. RFC 8785 re-canonicalization & SHA-256 comparison against TraceB3Ledger.
 * 2. Hash-chain prevEventHash & sequence continuity check.
 * 3. EIP-712 CustodyIntent signature verification against actor wallet.
 * 4. Storage streaming re-hash of every referenced evidence blob.
 * 5. Detection of missing anchored rows deleted from PostgreSQL.
 */
export async function verifyBatchIntegrity(params: {
  db: DatabaseClient;
  storage: StorageAdapter;
  chain: ChainClient;
  batchLookup: { id?: string; publicId?: string };
}): Promise<BatchVerificationResult> {
  const { db, storage, chain, batchLookup } = params;

  const batchRows = batchLookup.id
    ? await db.db
        .select()
        .from(batches)
        .where(eq(batches.id, batchLookup.id))
        .limit(1)
    : batchLookup.publicId
      ? await db.db
          .select()
          .from(batches)
          .where(eq(batches.publicId, batchLookup.publicId))
          .limit(1)
      : [];

  const batch = batchRows[0];
  if (!batch) {
    throw AppError.notFound('Waste batch passport not found');
  }

  let ledgerAddress: `0x${string}`;
  try {
    ledgerAddress = chain.requireLedgerAddress();
  } catch (err) {
    throw AppError.chainUnavailable(
      err instanceof Error ? err.message : 'Ledger address not configured',
    );
  }

  const allEvents = await db.db
    .select()
    .from(custodyEvents)
    .where(eq(custodyEvents.batchId, batch.id))
    .orderBy(asc(custodyEvents.seq));

  const allEvidence = await db.db
    .select()
    .from(evidenceFiles)
    .where(eq(evidenceFiles.batchId, batch.id));

  let batchHeader: Awaited<ReturnType<ChainClient['getBatchHeader']>>;
  try {
    batchHeader = await chain.getBatchHeader(batch.onChainBatchId as `0x${string}`);
  } catch (err) {
    throw AppError.chainUnavailable(
      `Failed to query TraceB3Ledger state: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const nonFailedEvents = allEvents.filter((e) => e.chainStatus !== 'FAILED');
  const affectedEvents: AffectedEventIssue[] = [];
  const affectedFiles: AffectedFileIssue[] = [];
  const eventDetails: EventVerificationDetail[] = [];
  const anchoredSeqsPresent = new Set<number>();

  let expectedPrevHash: string = ZERO_BYTES32;

  for (let i = 0; i < nonFailedEvents.length; i++) {
    const ev = nonFailedEvents[i]!;
    const detected = new Set<EventVerificationVerdict>();
    const reasons: string[] = [];

    const recomputedHash = safeComputeEventHash(ev.record).toLowerCase();
    const storedHash = ev.eventHash.toLowerCase();
    let onChainEv: OnChainAnchoredEvent | null = null;
    let onChainHash: string | null = null;

    if (ev.chainStatus !== 'ANCHORED') {
      detected.add('NOT_YET_ANCHORED');
      reasons.push(`Event #${ev.seq} is currently ${ev.chainStatus} off-chain`);
    } else if (!batchHeader.exists || ev.seq > batchHeader.eventCount) {
      detected.add('HASH_MISMATCH');
      reasons.push(
        `Event #${ev.seq} is marked ANCHORED in DB but missing from TraceB3Ledger`,
      );
    } else {
      anchoredSeqsPresent.add(ev.seq);
      try {
        onChainEv = await chain.getAnchoredEvent(
          batch.onChainBatchId as `0x${string}`,
          ev.seq,
        );
      } catch (err) {
        throw AppError.chainUnavailable(
          `Failed to read on-chain event #${ev.seq}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      onChainHash = onChainEv.eventHash.toLowerCase();

      if (recomputedHash !== onChainHash || storedHash !== onChainHash) {
        detected.add('HASH_MISMATCH');
        reasons.push(
          `Canonical record hash mismatch on event #${ev.seq}: recomputed=${recomputedHash}, onChain=${onChainHash}`,
        );
      }
    }

    // Sequence & hash-chain continuity check
    const recordPrev =
      typeof ev.record?.prevEventHash === 'string'
        ? ev.record.prevEventHash.toLowerCase()
        : '';
    const storedPrev = ev.prevEventHash.toLowerCase();
    const onChainPrev = onChainEv ? onChainEv.prevHash.toLowerCase() : null;

    if (
      ev.seq !== i + 1 ||
      storedPrev !== expectedPrevHash ||
      recordPrev !== expectedPrevHash ||
      (onChainPrev !== null && onChainPrev !== expectedPrevHash)
    ) {
      detected.add('CHAIN_LINK_BROKEN');
      reasons.push(
        `Hash-chain link discontinuity at event #${ev.seq} (expected prevHash ${expectedPrevHash})`,
      );
    }

    // EIP-712 signature check
    let sigValid = false;
    try {
      const typedData = buildCustodyIntentTypedData({
        chainId: chain.chainId,
        verifyingContract: ledgerAddress,
        batchId: computeOnChainBatchId(batch.id),
        eventType: ev.eventType,
        eventHash: recomputedHash as `0x${string}`,
        prevHash: ev.prevEventHash as `0x${string}`,
        targetSeq: ev.targetSeq ?? 0,
        actor: getAddress(ev.actorWallet),
        nonce: BigInt(ev.nonce),
        deadline: BigInt(ev.deadline),
      });
      sigValid = await verifyTypedData({
        address: getAddress(ev.actorWallet),
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: ev.signature as Hex,
      });
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      detected.add('SIGNATURE_INVALID');
      reasons.push(
        `EIP-712 CustodyIntent signature failed verification for actor ${ev.actorWallet}`,
      );
    }

    // Evidence blob re-streaming & SHA-256 check
    const manifestItems = Array.isArray(ev.record?.evidence)
      ? ev.record.evidence
      : [];
    for (const item of manifestItems) {
      const expectedSha = String(item.sha256 ?? '').toLowerCase();
      const matchedFile =
        allEvidence.find(
          (f) => f.eventId === ev.id && f.sha256.toLowerCase() === expectedSha,
        ) ??
        allEvidence.find((f) => f.sha256.toLowerCase() === expectedSha);

      if (!matchedFile) {
        detected.add('FILE_MISSING');
        reasons.push(
          `Evidence metadata missing for manifest file "${item.label}" (${expectedSha})`,
        );
        affectedFiles.push({
          evidenceId: null,
          eventId: ev.id,
          seq: ev.seq,
          filename: item.label || expectedSha,
          issue: 'FILE_MISSING',
          expectedSha256: expectedSha,
          actualSha256: null,
        });
        continue;
      }

      const actualSha = await hashStorageStream(storage, matchedFile.storageKey);
      if (actualSha === null) {
        detected.add('FILE_MISSING');
        reasons.push(
          `Evidence file "${matchedFile.originalFilename}" (${matchedFile.id}) missing from storage`,
        );
        affectedFiles.push({
          evidenceId: matchedFile.id,
          eventId: ev.id,
          seq: ev.seq,
          filename: matchedFile.originalFilename,
          issue: 'FILE_MISSING',
          expectedSha256: expectedSha,
          actualSha256: null,
        });
      } else if (actualSha !== expectedSha) {
        detected.add('FILE_MISMATCH');
        reasons.push(
          `Evidence file "${matchedFile.originalFilename}" (${matchedFile.id}) SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
        );
        affectedFiles.push({
          evidenceId: matchedFile.id,
          eventId: ev.id,
          seq: ev.seq,
          filename: matchedFile.originalFilename,
          issue: 'FILE_MISMATCH',
          expectedSha256: expectedSha,
          actualSha256: actualSha,
        });
      }
    }

    const verdict = pickHighestPriorityVerdict(detected);
    if (verdict !== 'MATCH' && verdict !== 'NOT_YET_ANCHORED') {
      affectedEvents.push({
        eventId: ev.id,
        seq: ev.seq,
        verdict,
        reason: reasons.join('; '),
      });
    }

    eventDetails.push({
      eventId: ev.id,
      seq: ev.seq,
      eventType: ev.eventType,
      chainStatus: ev.chainStatus,
      verdict,
      reasons,
      recomputedHash,
      storedHash,
      onChainHash,
      txHash: ev.txHash,
      explorerUrl: ev.txHash ? chain.getExplorerTxUrl(ev.txHash) : null,
      anchoredAt: ev.anchoredAt ? ev.anchoredAt.toISOString() : null,
      filesChecked: manifestItems.length,
    });

    expectedPrevHash = onChainHash ?? storedHash;
  }

  const missingOnChainSeqs: number[] = [];
  if (batchHeader.exists) {
    for (let s = 1; s <= batchHeader.eventCount; s++) {
      if (!anchoredSeqsPresent.has(s)) {
        missingOnChainSeqs.push(s);
      }
    }
  }

  let verdict: OverallVerificationVerdict;
  if (
    affectedEvents.length > 0 ||
    affectedFiles.length > 0 ||
    missingOnChainSeqs.length > 0
  ) {
    verdict = 'TAMPERED';
  } else if (nonFailedEvents.length === 0 && allEvents.length > 0) {
    verdict = 'INCOMPLETE';
  } else if (
    nonFailedEvents.length === 0 ||
    !batchHeader.exists ||
    eventDetails.some((e) => e.verdict === 'NOT_YET_ANCHORED')
  ) {
    verdict = 'PENDING';
  } else {
    verdict = 'VERIFIED';
  }

  return {
    batchId: batch.id,
    publicId: batch.publicId,
    batchRef: batch.batchRef,
    onChainBatchId: batch.onChainBatchId,
    verdict,
    chainId: chain.chainId,
    ledgerAddress,
    onChainEventCount: batchHeader.eventCount,
    checkedAt: new Date().toISOString(),
    affectedEvents,
    affectedFiles,
    missingOnChainSeqs,
    events: eventDetails,
  };
}

/**
 * Exports a self-contained portable ProofBundle JSON for trustless RPC-only verification.
 */
export async function buildPortableProofBundle(params: {
  db: DatabaseClient;
  chain: ChainClient;
  publicId: string;
}): Promise<ProofBundle> {
  const { db, chain, publicId } = params;
  const ledgerAddress = chain.requireLedgerAddress();

  const batchRows = await db.db
    .select()
    .from(batches)
    .where(eq(batches.publicId, publicId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) {
    throw AppError.notFound(`Passport ${publicId} not found`);
  }

  const anchoredEvents = await db.db
    .select()
    .from(custodyEvents)
    .where(eq(custodyEvents.batchId, batch.id))
    .orderBy(asc(custodyEvents.seq));

  const bundleEvents = anchoredEvents
    .filter(
      (ev) =>
        ev.chainStatus === 'ANCHORED' &&
        ev.txHash !== null &&
        ev.blockNumber !== null &&
        ev.anchoredAt !== null,
    )
    .map((ev) => ({
      eventId: ev.id,
      seq: ev.seq,
      eventHash: ev.eventHash,
      prevEventHash: ev.prevEventHash,
      signature: ev.signature,
      nonce: ev.nonce,
      deadline: ev.deadline,
      txHash: ev.txHash!,
      blockNumber: ev.blockNumber!,
      anchoredAt: ev.anchoredAt!.toISOString(),
      record: ev.record,
    }));

  return ProofBundleSchema.parse({
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    chainId: chain.chainId,
    verifyingContract: ledgerAddress,
    batch: {
      id: batch.id,
      publicId: batch.publicId,
      batchRef: batch.batchRef,
      onChainBatchId: batch.onChainBatchId,
      wasteCode: batch.wasteCode,
      wasteName: batch.wasteName,
      status: batch.status,
    },
    events: bundleEvents,
  });
}

/**
 * Helper to fetch organization name map for timeline/batch serialization.
 */
export async function loadOrganizationNameMap(
  db: DatabaseClient,
): Promise<Map<string, { name: string; code: string; orgType: string }>> {
  const rows = await db.db
    .select({
      id: organizations.id,
      name: organizations.name,
      code: organizations.code,
      orgType: organizations.orgType,
    })
    .from(organizations);

  const map = new Map<string, { name: string; code: string; orgType: string }>();
  for (const row of rows) {
    map.set(row.id, { name: row.name, code: row.code, orgType: row.orgType });
  }
  return map;
}
