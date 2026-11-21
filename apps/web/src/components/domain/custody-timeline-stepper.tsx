import {
  formatGramsAsKg,
  type BatchStatus,
  type ChainStatus,
  type EventType,
  type NormalizedQuantity,
  type ReasonCode,
} from '@traceb3/core';
import { Download, FileText, GitCommitHorizontal, Truck, Factory, PackagePlus, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CopyChip } from './copy-chip';
import {
  EVENT_TYPE_LABELS,
  REASON_CODE_LABELS,
  formatShortHash,
  formatTimestampWib,
} from '@/lib/b3-codes';
import { cn } from '@/lib/cn';

export interface MiniCustodyStepperProps {
  status: BatchStatus;
  hasDiscrepancy?: boolean;
}

export function MiniCustodyStepper({
  status,
  hasDiscrepancy = false,
}: MiniCustodyStepperProps) {
  const stepReached =
    status === 'PENDING_CHAIN'
      ? 0
      : status === 'REGISTERED'
        ? 1
        : status === 'IN_TRANSIT'
          ? 2
          : 3;

  const dotClass = (index: 1 | 2 | 3) => {
    if (stepReached < index) {
      return 'border-line-input bg-surface text-ink-muted';
    }
    if (index === 3 && hasDiscrepancy) {
      return 'border-critical bg-critical text-white';
    }
    if (index === stepReached && status !== 'TREATED' && status !== 'RECEIVED') {
      return 'border-brand bg-brand text-white';
    }
    return 'border-verified bg-verified text-white';
  };

  const labels: Array<{ idx: 1 | 2 | 3; short: string; full: string }> = [
    { idx: 1, short: 'G', full: 'Generator' },
    { idx: 2, short: 'T', full: 'Transporter' },
    { idx: 3, short: 'F', full: 'Facility' },
  ];

  return (
    <div
      className="inline-flex items-center gap-1"
      aria-label={`Custody progress: ${status}`}
    >
      {labels.map((item, i) => (
        <div key={item.short} className="inline-flex items-center gap-1">
          <span
            title={item.full}
            className={cn(
              'font-data inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold',
              dotClass(item.idx),
            )}
          >
            {item.short}
          </span>
          {i < labels.length - 1 && (
            <span
              aria-hidden="true"
              className={cn(
                'h-0.5 w-3 rounded',
                stepReached > item.idx ? 'bg-verified' : 'bg-line',
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export interface TimelineRenderItem {
  id: string;
  seq: number;
  eventType: EventType;
  actorOrgName: string | null;
  fromOrgName: string | null;
  toOrgName: string | null;
  targetSeq: number | null;
  revisedBySeqs?: number[];
  reasonCode: ReasonCode | null;
  chainStatus: ChainStatus;
  txHash: string | null;
  explorerUrl: string | null;
  anchoredAt: string | null;
  eventHash: string;
  quantity?: NormalizedQuantity | null;
  notes?: string | null;
  evidenceCount?: number;
  evidence?: Array<{
    id: string | null;
    sha256: string;
    mime: string;
    size: number;
    label: string;
    filename?: string | null;
  }>;
}

const EVENT_ICONS: Record<EventType, typeof PackagePlus> = {
  CREATED: PackagePlus,
  CUSTODY_TRANSFERRED: Truck,
  REVISION: GitCommitHorizontal,
  TREATMENT: Sparkles,
};

export interface CustodyTimelineListProps {
  events: TimelineRenderItem[];
  onDownloadEvidence?: (evidenceId: string) => void;
  onViewRevisionDiff?: (event: TimelineRenderItem) => void;
}

export function CustodyTimelineList({
  events,
  onDownloadEvidence,
  onViewRevisionDiff,
}: CustodyTimelineListProps) {
  return (
    <ol className="space-y-4">
      {events.map((ev, index) => {
        const Icon =
          ev.eventType === 'CUSTODY_TRANSFERRED' && ev.seq >= 3
            ? Factory
            : EVENT_ICONS[ev.eventType];
        const isLast = index === events.length - 1;
        const isRevision = ev.eventType === 'REVISION';
        const isAnchored = ev.chainStatus === 'ANCHORED';

        return (
          <li key={ev.id} className="relative flex gap-3.5">
            {/* Vertical connector line */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
                  isRevision
                    ? 'border-chain bg-chain-bg text-chain'
                    : isAnchored
                      ? 'border-verified bg-verified-bg text-verified'
                      : 'border-warning bg-warning-bg text-warning',
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              {!isLast && <span className="mt-1 w-0.5 flex-1 bg-line" aria-hidden="true" />}
            </div>

            <div className="min-w-0 flex-1 rounded-xl border border-line bg-surface p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-data rounded bg-well px-1.5 py-0.5 text-xs font-bold text-ink">
                    #{ev.seq}
                  </span>
                  <span className="text-sm font-semibold text-ink">
                    {EVENT_TYPE_LABELS[ev.eventType]}
                  </span>
                  {ev.actorOrgName && (
                    <span className="text-xs text-ink-secondary">
                      · {ev.actorOrgName}
                    </span>
                  )}
                  {isRevision && ev.targetSeq && (
                    <Badge tone="chain">Revises #{ev.targetSeq}</Badge>
                  )}
                  {ev.revisedBySeqs && ev.revisedBySeqs.length > 0 && (
                    <Badge tone="amber">
                      Superseded by #{ev.revisedBySeqs[ev.revisedBySeqs.length - 1]}
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      ev.chainStatus === 'ANCHORED'
                        ? 'verified'
                        : ev.chainStatus === 'FAILED'
                          ? 'critical'
                          : 'warning'
                    }
                    mono
                  >
                    {ev.chainStatus}
                  </Badge>
                  <span className="font-data text-xs text-ink-muted">
                    {formatTimestampWib(ev.anchoredAt)}
                  </span>
                </div>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                {ev.quantity && (
                  <span>
                    <span className="text-ink-muted">Weight: </span>
                    <span className="font-data font-semibold text-ink">
                      {formatGramsAsKg(ev.quantity.grams)} kg
                    </span>
                    <span className="font-data ml-1 text-ink-muted">
                      ({ev.quantity.originalValue} {ev.quantity.originalUnit})
                    </span>
                  </span>
                )}
                {ev.reasonCode && (
                  <span>
                    <span className="text-ink-muted">Reason: </span>
                    <span className="font-medium text-ink">
                      {REASON_CODE_LABELS[ev.reasonCode]}
                    </span>
                  </span>
                )}
                {ev.fromOrgName && ev.toOrgName && ev.fromOrgName !== ev.toOrgName && (
                  <span className="text-ink-secondary">
                    {ev.fromOrgName} → {ev.toOrgName}
                  </span>
                )}
              </div>

              {ev.notes && (
                <p className="mt-2 whitespace-pre-line rounded-lg bg-canvas px-3 py-2 text-xs text-ink-secondary">
                  {ev.notes}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {ev.txHash && (
                  <CopyChip
                    label="Tx"
                    value={ev.txHash}
                    href={ev.explorerUrl}
                  />
                )}
                <CopyChip
                  label="Event SHA-256"
                  value={ev.eventHash}
                  displayValue={formatShortHash(ev.eventHash, 10, 6)}
                />
                {isRevision && onViewRevisionDiff && (
                  <button
                    type="button"
                    onClick={() => onViewRevisionDiff(ev)}
                    className="text-xs font-medium text-chain hover:underline cursor-pointer"
                  >
                    View Revision Diff
                  </button>
                )}
              </div>

              {ev.evidence && ev.evidence.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-2.5">
                  {ev.evidence.map((file, idx) => (
                    <div
                      key={`${ev.id}-file-${idx}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-line bg-well px-2.5 py-1.5 text-xs"
                    >
                      <FileText className="h-3.5 w-3.5 text-brand" />
                      <span className="font-medium text-ink">
                        {file.filename || file.label}
                      </span>
                      <span className="font-data text-[11px] text-ink-muted">
                        {formatShortHash(file.sha256, 8, 6)}
                      </span>
                      {file.id && onDownloadEvidence && (
                        <button
                          type="button"
                          onClick={() => onDownloadEvidence(file.id!)}
                          aria-label={`Download ${file.filename || file.label}`}
                          className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-brand hover:bg-brand-tint cursor-pointer"
                        >
                          <Download className="h-3 w-3" />
                          Download
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
