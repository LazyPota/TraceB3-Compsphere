import type { NormalizedQuantity, ReasonCode } from '@traceb3/core';
import { formatGramsAsKg } from '@traceb3/core';
import { Lock, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CopyChip } from './copy-chip';
import { REASON_CODE_LABELS, formatTimestampWib } from '@/lib/b3-codes';

export interface RevisionSnapshot {
  seq: number;
  quantity: NormalizedQuantity | null;
  notes: string | null;
  reasonCode: ReasonCode | null;
  txHash: string | null;
  explorerUrl: string | null;
  anchoredAt: string | null;
}

export interface RevisionDiffProps {
  original: RevisionSnapshot;
  revised: RevisionSnapshot;
  wasteCode: string;
  wasteName: string;
}

export function RevisionDiff({
  original,
  revised,
  wasteCode,
  wasteName,
}: RevisionDiffProps) {
  const origGrams = original.quantity?.grams ?? null;
  const revGrams = revised.quantity?.grams ?? null;
  const weightChanged = origGrams !== revGrams;
  const notesChanged = (original.notes ?? '') !== (revised.notes ?? '');

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-line bg-well/80 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-secondary">
            <Lock className="h-4 w-4" />
            <span>Original Record (#{original.seq})</span>
          </div>
          <Badge tone="neutral">Preserved On-Chain</Badge>
        </div>

        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-ink-muted">Waste Classification</dt>
            <dd className="mt-0.5 font-medium text-ink">
              <span className="font-data mr-1.5">{wasteCode}</span>
              {wasteName}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Recorded Net Weight</dt>
            <dd className="font-data mt-0.5 text-sm font-semibold text-ink">
              {origGrams ? `${formatGramsAsKg(origGrams)} kg (${origGrams} g)` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Notes</dt>
            <dd className="mt-0.5 whitespace-pre-line text-ink-secondary">
              {original.notes || '—'}
            </dd>
          </div>
        </dl>

        {original.txHash && (
          <div className="border-t border-line pt-2.5 space-y-1">
            <CopyChip label="Tx" value={original.txHash} href={original.explorerUrl} />
            <p className="font-data text-[11px] text-ink-muted">
              {formatTimestampWib(original.anchoredAt)}
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line border-l-4 border-l-chain bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <ArrowRight className="h-4 w-4 text-chain" />
            <span>Append-Only Revision (#{revised.seq})</span>
          </div>
          <Badge tone="chain">Revises #{original.seq}</Badge>
        </div>

        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-ink-muted">Revision Reason</dt>
            <dd className="mt-0.5 font-medium text-ink">
              {revised.reasonCode ? REASON_CODE_LABELS[revised.reasonCode] : '—'}
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-ink-muted">
              <span>Revised Net Weight</span>
              {weightChanged && <Badge tone="chain">Modified</Badge>}
            </dt>
            <dd className="font-data mt-0.5 text-sm font-semibold text-ink">
              {revGrams ? `${formatGramsAsKg(revGrams)} kg (${revGrams} g)` : '—'}
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-ink-muted">
              <span>Justification &amp; Notes</span>
              {notesChanged && <Badge tone="chain">Modified</Badge>}
            </dt>
            <dd className="mt-0.5 whitespace-pre-line text-ink-secondary">
              {revised.notes || '—'}
            </dd>
          </div>
        </dl>

        {revised.txHash && (
          <div className="border-t border-line pt-2.5 space-y-1">
            <CopyChip label="Tx" value={revised.txHash} href={revised.explorerUrl} />
            <p className="font-data text-[11px] text-ink-muted">
              {formatTimestampWib(revised.anchoredAt)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
