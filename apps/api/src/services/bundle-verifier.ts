import { TRACEB3_LEDGER_ABI } from '@traceb3/contracts';
import {
  buildCustodyIntentTypedData,
  computeEventHash,
  computeOnChainBatchId,
  ProofBundleSchema,
  ZERO_BYTES32,
  type EventVerificationVerdict,
  type OverallVerificationVerdict,
} from '@traceb3/core';
import { createPublicClient, getAddress, http, verifyTypedData, type Hex } from 'viem';

export interface BundleEventCheckResult {
  eventId: string;
  seq: number;
  verdict: EventVerificationVerdict;
  reasons: string[];
  recomputedHash: string;
  onChainHash: string | null;
}

export interface BundleVerificationResult {
  verdict: OverallVerificationVerdict;
  chainId: number;
  verifyingContract: string;
  batchRef: string;
  onChainBatchId: string;
  onChainEventCount: number;
  bundleEventCount: number;
  issues: string[];
  events: BundleEventCheckResult[];
}

/**
 * Verifies a portable TRACEB3 ProofBundle JSON strictly against an EVM RPC endpoint
 * without requiring access to the TRACEB3 API or PostgreSQL database.
 */
export async function verifyProofBundleAgainstRpc(
  rawBundle: unknown,
  rpcUrl: string,
): Promise<BundleVerificationResult> {
  const bundle = ProofBundleSchema.parse(rawBundle);
  const contractAddress = getAddress(bundle.verifyingContract);
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000 }),
  });

  const issues: string[] = [];
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== bundle.chainId) {
    issues.push(
      `RPC chainId (${rpcChainId}) does not match bundle chainId (${bundle.chainId})`,
    );
  }

  const expectedBatchId = computeOnChainBatchId(bundle.batch.id).toLowerCase();
  if (expectedBatchId !== bundle.batch.onChainBatchId.toLowerCase()) {
    issues.push(
      `Bundle onChainBatchId (${bundle.batch.onChainBatchId}) does not match keccak256(batch.id) (${expectedBatchId})`,
    );
  }

  const batchHeader = await publicClient.readContract({
    address: contractAddress,
    abi: TRACEB3_LEDGER_ABI,
    functionName: 'getBatch',
    args: [bundle.batch.onChainBatchId as `0x${string}`],
  });

  if (!batchHeader.exists) {
    issues.push(
      `Batch ${bundle.batch.onChainBatchId} does not exist on TraceB3Ledger at ${contractAddress}`,
    );
  }

  const sortedEvents = bundle.events.slice().sort((a, b) => a.seq - b.seq);
  const eventResults: BundleEventCheckResult[] = [];
  let expectedPrevHash: string = ZERO_BYTES32;
  let hasTamper = false;

  for (let i = 0; i < sortedEvents.length; i++) {
    const ev = sortedEvents[i]!;
    const reasons: string[] = [];
    let verdict: EventVerificationVerdict = 'MATCH';

    const recomputedHash = computeEventHash({
      ...ev.record,
      prevEventHash: ev.record.prevEventHash as `0x${string}`,
    }).toLowerCase();
    if (recomputedHash !== ev.eventHash.toLowerCase()) {
      verdict = 'HASH_MISMATCH';
      hasTamper = true;
      reasons.push(
        `Recomputed RFC 8785 hash ${recomputedHash} != bundle eventHash ${ev.eventHash}`,
      );
    }

    let onChainHash: string | null = null;
    if (!batchHeader.exists || ev.seq > Number(batchHeader.eventCount)) {
      verdict = 'HASH_MISMATCH';
      hasTamper = true;
      reasons.push(`Event #${ev.seq} is absent from TraceB3Ledger`);
    } else {
      const onChainEv = await publicClient.readContract({
        address: contractAddress,
        abi: TRACEB3_LEDGER_ABI,
        functionName: 'getEvent',
        args: [bundle.batch.onChainBatchId as `0x${string}`, ev.seq],
      });
      onChainHash = onChainEv.eventHash.toLowerCase();

      if (recomputedHash !== onChainHash) {
        verdict = 'HASH_MISMATCH';
        hasTamper = true;
        reasons.push(
          `Recomputed hash ${recomputedHash} != on-chain hash ${onChainHash}`,
        );
      }

      if (
        ev.seq !== i + 1 ||
        ev.prevEventHash.toLowerCase() !== expectedPrevHash ||
        ev.record.prevEventHash.toLowerCase() !== expectedPrevHash ||
        onChainEv.prevHash.toLowerCase() !== expectedPrevHash
      ) {
        if (verdict === 'MATCH') verdict = 'CHAIN_LINK_BROKEN';
        hasTamper = true;
        reasons.push(
          `Broken hash-chain continuity at seq #${ev.seq} (expected prevHash ${expectedPrevHash})`,
        );
      }

      if (
        getAddress(onChainEv.actor) !== getAddress(ev.record.actorWallet)
      ) {
        if (verdict === 'MATCH') verdict = 'SIGNATURE_INVALID';
        hasTamper = true;
        reasons.push(
          `Actor mismatch between bundle (${ev.record.actorWallet}) and chain (${onChainEv.actor})`,
        );
      }
    }

    let sigValid = false;
    try {
      const typedData = buildCustodyIntentTypedData({
        chainId: bundle.chainId,
        verifyingContract: contractAddress,
        batchId: bundle.batch.onChainBatchId as `0x${string}`,
        eventType: ev.record.type,
        eventHash: recomputedHash as `0x${string}`,
        prevHash: ev.prevEventHash as `0x${string}`,
        targetSeq: ev.record.targetSeq ?? 0,
        actor: getAddress(ev.record.actorWallet),
        nonce: BigInt(ev.nonce),
        deadline: BigInt(ev.deadline),
      });
      sigValid = await verifyTypedData({
        address: getAddress(ev.record.actorWallet),
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
      if (verdict === 'MATCH') verdict = 'SIGNATURE_INVALID';
      hasTamper = true;
      reasons.push(`EIP-712 signature invalid for actor ${ev.record.actorWallet}`);
    }

    issues.push(...reasons);
    eventResults.push({
      eventId: ev.eventId,
      seq: ev.seq,
      verdict,
      reasons,
      recomputedHash,
      onChainHash,
    });

    expectedPrevHash = onChainHash ?? ev.eventHash.toLowerCase();
  }

  const onChainEventCount = Number(batchHeader.eventCount);
  if (onChainEventCount !== sortedEvents.length) {
    issues.push(
      `Bundle contains ${sortedEvents.length} events, but TraceB3Ledger reports ${onChainEventCount}`,
    );
  }

  let verdict: OverallVerificationVerdict = 'VERIFIED';
  if (hasTamper || issues.length > 0) {
    verdict =
      !hasTamper && sortedEvents.length < onChainEventCount
        ? 'INCOMPLETE'
        : 'TAMPERED';
  } else if (sortedEvents.length === 0) {
    verdict = 'INCOMPLETE';
  }

  return {
    verdict,
    chainId: bundle.chainId,
    verifyingContract: contractAddress,
    batchRef: bundle.batch.batchRef,
    onChainBatchId: bundle.batch.onChainBatchId,
    onChainEventCount,
    bundleEventCount: sortedEvents.length,
    issues,
    events: eventResults,
  };
}
