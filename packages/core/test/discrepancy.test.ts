import { describe, expect, it } from 'vitest';
import {
  evaluateDiscrepancies,
  type DiscrepancyEventInput,
} from '../src/discrepancy.js';
import { normalizeWeightToGrams } from '../src/units.js';

function makeEvent(
  id: string,
  seq: number,
  type: DiscrepancyEventInput['type'],
  valueKg: string | null,
  opts: Partial<DiscrepancyEventInput> = {},
): DiscrepancyEventInput {
  return {
    id,
    seq,
    type,
    quantity: valueKg ? normalizeWeightToGrams(valueKg, 'kg') : null,
    targetSeq: null,
    reasonCode: null,
    anchoredAt: new Date(Date.UTC(2026, 0, 1, seq, 0, 0)),
    chainStatus: 'ANCHORED',
    ...opts,
  };
}

describe('discrepancy engine', () => {
  it('flags mandatory test case: declared 850 kg vs received 620 kg -> 230 kg, 27.06%, critical', () => {
    const events: DiscrepancyEventInput[] = [
      makeEvent('ev-1', 1, 'CREATED', '850'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', '850'),
      makeEvent('ev-3', 3, 'CUSTODY_TRANSFERRED', '620'),
    ];

    const report = evaluateDiscrepancies(events);
    expect(report.hasDiscrepancy).toBe(true);
    expect(report.maxSeverity).toBe('critical');

    const totalMismatch = report.flags.find(
      (f) => f.code === 'WEIGHT_MISMATCH_TOTAL',
    );
    expect(totalMismatch).toEqual({
      code: 'WEIGHT_MISMATCH_TOTAL',
      severity: 'critical',
      expected: '850000',
      observed: '620000',
      deltaGrams: '230000',
      deltaKg: '230',
      percent: 27.06,
      eventIds: ['ev-1', 'ev-3'],
    });
  });

  it('respects tolerance thresholds (<=2% none, >2%..10% warning, >10% critical)', () => {
    // 2.00% exactly -> within tolerance (none)
    const withinTol = evaluateDiscrepancies([
      makeEvent('ev-1', 1, 'CREATED', '100'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', '98'),
    ]);
    expect(withinTol.hasDiscrepancy).toBe(false);
    expect(withinTol.maxSeverity).toBe('none');
    expect(withinTol.flags).toHaveLength(0);

    // 5.00% -> warning
    const warn = evaluateDiscrepancies([
      makeEvent('ev-1', 1, 'CREATED', '100'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', '95'),
    ]);
    expect(warn.hasDiscrepancy).toBe(true);
    expect(warn.maxSeverity).toBe('warning');
    expect(warn.flags[0]).toMatchObject({
      code: 'WEIGHT_MISMATCH_PICKUP',
      severity: 'warning',
      percent: 5,
    });

    // 15.00% -> critical
    const crit = evaluateDiscrepancies([
      makeEvent('ev-1', 1, 'CREATED', '100'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', '85'),
    ]);
    expect(crit.hasDiscrepancy).toBe(true);
    expect(crit.maxSeverity).toBe('critical');
  });

  it('detects LIKELY_UNIT_ERROR for 10^-3 (g vs kg) and 10^3 (ton vs kg) ratios', () => {
    const smaller = evaluateDiscrepancies([
      makeEvent('ev-1', 1, 'CREATED', '850'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', null, {
        quantity: normalizeWeightToGrams('850', 'g'),
      }),
    ]);
    expect(smaller.maxSeverity).toBe('critical');
    const flagSmall = smaller.flags.find((f) => f.code === 'LIKELY_UNIT_ERROR');
    expect(flagSmall).toBeDefined();
    expect(flagSmall?.severity).toBe('critical');
    expect(flagSmall?.hint).toContain('1000x smaller');

    const larger = evaluateDiscrepancies([
      makeEvent('ev-1', 1, 'CREATED', '850'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', null, {
        quantity: normalizeWeightToGrams('850', 'ton'),
      }),
    ]);
    expect(larger.maxSeverity).toBe('critical');
    const flagLarge = larger.flags.find((f) => f.code === 'LIKELY_UNIT_ERROR');
    expect(flagLarge).toBeDefined();
    expect(flagLarge?.hint).toContain('1000x larger');
  });

  it('evaluates latest revision weight while preserving original events and emitting VALUE_REVISED', () => {
    const events: DiscrepancyEventInput[] = [
      makeEvent('ev-1', 1, 'CREATED', '850'),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', '850'),
      makeEvent('ev-3', 3, 'CUSTODY_TRANSFERRED', '620'),
      makeEvent('ev-4', 4, 'REVISION', '845', {
        targetSeq: 3,
        reasonCode: 'SCALE_RECALIBRATION',
      }),
    ];

    const report = evaluateDiscrepancies(events);
    expect(report.hasDiscrepancy).toBe(false);
    expect(report.maxSeverity).toBe('info');
    expect(report.effectiveWeights).toEqual({
      declaredGrams: '850000',
      pickupGrams: '850000',
      deliveryGrams: '845000',
    });

    const revisedFlag = report.flags.find((f) => f.code === 'VALUE_REVISED');
    expect(revisedFlag).toBeDefined();
    expect(revisedFlag?.severity).toBe('info');
    expect(revisedFlag?.eventIds).toEqual(['ev-3', 'ev-4']);
  });

  it('flags CUSTODY_GAP when elapsed hours exceed configured threshold', () => {
    const events: DiscrepancyEventInput[] = [
      makeEvent('ev-1', 1, 'CREATED', '850', {
        anchoredAt: new Date('2026-01-01T00:00:00Z'),
      }),
      makeEvent('ev-2', 2, 'CUSTODY_TRANSFERRED', '850', {
        anchoredAt: new Date('2026-01-02T12:00:00Z'), // 36 hours later
      }),
    ];

    const report = evaluateDiscrepancies(events, { custodyGapHours: 24 });
    expect(report.hasDiscrepancy).toBe(true);
    expect(report.maxSeverity).toBe('warning');
    expect(report.flags.find((f) => f.code === 'CUSTODY_GAP')).toMatchObject({
      code: 'CUSTODY_GAP',
      severity: 'warning',
      expected: '24',
      observed: '36',
      eventIds: ['ev-1', 'ev-2'],
    });
  });
});
