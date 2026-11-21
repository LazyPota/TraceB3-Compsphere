import canonicalizePkg from 'canonicalize';
import type { EventType, ReasonCode } from './enums.js';
import type { NormalizedQuantity } from './units.js';

export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export interface CanonicalEvidenceItem {
  sha256: string;
  mime: string;
  size: number;
  label: string;
}

export interface CanonicalEventRecordV1 {
  v: 1;
  batchId: string;
  seq: number;
  type: EventType;
  actorWallet: string;
  actorOrgId: string;
  fromOrgId: string | null;
  toOrgId: string | null;
  wasteCode: string;
  quantity: NormalizedQuantity | null;
  evidence: CanonicalEvidenceItem[];
  targetSeq: number | null;
  reasonCode: ReasonCode | null;
  notes: string | null;
  prevEventHash: `0x${string}`;
  salt: string;
}

export interface BuildCanonicalEventRecordInput {
  batchId: string;
  seq: number;
  type: EventType;
  actorWallet: string;
  actorOrgId: string;
  fromOrgId?: string | null;
  toOrgId?: string | null;
  wasteCode: string;
  quantity?: NormalizedQuantity | null;
  evidence?: readonly CanonicalEvidenceItem[];
  targetSeq?: number | null;
  reasonCode?: ReasonCode | null;
  notes?: string | null;
  prevEventHash: `0x${string}`;
  salt?: string;
}

type CanonicalizeFn = (input: unknown) => string | undefined;

const canonicalizeFn: CanonicalizeFn =
  typeof canonicalizePkg === 'function'
    ? canonicalizePkg
    : (canonicalizePkg as unknown as { default: CanonicalizeFn }).default;

/**
 * Generates a 16-byte cryptographic salt encoded as 32 lowercase hex characters.
 * Prevents dictionary attacks on low-entropy waste records whose hash is anchored publicly.
 */
export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Returns a deterministic copy of evidence descriptors sorted by sha256 digest.
 */
export function sortCanonicalEvidence(
  items: readonly CanonicalEvidenceItem[],
): CanonicalEvidenceItem[] {
  return items
    .map((item) => ({
      sha256: item.sha256.toLowerCase(),
      mime: item.mime,
      size: item.size,
      label: item.label,
    }))
    .sort(
      (a, b) =>
        compareAscii(a.sha256, b.sha256) ||
        compareAscii(a.label, b.label) ||
        compareAscii(a.mime, b.mime) ||
        a.size - b.size,
    );
}

/**
 * Builds an explicit, versioned canonical custody event record (v1).
 */
export function buildCanonicalEventRecord(
  input: BuildCanonicalEventRecordInput,
): CanonicalEventRecordV1 {
  const prevHashLower = input.prevEventHash.toLowerCase() as `0x${string}`;

  return {
    v: 1,
    batchId: input.batchId,
    seq: input.seq,
    type: input.type,
    actorWallet: input.actorWallet.toLowerCase(),
    actorOrgId: input.actorOrgId,
    fromOrgId: input.fromOrgId ?? null,
    toOrgId: input.toOrgId ?? null,
    wasteCode: input.wasteCode,
    quantity: input.quantity ?? null,
    evidence: sortCanonicalEvidence(input.evidence ?? []),
    targetSeq: input.targetSeq ?? null,
    reasonCode: input.reasonCode ?? null,
    notes: input.notes ?? null,
    prevEventHash: prevHashLower,
    salt: (input.salt ?? generateSalt()).toLowerCase(),
  };
}

/**
 * Serializes any JSON-compatible value according to RFC 8785 (JCS).
 */
export function canonicalizeJson(value: unknown): string {
  const result = canonicalizeFn(value);
  if (typeof result !== 'string') {
    throw new Error('Failed to canonicalize value to RFC 8785 JSON');
  }
  return result;
}
