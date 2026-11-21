import {
  evaluateDiscrepancies,
  formatGramsAsKg,
  normalizeWeightToGrams,
  type WeightUnit,
} from '@traceb3/core';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface DiscrepancyDeltaMeterProps {
  expectedGrams: string | null;
  observedValue: string;
  observedUnit: WeightUnit;
  tolerancePct?: number;
  className?: string;
}

export function DiscrepancyDeltaMeter({
  expectedGrams,
  observedValue,
  observedUnit,
  tolerancePct = 2,
  className,
}: DiscrepancyDeltaMeterProps) {
  let normalized: ReturnType<typeof normalizeWeightToGrams> | null = null;
  let parseError: string | null = null;

  if (observedValue.trim().length > 0) {
    try {
      normalized = normalizeWeightToGrams(observedValue.trim(), observedUnit);
    } catch (err) {
      parseError = err instanceof Error ? err.message : 'Invalid weight value';
    }
  }

  if (parseError) {
    return (
      <div
        className={cn(
          'rounded-lg border border-critical/30 bg-critical-bg px-3.5 py-2.5 text-xs text-critical-fg',
          className,
        )}
      >
        {parseError}
      </div>
    );
  }

  if (!normalized) {
    return (
      <div
        className={cn(
          'rounded-lg border border-line bg-well px-3.5 py-2.5 text-xs text-ink-secondary',
          className,
        )}
      >
        Enter an observed physical weight to compute exact integer grams and variance.
      </div>
    );
  }

  const normalizedKg = formatGramsAsKg(normalized.grams);

  if (!expectedGrams) {
    return (
      <div
        className={cn(
          'flex items-center justify-between rounded-lg border border-line bg-well px-3.5 py-2.5 text-xs',
          className,
        )}
      >
        <span className="text-ink-secondary">Canonical Normalized Weight</span>
        <span className="font-data font-semibold text-ink">
          {normalizedKg} kg ({normalized.grams} g)
        </span>
      </div>
    );
  }

  const report = evaluateDiscrepancies(
    [
      {
        id: 'expected',
        seq: 1,
        type: 'CREATED',
        quantity: {
          grams: expectedGrams,
          originalValue: formatGramsAsKg(expectedGrams),
          originalUnit: 'kg',
        },
        targetSeq: null,
        reasonCode: null,
        anchoredAt: null,
        chainStatus: 'ANCHORED',
      },
      {
        id: 'observed',
        seq: 2,
        type: 'CUSTODY_TRANSFERRED',
        quantity: normalized,
        targetSeq: null,
        reasonCode: null,
        anchoredAt: null,
        chainStatus: 'PENDING',
      },
    ],
    { weightTolerancePct: tolerancePct },
  );

  const expectedBi = BigInt(expectedGrams);
  const observedBi = BigInt(normalized.grams);
  const signedDiff = observedBi - expectedBi;
  const absDiff = signedDiff >= 0n ? signedDiff : -signedDiff;
  const signPrefix = signedDiff > 0n ? '+' : signedDiff < 0n ? '-' : '';

  const unitFlag = report.flags.find((f) => f.code === 'LIKELY_UNIT_ERROR');
  const mismatchFlag = report.flags.find((f) => f.code !== 'LIKELY_UNIT_ERROR');

  if (report.maxSeverity === 'critical') {
    return (
      <div
        role="status"
        className={cn(
          'rounded-lg border-l-4 border border-critical/35 border-l-critical bg-critical-bg px-3.5 py-3 text-xs text-critical-fg',
          className,
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0 text-critical" />
            <span>
              {unitFlag
                ? 'Critical Unit Mismatch Alert (LIKELY_UNIT_ERROR)'
                : 'Critical Weight Discrepancy Will Be Flagged'}
            </span>
          </div>
          <span className="font-data font-bold">
            {signPrefix}
            {formatGramsAsKg(absDiff)} kg
            {mismatchFlag?.percent !== null && mismatchFlag?.percent !== undefined
              ? ` (${signPrefix}${mismatchFlag.percent}%)`
              : ''}
          </span>
        </div>
        <p className="mt-1 text-ink-secondary">
          {unitFlag?.hint ??
            `Declared ${formatGramsAsKg(expectedGrams)} kg vs observed ${normalizedKg} kg (${normalized.grams} g).`}
        </p>
      </div>
    );
  }

  if (report.maxSeverity === 'warning') {
    return (
      <div
        role="status"
        className={cn(
          'rounded-lg border-l-4 border border-warning/35 border-l-b3-amber bg-warning-bg px-3.5 py-3 text-xs text-warning-fg',
          className,
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <Info className="h-4 w-4 shrink-0 text-warning" />
            <span>Weight Tolerance Exceeded (&gt;{tolerancePct}%)</span>
          </div>
          <span className="font-data font-bold">
            {signPrefix}
            {formatGramsAsKg(absDiff)} kg ({signPrefix}
            {mismatchFlag?.percent ?? 0}%)
          </span>
        </div>
        <p className="mt-1 text-ink-secondary">
          Observed {normalizedKg} kg ({normalized.grams} g) vs expected{' '}
          {formatGramsAsKg(expectedGrams)} kg.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-verified/30 bg-verified-bg px-3.5 py-2.5 text-xs text-verified-fg',
        className,
      )}
    >
      <div className="flex items-center gap-2 font-semibold">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-verified" />
        <span>Weight Within Tolerance</span>
      </div>
      <span className="font-data font-semibold">
        {normalizedKg} kg ({normalized.grams} g)
        {absDiff > 0n ? ` · Δ ${signPrefix}${formatGramsAsKg(absDiff)} kg` : ' · Exact Match'}
      </span>
    </div>
  );
}
