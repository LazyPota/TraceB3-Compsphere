import { keccak256, sha256, stringToBytes } from 'viem';
import {
  canonicalizeJson,
  type CanonicalEventRecordV1,
} from './canonical.js';

/**
 * Computes the deterministic SHA-256 hash of an RFC 8785 canonicalized custody record.
 */
export function computeEventHash(
  record: CanonicalEventRecordV1,
): `0x${string}` {
  const canonical = canonicalizeJson(record);
  return sha256(stringToBytes(canonical)).toLowerCase() as `0x${string}`;
}

/**
 * Computes the on-chain bytes32 batch identifier from a UUID batch ID.
 */
export function computeOnChainBatchId(batchUuid: string): `0x${string}` {
  return keccak256(stringToBytes(batchUuid)).toLowerCase() as `0x${string}`;
}

/**
 * Computes the on-chain bytes32 organization identifier from a UUID org ID.
 */
export function computeOnChainOrgId(orgUuid: string): `0x${string}` {
  return keccak256(stringToBytes(orgUuid)).toLowerCase() as `0x${string}`;
}
