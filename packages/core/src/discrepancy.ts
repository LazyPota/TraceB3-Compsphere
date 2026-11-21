import type {
  ChainStatus,
  DiscrepancyCode,
  DiscrepancySeverity,
  EventType,
  ReasonCode,
} from './enums.js';
import {
  formatGramsAsKg,
  gramsToBigInt,
  type NormalizedQuantity,
} from './units.js';

export interface DiscrepancyEventInput {
  id: string;
  seq: number;
  type: EventType;
  quantity: NormalizedQuantity | null;
  targetSeq: number | null;
  reasonCode: ReasonCode | null;
  anchoredAt: Date | string | number | null;
  chainStatus: ChainStatus;
}

export interface DiscrepancyConfig {
  weightTolerancePct: number;
  custodyGapHours?: number;
}

export interface DiscrepancyFlag {
  code: DiscrepancyCode;
  severity: DiscrepancySeverity;
  expected: string | null;
  observed: string | null;
  deltaGrams: string | null;
  deltaKg: string | null;
  percent: number | null;
  eventIds: string[];
  hint?: string;
}

export interface DiscrepancyReport {
  flags: DiscrepancyFlag[];
  hasDiscrepancy: boolean;
  maxSeverity: DiscrepancySeverity;
  effectiveWeights: {
    declaredGrams: string | null;
    pickupGrams: string | null;
    deliveryGrams: string | null;
  };
}

const SEVERITY_RANK: Record<DiscrepancySeverity, number> = {
  none: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

function computeRoundedPercent(absDelta: bigint, expected: bigint): number {
  // Rounds (absDelta / expected) * 100 to 2 decimal places using pure BigInt arithmetic.
  const bpsRounded = (absDelta * 10000n * 2n + expected) / (2n * expected);
  return Number(bpsRounded) / 100;
}

function isWithinOnePercentOfThousandRatio(a: bigint, b: bigint): boolean {
  if (a <= 0n || b <= 0n) return false;
  const larger = a >= b ? a : b;
  const smaller = a >= b ? b : a;
  const scaled = smaller * 1000n;
  const diff = larger >= scaled ? larger - scaled : scaled - larger;
  return diff * 100n <= scaled;
}

function toEpochMs(value: Date | string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function evaluateWeightPair(
  code:
    | 'WEIGHT_MISMATCH_PICKUP'
    | 'WEIGHT_MISMATCH_DELIVERY'
    | 'WEIGHT_MISMATCH_TOTAL',
  expectedEvent: DiscrepancyEventInput,
  expectedQty: NormalizedQuantity,
  observedEvent: DiscrepancyEventInput,
  observedQty: NormalizedQuantity,
  toleranceBps: bigint,
): DiscrepancyFlag[] {
  const expected = gramsToBigInt(expectedQty.grams);
  const observed = gramsToBigInt(observedQty.grams);
  if (expected <= 0n) return [];

  const result: DiscrepancyFlag[] = [];
  const absDelta = observed >= expected ? observed - expected : expected - observed;
  const percent = computeRoundedPercent(absDelta, expected);

  if (absDelta * 10000n > expected * toleranceBps) {
    const severity: DiscrepancySeverity =
      absDelta * 10000n > expected * 1000n ? 'critical' : 'warning';
    result.push({
      code,
      severity,
      expected: expected.toString(10),
      observed: observed.toString(10),
      deltaGrams: absDelta.toString(10),
      deltaKg: formatGramsAsKg(absDelta),
      percent,
      eventIds: [expectedEvent.id, observedEvent.id],
    });
  }

  if (isWithinOnePercentOfThousandRatio(expected, observed)) {
    const direction =
      observed < expected ? '1000x smaller (e.g. g vs kg)' : '1000x larger (e.g. ton vs kg)';
    result.push({
      code: 'LIKELY_UNIT_ERROR',
      severity: 'critical',
      expected: expected.toString(10),
      observed: observed.toString(10),
      deltaGrams: absDelta.toString(10),
      deltaKg: formatGramsAsKg(absDelta),
      percent,
      eventIds: [expectedEvent.id, observedEvent.id],
      hint: `Observed weight is approximately ${direction} than expected; verify unit selection (kg/g/ton).`,
    });
  }

  return result;
}

/**
 * Pure discrepancy evaluation over custody events and their revisions.
 */
export function evaluateDiscrepancies(
  events: readonly DiscrepancyEventInput[],
  config?: Partial<DiscrepancyConfig>,
): DiscrepancyReport {
  const weightTolerancePct = config?.weightTolerancePct ?? 2;
  const custodyGapHours = config?.custodyGapHours;
  const toleranceBps = BigInt(Math.max(0, Math.round(weightTolerancePct * 100)));

  const activeEvents = events
    .filter((e) => e.chainStatus !== 'FAILED')
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const revisionsByTargetSeq = new Map<number, DiscrepancyEventInput[]>();
  for (const event of activeEvents) {
    if (event.type === 'REVISION' && event.targetSeq !== null) {
      const list = revisionsByTargetSeq.get(event.targetSeq) ?? [];
      list.push(event);
      revisionsByTargetSeq.set(event.targetSeq, list);
    }
  }

  const flags: DiscrepancyFlag[] = [];

  const resolveEffective = (
    base: DiscrepancyEventInput | undefined,
  ): {
    effectiveEvent: DiscrepancyEventInput;
    effectiveQuantity: NormalizedQuantity | null;
  } | null => {
    if (!base) return null;
    const revs = revisionsByTargetSeq.get(base.seq) ?? [];
    const latestWithQty = [...revs].reverse().find((r) => r.quantity !== null);
    if (!latestWithQty || !latestWithQty.quantity) {
      return { effectiveEvent: base, effectiveQuantity: base.quantity };
    }

    const origGrams = base.quantity ? gramsToBigInt(base.quantity.grams) : null;
    const revGrams = gramsToBigInt(latestWithQty.quantity.grams);
    let deltaGrams: string | null = null;
    let deltaKg: string | null = null;
    let percent: number | null = null;

    if (origGrams !== null && origGrams > 0n) {
      const absDelta =
        revGrams >= origGrams ? revGrams - origGrams : origGrams - revGrams;
      deltaGrams = absDelta.toString(10);
      deltaKg = formatGramsAsKg(absDelta);
      percent = computeRoundedPercent(absDelta, origGrams);
    }

    flags.push({
      code: 'VALUE_REVISED',
      severity: 'info',
      expected: base.quantity?.grams ?? null,
      observed: latestWithQty.quantity.grams,
      deltaGrams,
      deltaKg,
      percent,
      eventIds: [base.id, latestWithQty.id],
      hint: `Event #${base.seq} weight was revised by event #${latestWithQty.seq} (${latestWithQty.reasonCode ?? 'UNSPECIFIED'}). Original event remains preserved.`,
    });

    return {
      effectiveEvent: latestWithQty,
      effectiveQuantity: latestWithQty.quantity,
    };
  };

  const baseEvents = activeEvents.filter((e) => e.type !== 'REVISION');
  const createdBase = baseEvents.find((e) => e.type === 'CREATED');
  const transfers = baseEvents.filter((e) => e.type === 'CUSTODY_TRANSFERRED');
  const pickupBase = transfers[0];
  const deliveryBase = transfers[1];

  const declared = resolveEffective(createdBase);
  const pickup = resolveEffective(pickupBase);
  const delivery = resolveEffective(deliveryBase);

  if (
    declared?.effectiveQuantity &&
    pickup?.effectiveQuantity
  ) {
    flags.push(
      ...evaluateWeightPair(
        'WEIGHT_MISMATCH_PICKUP',
        declared.effectiveEvent,
        declared.effectiveQuantity,
        pickup.effectiveEvent,
        pickup.effectiveQuantity,
        toleranceBps,
      ),
    );
  }

  if (
    pickup?.effectiveQuantity &&
    delivery?.effectiveQuantity
  ) {
    flags.push(
      ...evaluateWeightPair(
        'WEIGHT_MISMATCH_DELIVERY',
        pickup.effectiveEvent,
        pickup.effectiveQuantity,
        delivery.effectiveEvent,
        delivery.effectiveQuantity,
        toleranceBps,
      ),
    );
  }

  if (
    declared?.effectiveQuantity &&
    delivery?.effectiveQuantity
  ) {
    flags.push(
      ...evaluateWeightPair(
        'WEIGHT_MISMATCH_TOTAL',
        declared.effectiveEvent,
        declared.effectiveQuantity,
        delivery.effectiveEvent,
        delivery.effectiveQuantity,
        toleranceBps,
      ),
    );
  }

  if (custodyGapHours !== undefined && custodyGapHours > 0) {
    const thresholdMs = custodyGapHours * 3_600_000;
    const anchoredTimeline = baseEvents.filter(
      (e) => toEpochMs(e.anchoredAt) !== null,
    );
    for (let i = 1; i < anchoredTimeline.length; i++) {
      const prev = anchoredTimeline[i - 1]!;
      const curr = anchoredTimeline[i]!;
      const prevMs = toEpochMs(prev.anchoredAt)!;
      const currMs = toEpochMs(curr.anchoredAt)!;
      const diffMs = currMs - prevMs;
      if (diffMs > thresholdMs) {
        const observedHours = Math.round((diffMs / 3_600_000) * 100) / 100;
        const severity: DiscrepancySeverity =
          diffMs > thresholdMs * 2 ? 'critical' : 'warning';
        flags.push({
          code: 'CUSTODY_GAP',
          severity,
          expected: String(custodyGapHours),
          observed: String(observedHours),
          deltaGrams: null,
          deltaKg: null,
          percent: null,
          eventIds: [prev.id, curr.id],
          hint: `${observedHours}h elapsed between event #${prev.seq} and event #${curr.seq} (threshold: ${custodyGapHours}h).`,
        });
      }
    }
  }

  let maxSeverity: DiscrepancySeverity = 'none';
  for (const flag of flags) {
    if (SEVERITY_RANK[flag.severity] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = flag.severity;
    }
  }

  const hasDiscrepancy = flags.some(
    (f) => f.severity === 'warning' || f.severity === 'critical',
  );

  return {
    flags,
    hasDiscrepancy,
    maxSeverity,
    effectiveWeights: {
      declaredGrams: declared?.effectiveQuantity?.grams ?? null,
      pickupGrams: pickup?.effectiveQuantity?.grams ?? null,
      deliveryGrams: delivery?.effectiveQuantity?.grams ?? null,
    },
  };
}
