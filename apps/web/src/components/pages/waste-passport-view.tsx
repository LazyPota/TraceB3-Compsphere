'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatGramsAsKg,
  type BatchStatus,
  type DiscrepancyReport,
  type DiscrepancySeverity,
} from '@traceb3/core';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCheck2,
  GitCommitHorizontal,
  PenLine,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Truck,
  Wallet,
} from 'lucide-react';
import {
  api,
  ApiProblemError,
  type CreateIntentPayload,
  type TimelineEvent,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  BATCH_STATUS_LABELS,
  DISCREPANCY_CODE_LABELS,
  EVENT_TYPE_LABELS,
  formatShortHash,
  formatTimestampWib,
} from '@/lib/b3-codes';
import { parseBatchNotes } from '@/lib/notes';
import { webEnv } from '@/lib/env';
import { AppShell } from '@/components/layout/app-shell';
import { PublicHeader } from '@/components/layout/public-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { CopyChip } from '@/components/domain/copy-chip';
import { HashVerificationBanner } from '@/components/domain/hash-verification-banner';
import { WeightReconciliationBar } from '@/components/domain/weight-reconciliation-bar';
import {
  CustodyTimelineList,
  type TimelineRenderItem,
} from '@/components/domain/custody-timeline-stepper';
import { WastePassportQRCard } from '@/components/domain/waste-passport-qr-card';
import { RevisionDiff } from '@/components/domain/revision-diff';
import {
  Web3TxProgressModal,
  type Web3TxResult,
} from '@/components/domain/web3-tx-progress-modal';
import { cn } from '@/lib/cn';

type PassportTab = 'timeline' | 'proof' | 'revisions';

export type WastePassportViewProps =
  | { mode: 'public'; publicId: string }
  | { mode: 'authenticated'; batchId: string };

interface NormalizedPassportModel {
  batchId: string;
  publicId: string;
  batchRef: string;
  onChainBatchId: string;
  wasteCode: string;
  wasteName: string;
  wasteCategory: string | null;
  status: BatchStatus;
  generatorOrgName: string | null;
  currentCustodianOrgName: string | null;
  hasDiscrepancy: boolean;
  maxDiscrepancySeverity: DiscrepancySeverity;
  declaredWeightGrams: string | null;
  festronikRef: string | null;
  monijaRef: string | null;
  viewLevel: 'full' | 'redacted';
  discrepancies?: DiscrepancyReport;
  events: TimelineRenderItem[];
  rawTimelineEvents?: TimelineEvent[];
}

export function WastePassportView(props: WastePassportViewProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { isAuthenticated, token, member } = useAuth();

  const [tab, setTab] = useState<PassportTab>('timeline');
  const [treatDialogOpen, setTreatDialogOpen] = useState(false);
  const [treatNotes, setTreatNotes] = useState(
    'Neutralization and recovery completed per KLHK SOP',
  );
  const [treatTxOpen, setTreatTxOpen] = useState(false);
  const [treatPayload, setTreatPayload] = useState<CreateIntentPayload | null>(null);

  const isAuthMode = props.mode === 'authenticated';
  const authReady = !isAuthMode || Boolean(isAuthenticated && token);

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  // Public mode data
  const publicQuery = useQuery({
    queryKey: ['public-passport', props.mode === 'public' ? props.publicId : null],
    queryFn: () =>
      api.getPublicPassport(props.mode === 'public' ? props.publicId : ''),
    enabled: props.mode === 'public',
    retry: 1,
  });

  // Authenticated mode data
  const authBatchQuery = useQuery({
    queryKey: ['batch', props.mode === 'authenticated' ? props.batchId : null],
    queryFn: () =>
      api.getBatch(token!, props.mode === 'authenticated' ? props.batchId : ''),
    enabled: props.mode === 'authenticated' && Boolean(isAuthenticated && token),
    retry: 1,
  });

  const authTimelineQuery = useQuery({
    queryKey: ['batch-timeline', props.mode === 'authenticated' ? props.batchId : null],
    queryFn: () =>
      api.getBatchTimeline(
        token!,
        props.mode === 'authenticated' ? props.batchId : '',
      ),
    enabled: props.mode === 'authenticated' && Boolean(isAuthenticated && token),
    retry: 1,
  });

  const authDiscrepanciesQuery = useQuery({
    queryKey: [
      'batch-discrepancies',
      props.mode === 'authenticated' ? props.batchId : null,
    ],
    queryFn: () =>
      api.getBatchDiscrepancies(
        token!,
        props.mode === 'authenticated' ? props.batchId : '',
      ),
    enabled: props.mode === 'authenticated' && Boolean(isAuthenticated && token),
    retry: 1,
  });

  const resolvedPublicId =
    props.mode === 'public'
      ? props.publicId
      : authBatchQuery.data?.publicId ?? null;

  const verifyQuery = useQuery({
    queryKey: ['verify-passport', resolvedPublicId],
    queryFn: () => api.verifyPublicPassport(resolvedPublicId!),
    enabled: Boolean(resolvedPublicId),
    retry: 1,
  });

  // Unify public vs authenticated responses into a single clean view model
  const vm: NormalizedPassportModel | null = (() => {
    if (props.mode === 'public') {
      const p = publicQuery.data;
      if (!p) return null;
      return {
        batchId: p.batchId,
        publicId: p.publicId,
        batchRef: p.batchRef,
        onChainBatchId: p.onChainBatchId,
        wasteCode: p.wasteCode,
        wasteName: p.wasteName,
        wasteCategory: p.wasteCategory,
        status: p.status,
        generatorOrgName: p.generatorOrgName,
        currentCustodianOrgName: p.currentCustodianOrgName,
        hasDiscrepancy: p.hasDiscrepancy,
        maxDiscrepancySeverity: p.maxDiscrepancySeverity,
        declaredWeightGrams: p.declaredWeightGrams ?? null,
        festronikRef: p.festronikRef,
        monijaRef: p.monijaRef,
        viewLevel: p.viewLevel,
        discrepancies: p.discrepancies,
        events: p.events.map((ev) => ({
          id: ev.id,
          seq: ev.seq,
          eventType: ev.eventType,
          actorOrgName: ev.actorOrgName,
          fromOrgName: ev.fromOrgName,
          toOrgName: ev.toOrgName,
          targetSeq: ev.targetSeq,
          reasonCode: ev.reasonCode,
          chainStatus: ev.chainStatus,
          txHash: ev.txHash,
          explorerUrl: ev.explorerUrl,
          anchoredAt: ev.anchoredAt,
          eventHash: ev.eventHash,
          quantity: ev.quantity,
          notes: ev.notes,
          evidenceCount: ev.evidenceCount,
          evidence: ev.evidence,
        })),
      };
    }

    const b = authBatchQuery.data;
    const t = authTimelineQuery.data;
    if (!b || !t) return null;
    return {
      batchId: b.id,
      publicId: b.publicId,
      batchRef: b.batchRef,
      onChainBatchId: b.onChainBatchId,
      wasteCode: b.wasteCode,
      wasteName: b.wasteName,
      wasteCategory: b.wasteCategory,
      status: b.status,
      generatorOrgName: b.generatorOrg?.name ?? null,
      currentCustodianOrgName: b.currentCustodianOrg?.name ?? null,
      hasDiscrepancy: b.hasDiscrepancy,
      maxDiscrepancySeverity: b.maxDiscrepancySeverity,
      declaredWeightGrams: b.declaredWeightGrams,
      festronikRef: b.festronikRef,
      monijaRef: b.monijaRef,
      viewLevel: 'full',
      discrepancies: authDiscrepanciesQuery.data,
      events: t.events.map((ev) => ({
        id: ev.id,
        seq: ev.seq,
        eventType: ev.eventType,
        actorOrgName: ev.actorOrg?.name ?? null,
        fromOrgName: ev.fromOrg?.name ?? null,
        toOrgName: ev.toOrg?.name ?? null,
        targetSeq: ev.targetSeq,
        revisedBySeqs: ev.revisedBySeqs,
        reasonCode: ev.reasonCode,
        chainStatus: ev.chainStatus,
        txHash: ev.txHash,
        explorerUrl: ev.explorerUrl,
        anchoredAt: ev.anchoredAt,
        eventHash: ev.eventHash,
        quantity: ev.quantity,
        notes: ev.record?.notes ?? null,
        evidenceCount: ev.evidence.length,
        evidence: ev.evidence,
      })),
      rawTimelineEvents: t.events,
    };
  })();

  const isLoading =
    props.mode === 'public'
      ? publicQuery.isLoading
      : authReady && (authBatchQuery.isLoading || authTimelineQuery.isLoading);

  const loadError =
    props.mode === 'public'
      ? publicQuery.error
      : authBatchQuery.error ?? authTimelineQuery.error;

  const networkName = chainInfoQuery.data?.networkName ?? 'Base Sepolia';

  const handleDownloadEvidence = async (evidenceId: string) => {
    if (!token) {
      pushToast({
        tone: 'error',
        title: 'Sign in required',
        description: 'Connect your registered wallet to download private evidence files.',
      });
      return;
    }
    try {
      const signed = await api.getEvidenceDownload(token, evidenceId);
      window.open(signed.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Evidence download failed',
        description:
          err instanceof ApiProblemError ? err.userMessage : 'Could not fetch download URL.',
      });
    }
  };

  const handleDownloadProofBundle = async () => {
    if (!vm) return;
    try {
      const bundle = await api.getProofBundle(vm.publicId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `traceb3-proof-bundle-${vm.batchRef}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Failed to export proof bundle',
        description:
          err instanceof ApiProblemError ? err.userMessage : 'Bundle export failed.',
      });
    }
  };

  const handleReverify = () => {
    void verifyQuery.refetch();
    if (props.mode === 'public') {
      void publicQuery.refetch();
    } else {
      void authBatchQuery.refetch();
      void authTimelineQuery.refetch();
      void authDiscrepanciesQuery.refetch();
    }
  };

  const startTreatment = () => {
    if (!vm) return;
    setTreatPayload({
      kind: 'TREATMENT',
      batchId: vm.batchId,
      data: {
        notes: treatNotes.trim() || undefined,
      },
      evidenceIds: [],
    });
    setTreatDialogOpen(false);
    setTreatTxOpen(true);
  };

  const handleTreatmentAnchored = (_result: Web3TxResult) => {
    if (!vm) return;
    void queryClient.invalidateQueries({ queryKey: ['batch', vm.batchId] });
    void queryClient.invalidateQueries({ queryKey: ['batch-timeline', vm.batchId] });
    void queryClient.invalidateQueries({ queryKey: ['verify-passport', vm.publicId] });
    void queryClient.invalidateQueries({ queryKey: ['public-passport', vm.publicId] });
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    pushToast({
      tone: 'success',
      title: 'Treatment recorded on-chain',
      description: `Batch ${vm.batchRef} is now marked TREATED.`,
    });
  };

  const canRevise = Boolean(
    isAuthenticated &&
      member &&
      vm?.rawTimelineEvents?.some(
        (ev) =>
          ev.actorOrgId === member.orgId &&
          ev.chainStatus === 'ANCHORED' &&
          ev.eventType !== 'REVISION',
      ),
  );

  const canPickup = Boolean(
    isAuthenticated && member?.role === 'TRANSPORTER' && vm?.status === 'REGISTERED',
  );
  const canDeliver = Boolean(
    isAuthenticated && member?.role === 'FACILITY' && vm?.status === 'IN_TRANSIT',
  );
  const canTreat = Boolean(
    isAuthenticated && member?.role === 'FACILITY' && vm?.status === 'RECEIVED',
  );

  const createdEvent = vm?.events.find((e) => e.eventType === 'CREATED');
  const parsedNotes = parseBatchNotes(createdEvent?.notes);
  const primaryTx =
    vm?.events
      .slice()
      .reverse()
      .find((e) => e.txHash) ?? null;

  const discrepancyFlags = vm?.discrepancies?.flags.filter(
    (f) => f.severity === 'warning' || f.severity === 'critical',
  ) ?? [];

  const revisionPairs = (() => {
    if (!vm) return [];
    return vm.events
      .filter((ev) => ev.eventType === 'REVISION' && ev.targetSeq !== null)
      .map((rev) => {
        const orig = vm.events.find((e) => e.seq === rev.targetSeq);
        return orig ? { original: orig, revised: rev } : null;
      })
      .filter((x): x is { original: TimelineRenderItem; revised: TimelineRenderItem } =>
        Boolean(x),
      );
  })();

  const content = !authReady ? (
    <Card className="mx-auto max-w-xl">
      <CardContent className="pt-8 pb-8 text-center space-y-4">
        <Wallet className="mx-auto h-10 w-10 text-brand" />
        <h2 className="text-xl font-bold text-ink">Sign In to View Authenticated Batch</h2>
        <p className="text-sm text-ink-secondary">
          Connect your registered organization wallet to access full evidence downloads and
          custody actions.
        </p>
        <Link
          href={`/connect?next=/batches/${props.mode === 'authenticated' ? props.batchId : ''}`}
        >
          <Button variant="primary">Connect &amp; Sign In</Button>
        </Link>
      </CardContent>
    </Card>
  ) : isLoading ? (
    <div className="space-y-4">
      <Skeleton className="h-12 w-full" />
      <div className="grid gap-6 lg:grid-cols-12">
        <Skeleton className="h-72 lg:col-span-8" />
        <Skeleton className="h-72 lg:col-span-4" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  ) : loadError || !vm ? (
    <EmptyState
      icon={<ShieldAlert className="h-6 w-6 text-critical" />}
      title="Digital Waste Passport Not Found"
      description={
        loadError instanceof ApiProblemError
          ? loadError.userMessage
          : 'This passport ID could not be located or you do not have access to this batch.'
      }
      action={
        <div className="flex gap-2">
          <Link href="/audit">
            <Button variant="outline">Open Audit Explorer</Button>
          </Link>
          <Link href="/">
            <Button variant="primary">Home</Button>
          </Link>
        </div>
      }
    />
  ) : (
    <div className="space-y-5">
      {/* Banner 1: Cryptographic Integrity Verification */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-stretch">
        <div className="flex-1">
          {verifyQuery.data ? (
            <HashVerificationBanner
              verdict={verifyQuery.data.verdict}
              networkLabel={networkName}
              affectedEvents={verifyQuery.data.affectedEvents}
              affectedFiles={verifyQuery.data.affectedFiles}
              missingOnChainSeqs={verifyQuery.data.missingOnChainSeqs}
              checkedAt={verifyQuery.data.checkedAt}
            />
          ) : (
            <Skeleton className="h-12 w-full" />
          )}
        </div>
        <Button
          variant="outline"
          size="md"
          loading={verifyQuery.isFetching}
          onClick={handleReverify}
          className="h-auto shrink-0 py-3"
        >
          <RefreshCw className="h-4 w-4" />
          Re-Verify
        </Button>
      </div>

      {/* Banner 2: Conditional Crimson Weight Discrepancy Flag */}
      {vm.hasDiscrepancy && (
        <div
          role="alert"
          className="rounded-xl border border-critical/40 bg-critical px-4 py-3 text-white shadow-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 text-sm font-semibold">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <span>
                Weight Discrepancy Flagged:{' '}
                {discrepancyFlags.length > 0
                  ? discrepancyFlags
                      .map((f) => {
                        const label = DISCREPANCY_CODE_LABELS[f.code];
                        if (f.deltaKg && f.percent !== null) {
                          return `${label} (${f.deltaKg} kg / ${f.percent}%)`;
                        }
                        return label;
                      })
                      .join(' · ')
                  : 'Recorded custody weights exceed tolerance threshold.'}
              </span>
            </div>
            <Badge tone="neutral" className="bg-white/15 text-white border-white/25" mono>
              {vm.maxDiscrepancySeverity.toUpperCase()}
            </Badge>
          </div>
          {discrepancyFlags.some((f) => f.hint) && (
            <p className="mt-1.5 text-xs text-white/90">
              {discrepancyFlags.find((f) => f.hint)?.hint}
            </p>
          )}
        </div>
      )}

      {/* Contextual Role Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
          <span className="font-data font-bold text-ink">{vm.batchRef}</span>
          <span>·</span>
          <Badge tone="amber" mono>
            B3 · {vm.wasteCode}
          </Badge>
          <Badge tone="brand">{BATCH_STATUS_LABELS[vm.status]}</Badge>
          {vm.viewLevel === 'redacted' && (
            <Badge tone="neutral">Public Redacted View</Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canPickup && (
            <Link href={`/handoff/${vm.batchId}`}>
              <Button size="sm" variant="primary">
                <Truck className="h-4 w-4" />
                Sign Pickup Handoff
              </Button>
            </Link>
          )}
          {canDeliver && (
            <Link href={`/handoff/${vm.batchId}`}>
              <Button size="sm" variant="primary">
                <CheckCircle2 className="h-4 w-4" />
                Sign Delivery Intake
              </Button>
            </Link>
          )}
          {canTreat && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setTreatDialogOpen(true)}
            >
              <Sparkles className="h-4 w-4" />
              Record Treatment
            </Button>
          )}
          {canRevise && (
            <Link href={`/batches/${vm.batchId}/revise`}>
              <Button size="sm" variant="outline">
                <PenLine className="h-4 w-4" />
                Submit Revision
              </Button>
            </Link>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleDownloadProofBundle()}
          >
            <Download className="h-4 w-4" />
            Proof Bundle JSON
          </Button>
        </div>
      </div>

      {/* 8 + 4 Identity Grid matching image_e5dba6 */}
      <div className="grid items-start gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-8">
          <CardHeader>
            <CardTitle>Waste Manifest Summary: {vm.batchRef}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2.5 text-xs">
                <div>
                  <span className="text-ink-muted">Waste Classification</span>
                  <p className="mt-0.5 text-sm font-semibold text-ink">
                    {vm.wasteName}
                  </p>
                  <Badge tone="amber" mono className="mt-1">
                    {vm.wasteCode}
                    {vm.wasteCategory ? ` · ${vm.wasteCategory}` : ''}
                  </Badge>
                </div>

                <div>
                  <span className="text-ink-muted">Origin Generator</span>
                  <p className="mt-0.5 font-semibold text-ink">
                    {vm.generatorOrgName ?? 'Registered Generator'}
                  </p>
                </div>

                <div>
                  <span className="text-ink-muted">Current Custodian</span>
                  <p className="mt-0.5 font-semibold text-ink">
                    {vm.currentCustodianOrgName ?? 'Pending Assignment'}
                  </p>
                </div>
              </div>

              <div className="space-y-2.5 text-xs">
                <div>
                  <span className="text-ink-muted">3-Stage Weight Reconciliation</span>
                  <div className="mt-2">
                    {vm.viewLevel === 'redacted' && !vm.discrepancies ? (
                      <p className="rounded-lg border border-line bg-well px-3 py-2 text-ink-secondary">
                        Exact kilogram quantities are redacted on public view;
                        cryptographic hashes remain verifiable.
                      </p>
                    ) : (
                      <WeightReconciliationBar
                        declaredGrams={
                          vm.discrepancies?.effectiveWeights.declaredGrams ??
                          vm.declaredWeightGrams
                        }
                        pickupGrams={
                          vm.discrepancies?.effectiveWeights.pickupGrams ?? null
                        }
                        deliveryGrams={
                          vm.discrepancies?.effectiveWeights.deliveryGrams ?? null
                        }
                        discrepancies={vm.discrepancies}
                      />
                    )}
                  </div>
                </div>

                {(parsedNotes.containerSummary ||
                  parsedNotes.labSummary ||
                  parsedNotes.labReportRef) && (
                  <div className="rounded-lg border border-line bg-canvas p-3 space-y-1">
                    <p className="font-semibold text-ink">
                      Containers &amp; Lab Parameters
                    </p>
                    {parsedNotes.containerSummary && (
                      <p className="text-ink-secondary">
                        Containers: {parsedNotes.containerSummary}
                      </p>
                    )}
                    {parsedNotes.labSummary && (
                      <p className="text-ink-secondary">
                        Lab Parameters: {parsedNotes.labSummary}
                      </p>
                    )}
                    {parsedNotes.labReportRef && (
                      <p className="font-data text-ink-secondary">
                        Lab Ref: {parsedNotes.labReportRef}
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <span className="text-ink-muted">Regulatory &amp; External References</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {vm.festronikRef && (
                      <Badge tone="neutral" mono>
                        Festronik: {vm.festronikRef}
                      </Badge>
                    )}
                    {vm.monijaRef && (
                      <Badge tone="neutral" mono>
                        MONIJA: {vm.monijaRef}
                      </Badge>
                    )}
                    <Link
                      href={`/p/${vm.publicId}`}
                      className="font-data inline-flex items-center gap-1 text-chain hover:underline"
                    >
                      /p/{vm.publicId}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-4">
          <WastePassportQRCard
            batchId={isAuthMode ? vm.batchId : undefined}
            publicId={vm.publicId}
            batchRef={vm.batchRef}
            wasteCode={vm.wasteCode}
            wasteName={vm.wasteName}
            txHash={primaryTx?.txHash ?? null}
            explorerUrl={primaryTx?.explorerUrl}
            networkLabel={networkName}
            token={token}
          />
        </div>
      </div>

      {/* Tabbed Forensic Timeline, Proofs & Revisions */}
      <Card>
        <CardHeader>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'timeline',
                label: 'Custody Chain Timeline',
                count: vm.events.length,
              },
              {
                id: 'proof',
                label: 'Cryptographic Proof & Evidence',
                count: verifyQuery.data?.events.length ?? vm.events.length,
              },
              {
                id: 'revisions',
                label: 'Append-Only Revisions',
                count: revisionPairs.length,
              },
            ]}
          />
        </CardHeader>
        <CardContent>
          {tab === 'timeline' && (
            <CustodyTimelineList
              events={vm.events}
              onDownloadEvidence={
                isAuthenticated ? (id) => void handleDownloadEvidence(id) : undefined
              }
              onViewRevisionDiff={() => setTab('revisions')}
            />
          )}

          {tab === 'proof' && (
            <div className="space-y-4">
              {verifyQuery.data ? (
                <>
                  <div className="overflow-x-auto rounded-xl border border-line">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-line bg-canvas text-ink-secondary">
                        <tr>
                          <th className="px-3.5 py-2.5 font-semibold">Seq</th>
                          <th className="px-3.5 py-2.5 font-semibold">Event Type</th>
                          <th className="px-3.5 py-2.5 font-semibold">Recomputed SHA-256</th>
                          <th className="px-3.5 py-2.5 font-semibold">On-Chain Hash</th>
                          <th className="px-3.5 py-2.5 font-semibold">Files</th>
                          <th className="px-3.5 py-2.5 font-semibold">Verdict</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {verifyQuery.data.events.map((ev) => (
                          <tr key={ev.eventId}>
                            <td className="font-data px-3.5 py-2.5 font-bold">
                              #{ev.seq}
                            </td>
                            <td className="px-3.5 py-2.5">
                              {EVENT_TYPE_LABELS[ev.eventType]}
                            </td>
                            <td className="font-data px-3.5 py-2.5">
                              {formatShortHash(ev.recomputedHash, 10, 8)}
                            </td>
                            <td className="font-data px-3.5 py-2.5">
                              {ev.onChainHash ? (
                                formatShortHash(ev.onChainHash, 10, 8)
                              ) : (
                                <span className="text-ink-muted">Pending</span>
                              )}
                            </td>
                            <td className="font-data px-3.5 py-2.5">
                              {ev.filesChecked} checked
                            </td>
                            <td className="px-3.5 py-2.5">
                              <Badge
                                tone={
                                  ev.verdict === 'MATCH'
                                    ? 'verified'
                                    : ev.verdict === 'NOT_YET_ANCHORED'
                                      ? 'warning'
                                      : 'critical'
                                }
                                mono
                              >
                                {ev.verdict}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {verifyQuery.data.affectedFiles.length > 0 && (
                    <div className="rounded-xl border border-critical/35 bg-critical-bg p-4 space-y-2 text-xs">
                      <p className="font-bold text-critical-fg">
                        Tampered / Missing Evidence Files
                      </p>
                      {verifyQuery.data.affectedFiles.map((f, idx) => (
                        <div
                          key={`${f.eventId}-${idx}`}
                          className="rounded-lg border border-critical/25 bg-surface p-2.5"
                        >
                          <p className="font-semibold text-ink">
                            Event #{f.seq} · {f.filename} ({f.issue})
                          </p>
                          <p className="font-data text-[11px] text-ink-secondary">
                            Expected: {f.expectedSha256}
                          </p>
                          <p className="font-data text-[11px] text-critical">
                            Actual: {f.actualSha256 ?? 'FILE MISSING IN STORAGE'}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2 text-xs text-ink-secondary">
                  <FileCheck2 className="h-4 w-4" />
                  Loading live cryptographic verification breakdown...
                </div>
              )}
            </div>
          )}

          {tab === 'revisions' && (
            <div className="space-y-4">
              {revisionPairs.length === 0 ? (
                <EmptyState
                  icon={<GitCommitHorizontal className="h-5 w-5" />}
                  title="No Append-Only Revisions Recorded"
                  description="If an actor corrects a weight or manifest note later, the original record remains preserved here alongside the cryptographically linked revision."
                />
              ) : (
                revisionPairs.map((pair) => (
                  <RevisionDiff
                    key={pair.revised.id}
                    wasteCode={vm.wasteCode}
                    wasteName={vm.wasteName}
                    original={{
                      seq: pair.original.seq,
                      quantity: pair.original.quantity ?? null,
                      notes: pair.original.notes ?? null,
                      reasonCode: pair.original.reasonCode,
                      txHash: pair.original.txHash,
                      explorerUrl: pair.original.explorerUrl,
                      anchoredAt: pair.original.anchoredAt,
                    }}
                    revised={{
                      seq: pair.revised.seq,
                      quantity: pair.revised.quantity ?? null,
                      notes: pair.revised.notes ?? null,
                      reasonCode: pair.revised.reasonCode,
                      txHash: pair.revised.txHash,
                      explorerUrl: pair.revised.explorerUrl,
                      anchoredAt: pair.revised.anchoredAt,
                    }}
                  />
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Treatment Completion Notes Modal */}
      <Dialog
        open={treatDialogOpen}
        onClose={() => setTreatDialogOpen(false)}
        title="Record Final Waste Treatment"
        description={`Transitions batch ${vm.batchRef} to TREATED and anchors completion on ${networkName}.`}
      >
        <div className="space-y-4">
          <div>
            <label
              htmlFor="treatmentNotes"
              className="mb-1.5 block text-xs font-semibold text-ink-secondary"
            >
              Treatment / Recovery Method Notes
            </label>
            <Textarea
              id="treatmentNotes"
              rows={3}
              value={treatNotes}
              onChange={(e) => setTreatNotes(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setTreatDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={startTreatment}>
              Sign &amp; Anchor Treatment
            </Button>
          </div>
        </div>
      </Dialog>

      <Web3TxProgressModal
        open={treatTxOpen}
        onClose={() => setTreatTxOpen(false)}
        title="Sign Treatment Completion"
        token={token}
        intentPayload={treatPayload}
        onAnchored={handleTreatmentAnchored}
        successActionLabel="Done"
        onSuccessAction={() => {
          setTreatTxOpen(false);
          router.refresh();
        }}
      />
    </div>
  );

  if (props.mode === 'public' && !isAuthenticated) {
    return (
      <div className="min-h-dvh bg-canvas text-ink">
        <PublicHeader />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {content}
        </main>
      </div>
    );
  }

  return (
    <AppShell
      title={vm ? `Digital Waste Passport · ${vm.batchRef}` : 'Digital Waste Passport'}
      chainLabel={networkName}
    >
      {content}
    </AppShell>
  );
}
