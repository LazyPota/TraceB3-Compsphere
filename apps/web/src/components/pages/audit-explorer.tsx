'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Link2,
  QrCode,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { formatGramsAsKg } from '@traceb3/core';
import {
  api,
  ApiProblemError,
  type PublicPassportSummary,
  type VerificationResponse,
} from '@/lib/api';
import {
  BATCH_STATUS_LABELS,
  formatShortHash,
  formatTimestampWib,
} from '@/lib/b3-codes';
import { parseScannedQrPayload } from '@/lib/qr';
import { getExplorerAddressUrl } from '@/lib/wagmi';
import { BrandLogo } from '@/components/layout/brand-logo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyChip } from '@/components/domain/copy-chip';
import { MiniCustodyStepper } from '@/components/domain/custody-timeline-stepper';
import { HashVerificationBanner } from '@/components/domain/hash-verification-banner';
import { cn } from '@/lib/cn';

type AuditFilter = 'all' | 'tampered' | 'discrepancies' | 'revised' | 'verified';

function AuditRowIntegrityCell({
  item,
  onReportTampered,
}: {
  item: PublicPassportSummary;
  onReportTampered?: (publicId: string, isTampered: boolean) => void;
}) {
  const verifyQuery = useQuery({
    queryKey: ['verify-passport', item.publicId],
    queryFn: async () => {
      const res = await api.verifyPublicPassport(item.publicId);
      onReportTampered?.(item.publicId, res.verdict === 'TAMPERED');
      return res;
    },
    staleTime: 30_000,
    retry: 1,
  });

  const verdict = verifyQuery.data?.verdict;

  return (
    <div className="space-y-1">
      {verifyQuery.isLoading ? (
        <Skeleton className="h-5 w-24" />
      ) : verdict === 'TAMPERED' ? (
        <Badge tone="critical">Tamper Detected</Badge>
      ) : verdict === 'VERIFIED' ? (
        <Badge tone="verified">Hash Match</Badge>
      ) : (
        <Badge tone="warning">{verdict ?? 'Pending'}</Badge>
      )}
      <p className="font-data text-[11px] text-ink-muted">
        Hash: {formatShortHash(item.latestEventHash, 8, 6)}
      </p>
    </div>
  );
}

export function AuditExplorer() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';

  const [inputQuery, setInputQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [tamperedMap, setTamperedMap] = useState<Record<string, boolean>>({});

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const ledgerQuery = useQuery({
    queryKey: ['public-passports-audit'],
    queryFn: () => api.listPublicPassports({ limit: 50 }),
    retry: 1,
  });

  // Auto-select initial query if entered, or allow live inspection
  const verifierQuery = useQuery({
    queryKey: ['audit-verifier', submittedQuery],
    queryFn: async () => {
      const trimmed = submittedQuery.trim();
      const parsed = parseScannedQrPayload(trimmed);
      let publicId = parsed?.kind === 'public_id' ? parsed.value : '';
      if (!publicId) {
        const lookedUp = await api.lookupPublicPassport(parsed?.value ?? trimmed);
        publicId = lookedUp.publicId;
      }
      const [passport, verification] = await Promise.all([
        api.getPublicPassport(publicId),
        api.verifyPublicPassport(publicId),
      ]);
      return { passport, verification };
    },
    enabled: submittedQuery.trim().length > 0,
    retry: false,
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!inputQuery.trim()) return;
    setSubmittedQuery(inputQuery.trim());
  };

  const inspectRow = (publicId: string, batchRef: string) => {
    setInputQuery(batchRef);
    setSubmittedQuery(publicId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDownloadProofBundle = async (publicId: string, batchRef: string) => {
    const bundle = await api.getProofBundle(publicId);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `traceb3-proof-bundle-${batchRef}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const items = useMemo(() => ledgerQuery.data?.items ?? [], [ledgerQuery.data?.items]);
  const counts = useMemo(() => {
    const tampered = items.filter((i) => tamperedMap[i.publicId]).length;
    const discrepancies = items.filter((i) => i.hasDiscrepancy).length;
    const revised = items.filter((i) => i.hasRevisions).length;
    const verified = items.filter(
      (i) => !i.hasDiscrepancy && !tamperedMap[i.publicId],
    ).length;
    return { all: items.length, tampered, discrepancies, revised, verified };
  }, [items, tamperedMap]);

  const filteredItems = useMemo(() => {
    if (filter === 'tampered') return items.filter((i) => tamperedMap[i.publicId]);
    if (filter === 'discrepancies') return items.filter((i) => i.hasDiscrepancy);
    if (filter === 'revised') return items.filter((i) => i.hasRevisions);
    if (filter === 'verified') {
      return items.filter((i) => !i.hasDiscrepancy && !tamperedMap[i.publicId]);
    }
    return items;
  }, [items, filter, tamperedMap]);

  const chainInfo = chainInfoQuery.data;
  const networkName = chainInfo?.networkName ?? 'Base Sepolia';
  const explorerContractUrl =
    chainInfo?.ledgerAddress
      ? getExplorerAddressUrl(
          chainInfo.chainId,
          chainInfo.ledgerAddress,
          chainInfo.explorerBaseUrl,
        )
      : null;

  const verification: VerificationResponse | undefined = verifierQuery.data?.verification;
  const inspectedPassport = verifierQuery.data?.passport;

  const weightVarianceFlag = inspectedPassport?.discrepancies?.flags.find(
    (f) => f.code === 'WEIGHT_MISMATCH_TOTAL' || f.code === 'WEIGHT_MISMATCH_DELIVERY',
  );
  const weightDeltaLabel = (() => {
    if (!inspectedPassport?.discrepancies) {
      return inspectedPassport?.viewLevel === 'redacted'
        ? 'Redacted in public mode'
        : 'Pending weighbridge';
    }
    const { declaredGrams, deliveryGrams } =
      inspectedPassport.discrepancies.effectiveWeights;
    if (!declaredGrams || !deliveryGrams) return 'Awaiting delivery intake';
    const diff = BigInt(deliveryGrams) - BigInt(declaredGrams);
    if (diff === 0n) return '0.0 kg (Exact Match)';
    const sign = diff < 0n ? '-' : '+';
    const abs = diff < 0n ? -diff : diff;
    const suffix =
      inspectedPassport.discrepancies.maxSeverity === 'critical'
        ? ' (Critical Discrepancy)'
        : inspectedPassport.discrepancies.maxSeverity === 'warning'
          ? ' (Variance Flagged)'
          : '';
    const pct =
      weightVarianceFlag?.percent !== null && weightVarianceFlag?.percent !== undefined
        ? ` ${sign}${weightVarianceFlag.percent}%`
        : '';
    return `${sign}${formatGramsAsKg(abs)} kg${pct}${suffix}`;
  })();

  const totalFilesChecked = verification
    ? verification.events.reduce((sum, e) => sum + e.filesChecked, 0)
    : 0;

  return (
    <div className="min-h-dvh bg-canvas text-ink flex flex-col">
      {/* Top Bar matching image_e5dc06 */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-8">
            <BrandLogo href="/" />
            <nav
              aria-label="Audit header navigation"
              className="hidden md:flex items-center gap-6 text-sm font-medium text-ink-secondary"
            >
              <Link href="/dashboard" className="hover:text-ink">
                Dashboard
              </Link>
              <Link href="/scan" className="hover:text-ink">
                Scan QR
              </Link>
              <Link
                href="/audit"
                className="border-b-2 border-brand py-5 font-semibold text-ink"
              >
                Audit Explorer
              </Link>
              <Link href="/settings" className="hover:text-ink">
                Settings
              </Link>
            </nav>
          </div>

          <Badge tone="neutral" className="px-3 py-1">
            <ShieldCheck className="h-3.5 w-3.5 text-brand" />
            Read-Only Audit Mode
          </Badge>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="text-xs text-ink-secondary">
          <Link href="/" className="hover:text-ink">
            TRACEB3
          </Link>
          <span className="mx-1.5">/</span>
          <span className="font-medium text-ink">Audit Explorer</span>
        </nav>

        {/* Instant Cryptographic Proof Verifier */}
        <Card>
          <CardHeader>
            <CardTitle>Instant Cryptographic Proof Verifier</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <form
              onSubmit={(e) => void handleSubmit(e)}
              className="flex flex-col gap-2.5 sm:flex-row"
            >
              <div className="relative flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted"
                />
                <input
                  type="text"
                  value={inputQuery}
                  onChange={(e) => setInputQuery(e.target.value)}
                  placeholder="Enter Batch ID (e.g., TB3-2026-0142), Public ID, or TxHash (0x...)"
                  aria-label="Enter Batch ID, Public ID, or Transaction Hash"
                  className="font-data h-11 w-full rounded-lg border border-line-input bg-surface pl-9 pr-3 text-sm text-ink placeholder:font-sans placeholder:text-ink-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
                />
              </div>
              <Button
                type="submit"
                size="md"
                loading={verifierQuery.isFetching}
                className="h-11 shrink-0"
              >
                Run Integrity Verification
              </Button>
              <Link href="/scan">
                <Button type="button" variant="outline" size="md" className="h-11 w-full sm:w-auto">
                  <QrCode className="h-4 w-4" />
                  Scan QR
                </Button>
              </Link>
            </form>

            {verifierQuery.isError && (
              <div
                role="alert"
                className="rounded-xl border border-critical/35 bg-critical-bg px-4 py-3 text-xs font-medium text-critical-fg"
              >
                {verifierQuery.error instanceof ApiProblemError
                  ? verifierQuery.error.userMessage
                  : 'Could not resolve or verify that batch reference.'}
              </div>
            )}

            {verification && inspectedPassport && (
              <div className="space-y-4">
                <HashVerificationBanner
                  verdict={verification.verdict}
                  networkLabel={networkName}
                  affectedEvents={verification.affectedEvents}
                  affectedFiles={verification.affectedFiles}
                  missingOnChainSeqs={verification.missingOnChainSeqs}
                />

                {/* 4 Diagnostic Check Cards */}
                <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-line bg-canvas p-4">
                    <div className="flex items-start gap-2.5">
                      <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" />
                      <div>
                        <p className="text-xs font-semibold text-ink">
                          On-Chain Hash Retrieved ({networkName})
                        </p>
                        <p
                          className={cn(
                            'mt-1.5 text-sm font-bold',
                            verification.onChainEventCount > 0
                              ? 'text-verified-fg'
                              : 'text-warning-fg',
                          )}
                        >
                          {verification.onChainEventCount > 0 ? 'PASS' : 'PENDING'}
                        </p>
                        <p className="font-data mt-0.5 text-[11px] text-ink-secondary">
                          {verification.onChainEventCount} anchored event(s)
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-line bg-canvas p-4">
                    <div className="flex items-start gap-2.5">
                      <Link2
                        className={cn(
                          'mt-0.5 h-5 w-5 shrink-0',
                          verification.affectedFiles.length > 0
                            ? 'text-critical'
                            : 'text-verified',
                        )}
                      />
                      <div>
                        <p className="text-xs font-semibold text-ink">
                          Off-Chain Record &amp; Evidence
                        </p>
                        <p
                          className={cn(
                            'mt-1.5 text-sm font-bold',
                            verification.affectedFiles.length > 0
                              ? 'text-critical'
                              : 'text-verified-fg',
                          )}
                        >
                          {verification.affectedFiles.length > 0 ? 'FILE TAMPERED' : 'PASS'}
                        </p>
                        <p className="font-data mt-0.5 text-[11px] text-ink-secondary">
                          {totalFilesChecked} stored file(s) re-hashed
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-line bg-canvas p-4">
                    <div className="flex items-start gap-2.5">
                      <ShieldCheck
                        className={cn(
                          'mt-0.5 h-5 w-5 shrink-0',
                          verification.verdict === 'TAMPERED'
                            ? 'text-critical'
                            : 'text-verified',
                        )}
                      />
                      <div>
                        <p className="text-xs font-semibold text-ink">
                          SHA-256 Hash Match Verification
                        </p>
                        <p
                          className={cn(
                            'mt-1.5 text-sm font-bold',
                            verification.verdict === 'TAMPERED'
                              ? 'text-critical'
                              : verification.verdict === 'VERIFIED'
                                ? 'text-verified-fg'
                                : 'text-warning-fg',
                          )}
                        >
                          {verification.verdict === 'TAMPERED'
                            ? 'MISMATCH'
                            : verification.verdict === 'VERIFIED'
                              ? 'MATCH'
                              : verification.verdict}
                        </p>
                        <p className="font-data mt-0.5 text-[11px] text-ink-secondary">
                          Verified {formatTimestampWib(verification.checkedAt)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-line bg-canvas p-4">
                    <div className="flex items-start gap-2.5">
                      {inspectedPassport.hasDiscrepancy ? (
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-critical" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" />
                      )}
                      <div>
                        <p className="text-xs font-semibold text-ink">
                          Custody Weight Reconciliation
                        </p>
                        <p
                          className={cn(
                            'font-data mt-1.5 text-sm font-bold',
                            inspectedPassport.hasDiscrepancy
                              ? 'text-critical'
                              : 'text-verified-fg',
                          )}
                        >
                          {weightDeltaLabel}
                        </p>
                        <p className="mt-0.5 text-[11px] text-ink-secondary">
                          Declared vs latest effective weight
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2 text-xs text-ink-secondary">
                    <span className="font-data font-semibold text-ink">
                      {inspectedPassport.batchRef}
                    </span>
                    <span>· {inspectedPassport.wasteName}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void handleDownloadProofBundle(
                          inspectedPassport.publicId,
                          inspectedPassport.batchRef,
                        )
                      }
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download Proof Bundle
                    </Button>
                    <Link href={`/p/${inspectedPassport.publicId}`}>
                      <Button size="sm" variant="primary">
                        Inspect Full Passport
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* System-Wide Compliance & Anomaly Ledger */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold tracking-tight text-ink">
              System-Wide Compliance &amp; Anomaly Ledger
            </h2>
          </div>

          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Ledger filters">
            {(
              [
                {
                  id: 'all',
                  label: `All Records (${counts.all})`,
                  activeClass: 'bg-ink text-white border-ink',
                },
                {
                  id: 'tampered',
                  label: `Hash Mismatches (${counts.tampered})`,
                  activeClass: 'bg-critical-bg text-critical-fg border-critical/40',
                },
                {
                  id: 'discrepancies',
                  label: `Weight Discrepancies (${counts.discrepancies})`,
                  activeClass: 'bg-warning-bg text-warning-fg border-warning/40',
                },
                {
                  id: 'revised',
                  label: `Revised Records (${counts.revised})`,
                  activeClass: 'bg-chain-bg text-chain-fg border-chain/40',
                },
                {
                  id: 'verified',
                  label: `Verified Clean (${counts.verified})`,
                  activeClass: 'bg-verified-bg text-verified-fg border-verified/40',
                },
              ] as const
            ).map((pill) => {
              const active = filter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(pill.id)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-semibold transition-colors cursor-pointer',
                    active
                      ? pill.activeClass
                      : 'border-line bg-surface text-ink-secondary hover:bg-well',
                  )}
                >
                  {pill.label}
                </button>
              );
            })}
          </div>

          {ledgerQuery.isLoading ? (
            <Card>
              <CardContent className="pt-5 space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ) : filteredItems.length === 0 ? (
            <EmptyState
              icon={<Clock className="h-5 w-5" />}
              title="No matching records in the anomaly ledger"
              description="Adjust your active filter pill, or register and anchor a waste batch to populate the compliance ledger."
            />
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto rounded-xl border border-line bg-surface shadow-(--shadow-card)">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line bg-canvas text-ink-secondary">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Batch ID</th>
                      <th className="px-4 py-3 font-semibold">Waste Type &amp; B3 Code</th>
                      <th className="px-4 py-3 font-semibold">Organization</th>
                      <th className="px-4 py-3 font-semibold">Custody Stage</th>
                      <th className="px-4 py-3 font-semibold">Weight Declared</th>
                      <th className="px-4 py-3 font-semibold">Weight Received</th>
                      <th className="px-4 py-3 font-semibold">Weight Delta</th>
                      <th className="px-4 py-3 font-semibold">Integrity Check</th>
                      <th className="px-4 py-3 font-semibold">Last Updated</th>
                      <th className="px-4 py-3 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {filteredItems.map((item) => {
                      const decl = item.effectiveWeights.declaredGrams ?? item.declaredWeightGrams;
                      const rec = item.effectiveWeights.deliveryGrams;
                      const deltaDisplay = (() => {
                        if (!decl || !rec) return '—';
                        const diff = BigInt(rec) - BigInt(decl);
                        if (diff === 0n) return '0.0 kg';
                        const sign = diff < 0n ? '-' : '+';
                        const abs = diff < 0n ? -diff : diff;
                        return `${sign}${formatGramsAsKg(abs)} kg`;
                      })();

                      return (
                        <tr
                          key={item.batchId}
                          className={cn(
                            'hover:bg-canvas/80',
                            item.hasDiscrepancy && 'bg-critical-bg/25',
                          )}
                        >
                          <td className="px-4 py-3">
                            <CopyChip value={item.batchRef} displayValue={item.batchRef} />
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-ink">{item.wasteName}</p>
                            <Badge tone="amber" mono className="mt-1">
                              {item.wasteCode}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-ink-secondary">
                            {item.generatorOrgName ?? 'Registered Org'}
                          </td>
                          <td className="px-4 py-3">
                            <MiniCustodyStepper
                              status={item.status}
                              hasDiscrepancy={item.hasDiscrepancy}
                            />
                          </td>
                          <td className="font-data px-4 py-3 font-medium">
                            {decl ? `${formatGramsAsKg(decl)} kg` : 'Redacted'}
                          </td>
                          <td className="font-data px-4 py-3 font-medium">
                            {rec ? `${formatGramsAsKg(rec)} kg` : BATCH_STATUS_LABELS[item.status]}
                          </td>
                          <td
                            className={cn(
                              'font-data px-4 py-3 font-semibold',
                              item.hasDiscrepancy ? 'text-critical' : 'text-ink-secondary',
                            )}
                          >
                            {deltaDisplay}
                          </td>
                          <td className="px-4 py-3">
                            <AuditRowIntegrityCell
                              item={item}
                              onReportTampered={(pubId, isTampered) =>
                                setTamperedMap((prev) =>
                                  prev[pubId] === isTampered
                                    ? prev
                                    : { ...prev, [pubId]: isTampered },
                                )
                              }
                            />
                          </td>
                          <td className="font-data px-4 py-3 text-ink-secondary">
                            {formatTimestampWib(item.updatedAt)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Link href={`/p/${item.publicId}`}>
                                <Button size="sm" variant="outline">
                                  View Passport
                                </Button>
                              </Link>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => inspectRow(item.publicId, item.batchRef)}
                              >
                                Inspect Hash
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards (< 768px) */}
              <div className="space-y-3 md:hidden">
                {filteredItems.map((item) => (
                  <Card
                    key={item.batchId}
                    className={cn(
                      item.hasDiscrepancy && 'border-l-4 border-l-critical',
                    )}
                  >
                    <CardContent className="pt-4 space-y-3 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-data font-bold text-ink">{item.batchRef}</p>
                          <p className="mt-0.5 font-medium text-ink-secondary">
                            {item.wasteName} ({item.wasteCode})
                          </p>
                        </div>
                        <MiniCustodyStepper
                          status={item.status}
                          hasDiscrepancy={item.hasDiscrepancy}
                        />
                      </div>
                      <AuditRowIntegrityCell
                        item={item}
                        onReportTampered={(pubId, isTampered) =>
                          setTamperedMap((prev) =>
                            prev[pubId] === isTampered
                              ? prev
                              : { ...prev, [pubId]: isTampered },
                          )
                        }
                      />
                      <div className="flex gap-2">
                        <Link href={`/p/${item.publicId}`} className="flex-1">
                          <Button size="sm" variant="outline" className="w-full">
                            View Passport
                          </Button>
                        </Link>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => inspectRow(item.publicId, item.batchRef)}
                        >
                          Inspect Hash
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 text-xs text-ink-secondary sm:px-6 lg:px-8">
          <span>Compsphere 12 / HackSphere 2026</span>
          {explorerContractUrl ? (
            <a
              href={explorerContractUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-data inline-flex items-center gap-1 text-chain hover:underline"
            >
              Blockchain Explorer ({networkName})
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="font-data">{networkName}</span>
          )}
        </div>
      </footer>
    </div>
  );
}
