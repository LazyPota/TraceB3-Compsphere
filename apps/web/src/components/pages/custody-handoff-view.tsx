'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatGramsAsKg, normalizeWeightToGrams, type WeightUnit } from '@traceb3/core';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  PenLine,
  ShieldCheck,
  Truck,
  Wallet,
} from 'lucide-react';
import { api, ApiProblemError, type CreateIntentPayload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ACTOR_ROLE_LABELS, BATCH_STATUS_LABELS } from '@/lib/b3-codes';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { DiscrepancyDeltaMeter } from '@/components/domain/discrepancy-delta-meter';
import {
  EvidenceDropzone,
  type UploadedEvidenceItem,
} from '@/components/domain/evidence-dropzone';
import {
  Web3TxProgressModal,
  type Web3TxResult,
} from '@/components/domain/web3-tx-progress-modal';

export function CustodyHandoffView({ batchId }: { batchId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, token, member } = useAuth();

  const [observedWeight, setObservedWeight] = useState('');
  const [unit, setUnit] = useState<WeightUnit>('kg');
  const [notes, setNotes] = useState('');
  const [photoEvidence, setPhotoEvidence] = useState<UploadedEvidenceItem | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
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

  const discrepanciesQuery = useQuery({
    queryKey: ['batch-discrepancies', batchId],
    queryFn: () => api.getBatchDiscrepancies(token!, batchId),
    enabled: Boolean(isAuthenticated && token),
    retry: 1,
  });

  const batch = batchQuery.data;
  const discrepancies = discrepanciesQuery.data;
  const networkName = chainInfoQuery.data?.networkName ?? 'Base Sepolia';

  const isPickup = Boolean(
    member?.role === 'TRANSPORTER' && batch?.status === 'REGISTERED',
  );
  const isDelivery = Boolean(
    member?.role === 'FACILITY' && batch?.status === 'IN_TRANSIT',
  );
  const isTreatment = Boolean(
    member?.role === 'FACILITY' && batch?.status === 'RECEIVED',
  );
  const canAct = isPickup || isDelivery || isTreatment;

  const expectedGrams = isPickup
    ? discrepancies?.effectiveWeights.declaredGrams ?? batch?.declaredWeightGrams ?? null
    : discrepancies?.effectiveWeights.pickupGrams ??
      discrepancies?.effectiveWeights.declaredGrams ??
      batch?.declaredWeightGrams ??
      null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!batch || !canAct) return;

    if (isTreatment) {
      setPendingPayload({
        kind: 'TREATMENT',
        batchId,
        data: {
          notes:
            notes.trim() || 'Neutralization and recovery completed per KLHK SOP',
        },
        evidenceIds: photoEvidence ? [photoEvidence.id] : [],
      });
      setTxOpen(true);
      return;
    }

    try {
      normalizeWeightToGrams(observedWeight.trim(), unit);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Enter a valid positive weight.',
      );
      return;
    }

    setPendingPayload({
      kind: 'CUSTODY_TRANSFERRED',
      batchId,
      data: {
        quantity: { value: observedWeight.trim(), unit },
        notes: notes.trim() || undefined,
      },
      evidenceIds: photoEvidence ? [photoEvidence.id] : [],
    });
    setTxOpen(true);
  };

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
    <AppShell title="Mobile Custody Handoff" chainLabel={networkName}>
      <div className="mx-auto max-w-[600px] space-y-5">
        {!isAuthenticated || !token || !member ? (
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <Wallet className="mx-auto h-10 w-10 text-brand" />
              <h2 className="text-xl font-bold text-ink">Sign In to Confirm Handoff</h2>
              <p className="text-sm text-ink-secondary">
                Connect your Transporter or Facility wallet to sign this custody handoff
                with $0 gas fees.
              </p>
              <Link href={`/connect?next=/handoff/${batchId}`}>
                <Button size="lg" variant="primary" className="w-full sm:w-auto">
                  Connect &amp; Sign In
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : batchQuery.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : batchQuery.error || !batch ? (
          <Card className="border-critical/35">
            <CardContent className="pt-6 space-y-3 text-sm">
              <p className="font-semibold text-critical">Could not load batch for handoff</p>
              <p className="text-ink-secondary">
                {batchQuery.error instanceof ApiProblemError
                  ? batchQuery.error.userMessage
                  : 'Verify the batch UUID and try again.'}
              </p>
              <Link href="/scan">
                <Button variant="outline">Back to QR Scanner</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Read-only Declared Cargo Reference */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>Declared Cargo Reference</CardTitle>
                  <Badge tone="amber" mono>
                    {batch.wasteCode}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted">Batch Reference</span>
                  <span className="font-data font-bold text-ink">{batch.batchRef}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted">Waste Classification</span>
                  <span className="font-semibold text-ink">{batch.wasteName}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted">Origin Generator</span>
                  <span className="font-medium text-ink">
                    {batch.generatorOrg?.name ?? 'Registered Generator'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted">Current Stage</span>
                  <Badge tone="brand">{BATCH_STATUS_LABELS[batch.status]}</Badge>
                </div>
                {expectedGrams && (
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-well px-3 py-2">
                    <span className="font-medium text-ink-secondary">
                      Expected Cargo Weight
                    </span>
                    <span className="font-data text-sm font-bold text-ink">
                      {formatGramsAsKg(expectedGrams)} kg ({expectedGrams} g)
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {!canAct ? (
              <Card className="border-warning/35">
                <CardContent className="pt-6 space-y-4 text-sm">
                  <div className="flex items-start gap-2.5">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                    <div>
                      <p className="font-semibold text-ink">
                        No Handoff Action Available for Your Role
                      </p>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Signed in as{' '}
                        <strong className="text-ink">
                          {ACTOR_ROLE_LABELS[member.role]}
                        </strong>
                        , while batch{' '}
                        <span className="font-data font-semibold">{batch.batchRef}</span> is
                        currently in{' '}
                        <strong className="text-ink">
                          {BATCH_STATUS_LABELS[batch.status]}
                        </strong>
                        .
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/batches/${batch.id}`} className="flex-1">
                      <Button variant="primary" size="lg" className="w-full">
                        Inspect Waste Passport
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Truck className="h-5 w-5 text-brand" />
                    <CardTitle>
                      {isPickup
                        ? 'Fleet Pickup Verification'
                        : isDelivery
                          ? 'Weighbridge Intake Verification'
                          : 'Treatment Completion Sign-Off'}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    {!isTreatment && (
                      <>
                        <div>
                          <label
                            htmlFor="observedWeight"
                            className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                          >
                            Observed Physical Weight
                          </label>
                          <div className="flex gap-2">
                            <Input
                              id="observedWeight"
                              inputMode="decimal"
                              value={observedWeight}
                              onChange={(e) => setObservedWeight(e.target.value)}
                              placeholder="e.g. 850 or 620"
                              className="font-data h-12 flex-1 text-base font-semibold"
                              required
                            />
                            <Select
                              aria-label="Observed weight unit"
                              value={unit}
                              onChange={(e) => setUnit(e.target.value as WeightUnit)}
                              className="font-data h-12 w-24 text-base"
                            >
                              <option value="kg">kg</option>
                              <option value="g">g</option>
                              <option value="ton">ton</option>
                            </Select>
                          </div>
                        </div>

                        <DiscrepancyDeltaMeter
                          expectedGrams={expectedGrams}
                          observedValue={observedWeight}
                          observedUnit={unit}
                        />
                      </>
                    )}

                    <EvidenceDropzone
                      token={token}
                      batchIdOrStaging={batchId}
                      label={
                        isPickup
                          ? 'Pickup Weighbridge Photo'
                          : isDelivery
                            ? 'Intake Weighbridge Photo'
                            : 'Treatment Completion Record'
                      }
                      title="Attach Field Photo / Receipt (Optional)"
                      description="JPEG, PNG, WebP, or PDF (max 10 MB)"
                      enableCameraCapture
                      value={photoEvidence}
                      onChange={setPhotoEvidence}
                    />

                    <div>
                      <label
                        htmlFor="handoffNotes"
                        className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                      >
                        {isTreatment ? 'Treatment Method Notes' : 'Handoff Remarks'}
                      </label>
                      <Textarea
                        id="handoffNotes"
                        rows={2}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder={
                          isPickup
                            ? 'Vehicle plate, driver seal verification...'
                            : isDelivery
                              ? 'Weighbridge scale ID or variance remarks...'
                              : 'Neutralization & recovery completed per KLHK SOP...'
                        }
                      />
                    </div>

                    {formError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-lg border border-critical/35 bg-critical-bg px-3 py-2 text-xs text-critical-fg"
                      >
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-critical" />
                        <span>{formError}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2 text-xs">
                      <span className="text-ink-secondary">Gas Fee</span>
                      <span className="inline-flex items-center gap-1 font-semibold text-verified-fg">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        $0 (Sponsored via Relayer)
                      </span>
                    </div>

                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      className="h-12 w-full text-base"
                    >
                      <PenLine className="h-4 w-4" />
                      {isTreatment
                        ? 'Sign & Record Treatment Completion'
                        : 'Sign & Confirm Custody Handoff'}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>

      <Web3TxProgressModal
        open={txOpen}
        onClose={() => setTxOpen(false)}
        title={isTreatment ? 'Sign Treatment Completion' : 'Sign Custody Handoff'}
        token={token}
        intentPayload={pendingPayload}
        onAnchored={handleAnchored}
        successActionLabel="Inspect Waste Passport"
        onSuccessAction={() => {
          setTxOpen(false);
          router.push(`/batches/${batchId}`);
        }}
      />
    </AppShell>
  );
}
