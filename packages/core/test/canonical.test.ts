import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/enums.js';
import {
  buildCanonicalEventRecord,
  canonicalizeJson,
  generateSalt,
  sortCanonicalEvidence,
  ZERO_BYTES32,
  type CanonicalEventRecordV1,
} from '../src/canonical.js';
import {
  computeEventHash,
  computeOnChainBatchId,
  computeOnChainOrgId,
} from '../src/hash.js';

function shuffleKeysDeep(value: unknown, seedOrder: number[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => shuffleKeysDeep(item, seedOrder));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const indexed = entries.map((entry, idx) => ({
      entry,
      weight: seedOrder[idx % Math.max(seedOrder.length, 1)] ?? idx,
    }));
    indexed.sort((a, b) => a.weight - b.weight);
    const out: Record<string, unknown> = {};
    for (const item of indexed) {
      out[item.entry[0]] = shuffleKeysDeep(item.entry[1], seedOrder);
    }
    return out;
  }
  return value;
}

describe('canonicalization and cryptographic hashing', () => {
  it('is strictly key-order invariant under RFC 8785 (property test)', () => {
    const hexChar = fc.constantFrom(
      ...'0123456789abcdef'.split(''),
    );
    const hex64 = fc.stringOf(hexChar, { minLength: 64, maxLength: 64 });
    const hex40 = fc.stringOf(hexChar, { minLength: 40, maxLength: 40 });
    const hex32 = fc.stringOf(hexChar, { minLength: 32, maxLength: 32 });

    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom(...EVENT_TYPES),
        hex40,
        fc.uuid(),
        fc.option(fc.uuid(), { nil: null }),
        fc.option(fc.uuid(), { nil: null }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.array(
          fc.record({
            sha256: hex64,
            mime: fc.constantFrom('application/pdf', 'image/jpeg', 'image/png'),
            size: fc.integer({ min: 1, max: 10_000_000 }),
            label: fc.string({ minLength: 1, maxLength: 30 }),
          }),
          { maxLength: 4 },
        ),
        hex64,
        hex32,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 5, maxLength: 20 }),
        (
          batchId,
          seq,
          type,
          walletHex,
          actorOrgId,
          fromOrgId,
          toOrgId,
          gramsInt,
          evidence,
          prevHex,
          salt,
          perm,
        ) => {
          const record = buildCanonicalEventRecord({
            batchId,
            seq,
            type,
            actorWallet: `0x${walletHex.toUpperCase()}`,
            actorOrgId,
            fromOrgId,
            toOrgId,
            wasteCode: 'B105d',
            quantity: {
              grams: String(gramsInt * 1000),
              originalValue: String(gramsInt),
              originalUnit: 'kg',
            },
            evidence,
            targetSeq: type === 'REVISION' ? 1 : null,
            reasonCode: type === 'REVISION' ? 'SCALE_RECALIBRATION' : null,
            notes: 'Jababeka manifest check',
            prevEventHash: `0x${prevHex.toUpperCase()}`,
            salt,
          });

          const reordered = shuffleKeysDeep(
            record,
            perm,
          ) as CanonicalEventRecordV1;

          expect(canonicalizeJson(reordered)).toBe(canonicalizeJson(record));
          expect(computeEventHash(reordered)).toBe(computeEventHash(record));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sorts evidence deterministically regardless of input array order', () => {
    const itemA = {
      sha256: 'a'.repeat(64),
      mime: 'application/pdf',
      size: 1024,
      label: 'manifest',
    };
    const itemB = {
      sha256: 'b'.repeat(64),
      mime: 'image/png',
      size: 2048,
      label: 'scale-photo',
    };

    const rec1 = buildCanonicalEventRecord({
      batchId: 'batch-1',
      seq: 1,
      type: 'CREATED',
      actorWallet: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      actorOrgId: 'org-1',
      wasteCode: 'B105d',
      evidence: [itemB, itemA],
      prevEventHash: ZERO_BYTES32,
      salt: '0123456789abcdef0123456789abcdef',
    });

    const rec2 = buildCanonicalEventRecord({
      batchId: 'batch-1',
      seq: 1,
      type: 'CREATED',
      actorWallet: '0xabcdef0123456789abcdef0123456789abcdef01',
      actorOrgId: 'org-1',
      wasteCode: 'B105d',
      evidence: [itemA, itemB],
      prevEventHash: ZERO_BYTES32,
      salt: '0123456789abcdef0123456789abcdef',
    });

    expect(sortCanonicalEvidence([itemB, itemA])).toEqual([itemA, itemB]);
    expect(computeEventHash(rec1)).toBe(computeEventHash(rec2));
    expect(rec1.actorWallet).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('produces unique 16-byte salts and deterministic bytes32 IDs', () => {
    const s1 = generateSalt();
    const s2 = generateSalt();
    expect(s1).toMatch(/^[0-9a-f]{32}$/);
    expect(s2).toMatch(/^[0-9a-f]{32}$/);
    expect(s1).not.toBe(s2);

    const b1 = computeOnChainBatchId('01950000-0000-7000-8000-000000000001');
    const b2 = computeOnChainBatchId('01950000-0000-7000-8000-000000000001');
    expect(b1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b1).toBe(b2);
    expect(computeOnChainOrgId('org-uuid')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
