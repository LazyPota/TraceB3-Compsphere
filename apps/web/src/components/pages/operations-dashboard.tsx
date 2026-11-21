'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Plus,
  QrCode,
  ShieldCheck,
  Truck,
  Wallet,
} from 'lucide-react';
import { formatGramsAsKg, type BatchStatus } from '@traceb3/core';
import { api, type BatchSummary } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BATCH_STATUS_LABELS, formatShortHash, formatTimestampWib } from '@/lib/b3-codes';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, type TabOption } from '@/components/ui/tabs';
import { CopyChip } from '@/components/domain/copy-chip';
import { MiniCustodyStepper } from '@/components/domain/custody-timeline-stepper';
import { cn } from '@/lib/cn';

type DashboardTab =
  | 'ALL'
  | 'FLAGGED'
  | 'REGISTERED'
  | 'IN_TRANSIT'
  | 'RECEIVED'
  | 'TREATED';

function useBatchRowLiveMetrics({
  batch,
  token,
}: {
  batch: BatchSummary;
  token: string;
}) {
  const discQuery = useQuery({
    queryKey: ['batch-discrepancies', batch.id],
    queryFn: () => api.getBatchDiscrepancies(token, batch.id),
    staleTime: 30_000,
    retry: 1,
  });

  const verifyQuery = useQuery({
    queryKey: ['verify-passport', batch.publicId],
    queryFn: () => api.verifyPublicPassport(batch.publicId),
    staleTime: 30_000,
    retry: 1,
  });

  const weights = discQuery.data?.effectiveWeights;
  const declared = weights?.declaredGrams ?? batch.declaredWeightGrams;
  const pickup = weights?.pickupGrams ?? null;
  const delivery = weights?.deliveryGrams ?? null;

  const progressionParts: string[] = [];
  if (declared) progressionParts.push(formatGramsAsKg(declared));
  if (pickup) progressionParts.push(formatGramsAsKg(pickup));
  if (delivery) progressionParts.push(formatGramsAsKg(delivery));

  const deltaFlag = discQuery.data?.flags.find(
    (f) => f.code === 'WEIGHT_MISMATCH_TOTAL' || f.code === 'WEIGHT_MISMATCH_DELIVERY',
  );
  const signedDelta = (() => {
    if (!declared || !delivery) return null;
    const diff = BigInt(delivery) - BigInt(declared);
    if (diff === 0n) return null;
    const abs = diff < 0n ? -diff : diff;
    return `${diff < 0n ? '-' : '+'}${formatGramsAsKg(abs)} kg delta`;
  })();

  const verdict = verifyQuery.data?.verdict;

  return {
    progressionText:
      progressionParts.length > 0 ? `${progressionParts.join(' → ')} kg` : 'Pending',
    signedDelta: signedDelta ?? (deltaFlag?.deltaKg ? `${deltaFlag.deltaKg} kg delta` : null),
    verdict,
    verifying: verifyQuery.isLoading,
  };
}

function DesktopBatchRow({
  batch,
  token,
  userRole,
}: {
  batch: BatchSummary;
  token: string;
  userRole: string;
}) {
  const metrics = useBatchRowLiveMetrics({ batch, token });

  const canPickup = userRole === 'TRANSPORTER' && batch.status === 'REGISTERED';
  const canDeliver = userRole === 'FACILITY' && batch.status === 'IN_TRANSIT';

  return (
    <tr
      className={cn(
        'hover:bg-canvas/70 transition-colors',
        batch.hasDiscrepancy && 'bg-critical-bg/35',
      )}
    >
      <td
        className={cn(
          'px-4 py-3.5',
          batch.hasDiscrepancy && 'border-l-4 border-l-critical',
        )}
      >
        <CopyChip value={batch.batchRef} displayValue={batch.batchRef} />
      </td>
      <td className="px-4 py-3.5">
        <p className="font-semibold text-ink">{batch.wasteName}</p>
        <div className="mt-1 flex items-center gap-1.5">
          <Badge tone="amber" mono>
            {batch.wasteCode}
          </Badge>
          {batch.hasDiscrepancy && (
            <Badge tone="critical">
              <AlertTriangle className="h-3 w-3" />
              Discrepancy
            </Badge>
          )}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <MiniCustodyStepper status={batch.status} hasDiscrepancy={batch.hasDiscrepancy} />
      </td>
      <td className="px-4 py-3.5">
        <p className="font-data font-medium text-ink">{metrics.progressionText}</p>
        {metrics.signedDelta && (
          <Badge tone="critical" mono className="mt-1">
            {metrics.signedDelta}
          </Badge>
        )}
      </td>
      <td className="px-4 py-3.5">
        {metrics.verifying ? (
          <Skeleton className="h-5 w-28" />
        ) : metrics.verdict === 'TAMPERED' ? (
          <Badge tone="critical">Tamper Detected</Badge>
        ) : metrics.verdict === 'VERIFIED' ? (
          <Badge tone="verified">
            <CheckCircle2 className="h-3 w-3" />
            Hash Match Verified
          </Badge>
        ) : (
          <Badge tone="warning">
            {BATCH_STATUS_LABELS[batch.status]}
          </Badge>
        )}
        <p className="font-data mt-1 text-[11px] text-ink-muted">
          {formatShortHash(batch.latestEventHash, 8, 6)}
        </p>
      </td>
      <td className="font-data px-4 py-3.5 text-ink-secondary">
        {formatTimestampWib(batch.updatedAt)}
      </td>
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Link href={`/batches/${batch.id}`}>
            <Button size="sm" variant="outline">
              View Passport
            </Button>
          </Link>
          {(canPickup || canDeliver) && (
            <Link href={`/handoff/${batch.id}`}>
              <Button size="sm" variant="primary">
                Handoff
              </Button>
            </Link>
          )}
        </div>
      </td>
    </tr>
  );
}

function MobileBatchCard({
  batch,
  token,
  userRole,
}: {
  batch: BatchSummary;
  token: string;
  userRole: string;
}) {
  const metrics = useBatchRowLiveMetrics({ batch, token });
  const canPickup = userRole === 'TRANSPORTER' && batch.status === 'REGISTERED';
  const canDeliver = userRole === 'FACILITY' && batch.status === 'IN_TRANSIT';

  return (
    <Card className={cn(batch.hasDiscrepancy && 'border-l-4 border-l-critical')}>
      <CardContent className="pt-4 space-y-3 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-data text-sm font-bold text-ink">{batch.batchRef}</p>
            <p className="mt-0.5 font-medium text-ink-secondary">{batch.wasteName}</p>
          </div>
          <Badge tone="amber" mono>
            {batch.wasteCode}
          </Badge>
        </div>

        <div className="flex items-center justify-between gap-2">
          <MiniCustodyStepper status={batch.status} hasDiscrepancy={batch.hasDiscrepancy} />
          {metrics.verdict === 'TAMPERED' ? (
            <Badge tone="critical">Tamper Detected</Badge>
          ) : metrics.verdict === 'VERIFIED' ? (
            <Badge tone="verified">Hash Match</Badge>
          ) : (
            <Badge tone="neutral">{BATCH_STATUS_LABELS[batch.status]}</Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
          <span className="font-data font-semibold text-ink">{metrics.progressionText}</span>
          {metrics.signedDelta && <Badge tone="critical">{metrics.signedDelta}</Badge>}
        </div>

        <div className="flex gap-2">
          <Link href={`/batches/${batch.id}`} className="flex-1">
            <Button size="sm" variant="outline" className="w-full">
              View Passport
            </Button>
          </Link>
          {(canPickup || canDeliver) && (
            <Link href={`/handoff/${batch.id}`}>
              <Button size="sm" variant="primary">
                Sign Handoff
              </Button>
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function OperationsDashboard() {
  const { isAuthenticated, token, member } = useAuth();
  const [activeTab, setActiveTab] = useState<DashboardTab>('ALL');

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const batchesQuery = useQuery({
    queryKey: ['batches', token],
    queryFn: () => api.listBatches(token!, { limit: 100 }),
    enabled: Boolean(isAuthenticated && token),
    retry: 1,
  });

  const items = useMemo(() => batchesQuery.data?.items ?? [], [batchesQuery.data?.items]);

  const stats = useMemo(() => {
    const total = batchesQuery.data?.total ?? items.length;
    const inTransitOrPending = items.filter(
      (b) => b.status === 'IN_TRANSIT' || b.status === 'PENDING_CHAIN' || b.status === 'REGISTERED',
    ).length;
    const complete = items.filter(
      (b) => (b.status === 'RECEIVED' || b.status === 'TREATED') && !b.hasDiscrepancy,
    ).length;
    const flagged = items.filter((b) => b.hasDiscrepancy);
    const registered = items.filter((b) => b.status === 'REGISTERED').length;
    const inTransit = items.filter((b) => b.status === 'IN_TRANSIT').length;
    const received = items.filter((b) => b.status === 'RECEIVED').length;
    const treated = items.filter((b) => b.status === 'TREATED').length;
    return {
      total,
      inTransitOrPending,
      complete,
      flagged,
      registered,
      inTransit,
      received,
      treated,
    };
  }, [items, batchesQuery.data?.total]);

  const filteredItems = useMemo(() => {
    if (activeTab === 'FLAGGED') return items.filter((b) => b.hasDiscrepancy);
    if (activeTab === 'ALL') return items;
    return items.filter((b) => b.status === (activeTab as BatchStatus));
  }, [items, activeTab]);

  const roleCta = (() => {
    if (!isAuthenticated || !member) {
      return (
        <Link href="/connect?next=/dashboard">
          <Button size="sm" variant="primary">
            <Wallet className="h-4 w-4" />
            Connect Wallet
          </Button>
        </Link>
      );
    }
    if (member.role === 'GENERATOR') {
      return (
        <Link href="/batches/new">
          <Button size="sm" variant="primary">
            <Plus className="h-4 w-4" />
            Register New Batch
          </Button>
        </Link>
      );
    }
    if (member.role === 'TRANSPORTER' || member.role === 'FACILITY') {
      return (
        <Link href="/scan">
          <Button size="sm" variant="primary">
            <QrCode className="h-4 w-4" />
            Scan QR for Handoff
          </Button>
        </Link>
      );
    }
    return (
      <Link href="/audit">
        <Button size="sm" variant="primary">
          <ShieldCheck className="h-4 w-4" />
          Audit Explorer
        </Button>
      </Link>
    );
  })();

  const tabs: Array<TabOption<DashboardTab>> = [
    { id: 'ALL', label: 'All', count: items.length },
    {
      id: 'FLAGGED',
      label: 'Flagged Only',
      count: stats.flagged.length,
      tone: 'critical',
    },
    { id: 'REGISTERED', label: 'Registered', count: stats.registered },
    { id: 'IN_TRANSIT', label: 'In Transit', count: stats.inTransit },
    { id: 'RECEIVED', label: 'Received', count: stats.received },
    { id: 'TREATED', label: 'Treated', count: stats.treated },
  ];

  const latestFlagged = stats.flagged[0];

  return (
    <AppShell
      title="Operations Dashboard"
      chainLabel={chainInfoQuery.data?.networkName}
      actions={roleCta}
    >
      {!isAuthenticated || !token || !member ? (
        <Card className="mx-auto max-w-xl">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand">
              <Wallet className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold text-ink">
              Sign In to View Organization Operations
            </h2>
            <p className="text-sm text-ink-secondary">
              Organization batch lists, custody actions, and weight discrepancy workflows
              require a verified SIWE session for your registered Jababeka wallet.
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-1">
              <Link href="/connect?next=/dashboard">
                <Button variant="primary" size="md">
                  Connect &amp; Sign In
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link href="/audit">
                <Button variant="outline" size="md">
                  Public Audit Explorer
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Conditional Crimson Discrepancy Alert Banner */}
          {latestFlagged && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-critical/40 bg-critical px-4 py-3 text-white shadow-xs"
            >
              <div className="flex items-center gap-2.5 text-sm">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <span>
                  <strong>Discrepancy Flagged:</strong> Batch{' '}
                  <span className="font-data font-bold">{latestFlagged.batchRef}</span> (
                  {latestFlagged.wasteName}) has an active weight variance ({stats.flagged.length}{' '}
                  flagged batch{stats.flagged.length > 1 ? 'es' : ''}).
                </span>
              </div>
              <Link
                href={`/batches/${latestFlagged.id}`}
                className="inline-flex items-center gap-1 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
              >
                Review Details →
              </Link>
            </div>
          )}

          {/* 4 KPI Cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-5">
                <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                  Total Tracked Batches
                </p>
                <p className="font-data mt-2 text-3xl font-extrabold text-ink">
                  {stats.total}
                </p>
                <p className="mt-1 text-xs text-ink-secondary">
                  Visible to {member.orgName}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5">
                <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                  In-Transit / Pending Handoff
                </p>
                <p className="font-data mt-2 text-3xl font-extrabold text-ink">
                  {stats.inTransitOrPending}
                </p>
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-secondary">
                  <Truck className="h-3.5 w-3.5 text-chain" />
                  Awaiting next custody sign-off
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5">
                <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                  Verified Custody Complete
                </p>
                <p className="font-data mt-2 text-3xl font-extrabold text-verified">
                  {stats.complete}
                </p>
                <p className="mt-1 text-xs text-ink-secondary">
                  Received or treated within tolerance
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5">
                <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                  Flagged Discrepancies
                </p>
                <p
                  className={cn(
                    'font-data mt-2 text-3xl font-extrabold',
                    stats.flagged.length > 0 ? 'text-critical' : 'text-ink',
                  )}
                >
                  {stats.flagged.length}
                </p>
                <p className="mt-1 text-xs text-ink-secondary">
                  Batches exceeding tolerance threshold
                </p>
              </CardContent>
            </Card>
          </div>

          <Tabs items={tabs} value={activeTab} onChange={setActiveTab} />

          {batchesQuery.isLoading ? (
            <Card>
              <CardContent className="pt-5 space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ) : filteredItems.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="h-5 w-5" />}
              title="No waste batches match this filter"
              description={
                member.role === 'GENERATOR'
                  ? 'Register a new B3 waste batch to generate its printable QR passport and on-chain anchor.'
                  : 'Batches transferred to your organization or visible to your role appear here automatically.'
              }
              action={
                member.role === 'GENERATOR' ? (
                  <Link href="/batches/new">
                    <Button variant="primary" size="md">
                      <Plus className="h-4 w-4" />
                      Register New Batch
                    </Button>
                  </Link>
                ) : (
                  <Link href="/scan">
                    <Button variant="primary" size="md">
                      <QrCode className="h-4 w-4" />
                      Scan Container QR
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto rounded-xl border border-line bg-surface shadow-(--shadow-card)">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line bg-canvas text-ink-secondary">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Batch ID</th>
                      <th className="px-4 py-3 font-semibold">Waste Type &amp; B3 Code</th>
                      <th className="px-4 py-3 font-semibold">Custody Stage</th>
                      <th className="px-4 py-3 font-semibold">Weight Progression</th>
                      <th className="px-4 py-3 font-semibold">Integrity Proof</th>
                      <th className="px-4 py-3 font-semibold">Last Updated</th>
                      <th className="px-4 py-3 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {filteredItems.map((batch) => (
                      <DesktopBatchRow
                        key={batch.id}
                        batch={batch}
                        token={token}
                        userRole={member.role}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 md:hidden">
                {filteredItems.map((batch) => (
                  <MobileBatchCard
                    key={batch.id}
                    batch={batch}
                    token={token}
                    userRole={member.role}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}
