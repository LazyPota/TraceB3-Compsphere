'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatGramsAsKg,
  normalizeWeightToGrams,
  REASON_CODES,
  type ReasonCode,
  type WeightUnit,
} from '@traceb3/core';
import { Info, Lock, PenLine, ShieldAlert, Wallet } from 'lucide-react';
import {
  api,
  type BatchSummary,
  type CreateIntentPayload,
  type TimelineEvent,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  EVENT_TYPE_LABELS,
  REASON_CODE_LABELS,
  formatTimestampWib,
} from '@/lib/b3-codes';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyChip } from '@/components/domain/copy-chip';
import {
  EvidenceDropzone,
  type UploadedEvidenceItem,
} from '@/components/domain/evidence-dropzone';
import {
  Web3TxProgressModal,
  type Web3TxResult,
} from '@/components/domain/web3-tx-progress-modal';
import { cn } from '@/lib/cn';

function ReviseEditor({
  batch,
  targetEvent,
  token,
  eligibleEvents,
  selectedSeq,
  onSelectSeq,
  onSubmitPayload,
}: {
  batch: BatchSummary;
  targetEvent: TimelineEvent;
  token: string;
  eligibleEvents: TimelineEvent[];
  selectedSeq: number;
  onSelectSeq: (seq: number) => void;
  onSubmitPayload: (payload: CreateIntentPayload) => void;
}) {
  const initialVal =
    targetEvent.quantity?.originalValue ??
    (targetEvent.quantity ? formatGramsAsKg(targetEvent.quantity.grams) : '0');
  const initialUnit: WeightUnit = targetEvent.quantity?.originalUnit ?? 'kg';
  const initialNotes = targetEvent.record?.notes ?? '';

  const [weightValue, setWeightValue] = useState(initialVal);
  const [weightUnit, setWeightUnit] = useState<WeightUnit>(initialUnit);
  const [reasonCode, setReasonCode] = useState<ReasonCode | ''>('');
  const [notes, setNotes] = useState(initialNotes);
  const [evidence, setEvidence] = useState<UploadedEvidenceItem | null>(null);

  const normalizedWeight = useMemo(() => {
    if (!weightValue.trim()) return { normalized: null, error: 'Enter net weight' };
    try {
      return {
        normalized: normalizeWeightToGrams(weightValue.trim(), weightUnit),
        error: null,
      };
    } catch (err) {
      return {
        normalized: null,
        error: err instanceof Error ? err.message : 'Invalid weight',
      };
    }
  }, [weightValue, weightUnit]);

  const origGrams = targetEvent.quantity?.grams ?? null;
  const weightModified = Boolean(
    normalizedWeight.normalized && normalizedWeight.normalized.grams !== origGrams,
  );
  const notesModified = notes.trim() !== initialNotes.trim();
  const hasAnyChange = weightModified || notesModified || evidence !== null;
  const canSubmit = Boolean(
    hasAnyChange && reasonCode && normalizedWeight.normalized,
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !reasonCode || !normalizedWeight.normalized) return;
    onSubmitPayload({
      kind: 'REVISION',
      batchId: batch.id,
      data: {
        targetSeq: targetEvent.seq,
        reasonCode,
        quantity: { value: weightValue.trim(), unit: weightUnit },
        notes: notes.trim() || undefined,
      },
      evidenceIds: evidence ? [evidence.id] : [],
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 pb-20">
      {eligibleEvents.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-xs">
          <span className="font-semibold text-ink">
            Select Your Anchored Custody Event to Revise:
          </span>
          <Select
            aria-label="Target event sequence"
            value={String(selectedSeq)}
            onChange={(e) => onSelectSeq(Number(e.target.value))}
            className="w-full sm:w-80"
          >
            {eligibleEvents.map((ev) => (
              <option key={ev.id} value={ev.seq}>
                #{ev.seq} · {EVENT_TYPE_LABELS[ev.eventType]} (
                {ev.quantity ? `${formatGramsAsKg(ev.quantity.grams)} kg` : 'No weight'})
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Locked Previous Anchored Record */}
        <Card className="bg-well/80">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-base font-bold text-ink">
                <Lock className="h-4 w-4 text-ink-secondary" />
                <span>Previous Anchored Record (#{targetEvent.seq})</span>
              </div>
              <Badge tone="neutral">Immutable Original</Badge>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-ink-muted">Indonesian B3 Waste Code</span>
                <div className="font-data mt-1 rounded-lg border border-line bg-well px-3 py-2 font-semibold text-ink">
                  {batch.wasteCode}
                </div>
              </div>

              <div>
                <span className="text-ink-muted">Waste Description</span>
                <div className="mt-1 rounded-lg border border-line bg-well px-3 py-2 font-medium text-ink">
                  {batch.wasteName}
                </div>
              </div>

              <div>
                <span className="text-ink-muted">Recorded Net Weight</span>
                <div className="font-data mt-1 rounded-lg border border-line bg-well px-3 py-2 font-semibold text-ink">
                  {origGrams
                    ? `${formatGramsAsKg(origGrams)} kg (${origGrams} g)`
                    : '—'}
                </div>
              </div>

              <div>
                <span className="text-ink-muted">Origin Organization</span>
                <div className="mt-1 rounded-lg border border-line bg-well px-3 py-2 text-ink">
                  {targetEvent.actorOrg?.name ?? 'Registered Organization'}
                </div>
              </div>

              <div>
                <span className="text-ink-muted">Original Notes</span>
                <div className="mt-1 min-h-14 whitespace-pre-line rounded-lg border border-line bg-well px-3 py-2 text-ink-secondary">
                  {initialNotes || '—'}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-3.5 space-y-2 text-xs">
              <p className="font-semibold text-ink">
                #{targetEvent.seq} On-Chain Proof
              </p>
              {targetEvent.txHash && (
                <CopyChip
                  label="TxHash"
                  value={targetEvent.txHash}
                  href={targetEvent.explorerUrl}
                />
              )}
              <p className="font-data text-[11px] text-ink-muted">
                Anchored: {formatTimestampWib(targetEvent.anchoredAt)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Right: Editable Proposed Revision */}
        <Card className="border-l-4 border-l-chain">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-ink">
                Proposed Append-Only Revision
              </h2>
              <Badge tone="chain">Links to #{targetEvent.seq}</Badge>
            </div>

            <div className="space-y-3.5 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <span className="text-ink-muted">B3 Waste Code (Locked)</span>
                  <Input value={batch.wasteCode} disabled className="font-data mt-1" />
                </div>
                <div>
                  <span className="text-ink-muted">Waste Description (Locked)</span>
                  <Input value={batch.wasteName} disabled className="mt-1" />
                </div>
              </div>

              <div
                className={cn(
                  'rounded-lg p-2.5 transition-colors',
                  weightModified && 'border-l-4 border-l-chain bg-chain-bg/40',
                )}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label
                    htmlFor="revWeight"
                    className="font-semibold text-ink-secondary"
                  >
                    Revised Net Weight
                  </label>
                  {weightModified && <Badge tone="chain">Modified</Badge>}
                </div>
                <div className="flex gap-2">
                  <Input
                    id="revWeight"
                    inputMode="decimal"
                    value={weightValue}
                    onChange={(e) => setWeightValue(e.target.value)}
                    className="font-data flex-1"
                    required
                  />
                  <Select
                    aria-label="Revised weight unit"
                    value={weightUnit}
                    onChange={(e) => setWeightUnit(e.target.value as WeightUnit)}
                    className="font-data w-24"
                  >
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="ton">ton</option>
                  </Select>
                </div>
                {normalizedWeight.normalized ? (
                  <p className="font-data mt-1 text-[11px] text-ink-muted">
                    Previous (#{targetEvent.seq}):{' '}
                    {origGrams ? `${formatGramsAsKg(origGrams)} kg` : '—'} → New:{' '}
                    {formatGramsAsKg(normalizedWeight.normalized.grams)} kg (
                    {normalizedWeight.normalized.grams} g)
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-critical">
                    {normalizedWeight.error}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="reasonCode"
                  className="mb-1.5 block font-semibold text-ink-secondary"
                >
                  Revision Reason <span className="text-critical">*</span>
                </label>
                <Select
                  id="reasonCode"
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as ReasonCode)}
                  required
                >
                  <option value="">Select revision reason...</option>
                  {REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {REASON_CODE_LABELS[code]}
                    </option>
                  ))}
                </Select>
              </div>

              <div
                className={cn(
                  'rounded-lg p-2.5 transition-colors',
                  notesModified && 'border-l-4 border-l-chain bg-chain-bg/40',
                )}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label
                    htmlFor="revNotes"
                    className="font-semibold text-ink-secondary"
                  >
                    Justification Note
                  </label>
                  {notesModified && <Badge tone="chain">Modified</Badge>}
                </div>
                <Textarea
                  id="revNotes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Document scale calibration certificate or reason for amendment..."
                />
              </div>

              <div>
                <span className="mb-1.5 block font-semibold text-ink-secondary">
                  Updated Supporting Evidence (Optional)
                </span>
                <EvidenceDropzone
                  token={token}
                  batchIdOrStaging={batch.id}
                  label="Revision Supporting Document"
                  title="Attach Calibration / Amended Manifest"
                  description="PDF, JPEG, PNG, or WebP (max 10 MB)"
                  value={evidence}
                  onChange={setEvidence}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sticky Bottom Diff & Submit Bar */}
      <div className="sticky bottom-16 md:bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur-sm">
        <div className="space-y-0.5 text-xs">
          <p className="font-data font-semibold text-ink">
            Net Weight:{' '}
            {origGrams ? `${formatGramsAsKg(origGrams)} kg` : '—'} →{' '}
            {normalizedWeight.normalized
              ? `${formatGramsAsKg(normalizedWeight.normalized.grams)} kg`
              : '—'}
          </p>
          <p className="text-ink-secondary">
            {hasAnyChange
              ? reasonCode
                ? `Reason: ${REASON_CODE_LABELS[reasonCode]}`
                : 'Select a mandatory Revision Reason to enable signing'
              : 'Modify Net Weight, Justification Note, or attach evidence to submit'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link href={`/batches/${batch.id}`}>
            <Button type="button" variant="outline" size="md">
              Cancel
            </Button>
          </Link>
          <Button type="submit" variant="primary" size="md" disabled={!canSubmit}>
            <PenLine className="h-4 w-4" />
            Sign &amp; Anchor Revision
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ReviseBatchView({ batchId }: { batchId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, token, member } = useAuth();

  const [selectedSeqOverride, setSelectedSeqOverride] = useState<number | null>(null);
  const [txOpen, setTxOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<CreateIntentPayload | null>(null);

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const batchQuery = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => api.getBatch(token!, batchId),
    enabled: Boolean(isAuthenticated && token),
    retry: 1,
  });

  const timelineQuery = useQuery({
    queryKey: ['batch-timeline', batchId],
    queryFn: () => api.getBatchTimeline(token!, batchId),
    enabled: Boolean(isAuthenticated && token),
    retry: 1,
  });

  const batch = batchQuery.data;
  const timeline = timelineQuery.data;
  const eligibleEvents = useMemo(() => {
    if (!timeline || !member) return [];
    return timeline.events.filter(
      (ev) =>
        ev.actorOrgId === member.orgId &&
        ev.chainStatus === 'ANCHORED' &&
        ev.eventType !== 'REVISION',
    );
  }, [timeline, member]);

  const targetEvent =
    eligibleEvents.find((e) => e.seq === selectedSeqOverride) ??
    eligibleEvents[eligibleEvents.length - 1] ??
    null;

  const handleAnchored = (_res: Web3TxResult) => {
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    void queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    void queryClient.invalidateQueries({ queryKey: ['batch-timeline', batchId] });
    void queryClient.invalidateQueries({ queryKey: ['batch-discrepancies', batchId] });
    if (batch) {
      void queryClient.invalidateQueries({ queryKey: ['verify-passport', batch.publicId] });
      void queryClient.invalidateQueries({ queryKey: ['public-passport', batch.publicId] });
    }
  };

  return (
    <AppShell
      title="Append-Only Record Revision"
      chainLabel={chainInfoQuery.data?.networkName}
    >
      {!isAuthenticated || !token || !member ? (
        <Card className="mx-auto max-w-xl">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <Wallet className="mx-auto h-10 w-10 text-brand" />
            <h2 className="text-xl font-bold text-ink">Sign In to Submit Revision</h2>
            <Link href={`/connect?next=/batches/${batchId}/revise`}>
              <Button variant="primary">Connect &amp; Sign In</Button>
            </Link>
          </CardContent>
        </Card>
      ) : batchQuery.isLoading || timelineQuery.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : !batch || !timeline ? (
        <Card className="border-critical/35">
          <CardContent className="pt-6 space-y-3 text-sm">
            <p className="font-semibold text-critical">Unable to load batch timeline</p>
            <Link href="/dashboard">
              <Button variant="outline">Back to Dashboard</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          <nav aria-label="Breadcrumb" className="text-xs text-ink-secondary">
            <Link href="/dashboard" className="hover:text-ink">
              Dashboard
            </Link>
            <span className="mx-1.5">/</span>
            <Link href={`/batches/${batch.id}`} className="hover:text-ink">
              Passport {batch.batchRef}
            </Link>
            <span className="mx-1.5">/</span>
            <span className="font-medium text-ink">Submit Append-Only Revision</span>
          </nav>

          {/* Full-Width Cobalt Append-Only Policy Banner */}
          <div className="flex items-start gap-2.5 rounded-xl bg-chain px-4 py-3 text-sm text-white shadow-xs">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>Append-Only Policy:</strong> Submitting a revision creates a new
              record cryptographically linked to the original anchored event. Original
              records remain permanently visible for regulatory audits.
            </p>
          </div>

          {!targetEvent ? (
            <Card className="border-warning/35">
              <CardContent className="pt-6 space-y-3 text-sm">
                <div className="flex items-start gap-2.5">
                  <ShieldAlert className="mt-0.5 h-5 w-5 text-warning" />
                  <div>
                    <p className="font-semibold text-ink">
                      No Eligible Anchored Events for Your Organization
                    </p>
                    <p className="mt-1 text-xs text-ink-secondary">
                      An organization can only submit an append-only revision targeting one
                      of its own previously anchored custody events.
                    </p>
                  </div>
                </div>
                <Link href={`/batches/${batch.id}`}>
                  <Button variant="outline">Back to Passport</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <ReviseEditor
              key={targetEvent.id}
              batch={batch}
              targetEvent={targetEvent}
              token={token}
              eligibleEvents={eligibleEvents}
              selectedSeq={targetEvent.seq}
              onSelectSeq={setSelectedSeqOverride}
              onSubmitPayload={(payload) => {
                setPendingPayload(payload);
                setTxOpen(true);
              }}
            />
          )}
        </div>
      )}

      <Web3TxProgressModal
        open={txOpen}
        onClose={() => setTxOpen(false)}
        title="Sign & Anchor Append-Only Revision"
        token={token}
        intentPayload={pendingPayload}
        onAnchored={handleAnchored}
        successActionLabel="Inspect Updated Passport"
        onSuccessAction={() => {
          setTxOpen(false);
          router.push(`/batches/${batchId}`);
        }}
      />
    </AppShell>
  );
}
