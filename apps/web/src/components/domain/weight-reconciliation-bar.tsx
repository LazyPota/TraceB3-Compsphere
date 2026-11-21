import { formatGramsAsKg, type DiscrepancyReport } from '@traceb3/core';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface WeightReconciliationBarProps {
  declaredGrams: string | null;
  pickupGrams: string | null;
  deliveryGrams: string | null;
  discrepancies?: DiscrepancyReport;
  className?: string;
}

export function WeightReconciliationBar({
  declaredGrams,
  pickupGrams,
  deliveryGrams,
  discrepancies,
  className,
}: WeightReconciliationBarProps) {
  const hasCritical = discrepancies?.maxSeverity === 'critical';
  const hasWarning = discrepancies?.maxSeverity === 'warning';

  const totalFlag = discrepancies?.flags.find(
    (f) => f.code === 'WEIGHT_MISMATCH_TOTAL' || f.code === 'WEIGHT_MISMATCH_DELIVERY',
  );

  const deltaDisplay = (() => {
    if (!declaredGrams || !deliveryGrams) return null;
    const diff = BigInt(deliveryGrams) - BigInt(declaredGrams);
    if (diff === 0n) return null;
    const abs = diff < 0n ? -diff : diff;
    const sign = diff < 0n ? '-' : '+';
    const pct = totalFlag?.percent !== null && totalFlag?.percent !== undefined ? ` (${sign}${totalFlag.percent}%)` : '';
    return `${sign}${formatGramsAsKg(abs)} kg${pct}`;
  })();

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-ink-muted">Declared (Generator)</p>
          <p className="font-data mt-0.5 text-sm font-semibold text-ink">
            {declaredGrams ? `${formatGramsAsKg(declaredGrams)} kg` : 'Pending'}
          </p>
        </div>

        <div>
          <p className="flex items-center gap-1 text-ink-muted">
            {pickupGrams ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-verified" />
            ) : (
              <Clock className="h-3.5 w-3.5 text-ink-muted" />
            )}
            <span>Picked Up (Transporter)</span>
          </p>
          <p className="font-data mt-0.5 text-sm font-semibold text-ink">
            {pickupGrams ? `${formatGramsAsKg(pickupGrams)} kg` : 'Awaiting'}
          </p>
        </div>

        <div>
          <p className="flex items-center gap-1 text-ink-muted">
            {deliveryGrams ? (
              hasCritical || hasWarning ? (
                <AlertTriangle className="h-3.5 w-3.5 text-critical" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-verified" />
              )
            ) : (
              <Clock className="h-3.5 w-3.5 text-ink-muted" />
            )}
            <span>Received (Facility)</span>
          </p>
          <p
            className={cn(
              'font-data mt-0.5 text-sm font-semibold',
              hasCritical
                ? 'text-critical'
                : hasWarning
                  ? 'text-warning'
                  : 'text-ink',
            )}
          >
            {deliveryGrams ? `${formatGramsAsKg(deliveryGrams)} kg` : 'Awaiting'}
          </p>
        </div>
      </div>

      {/* 3-segment visual progress bar */}
      <div className="grid grid-cols-3 gap-1.5" aria-hidden="true">
        <div
          className={cn(
            'h-2 rounded-l-full',
            declaredGrams ? 'bg-brand' : 'bg-well',
          )}
        />
        <div
          className={cn(
            'h-2',
            pickupGrams ? 'bg-verified' : 'bg-well',
          )}
        />
        <div
          className={cn(
            'h-2 rounded-r-full',
            !deliveryGrams
              ? 'bg-well'
              : hasCritical
                ? 'bg-critical'
                : hasWarning
                  ? 'bg-b3-amber'
                  : 'bg-verified',
          )}
        />
      </div>

      {deltaDisplay && (
        <p
          className={cn(
            'font-data text-xs font-semibold',
            hasCritical ? 'text-critical' : hasWarning ? 'text-warning' : 'text-ink-secondary',
          )}
        >
          Effective weight variance: {deltaDisplay}
        </p>
      )}
    </div>
  );
}
