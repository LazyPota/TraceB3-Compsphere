'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  QrCode,
  Search,
  ShieldCheck,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { formatGramsAsKg } from '@traceb3/core';
import { api, ApiProblemError } from '@/lib/api';
import { getExplorerAddressUrl } from '@/lib/wagmi';
import { BATCH_STATUS_LABELS, formatShortHash } from '@/lib/b3-codes';
import { parseScannedQrPayload } from '@/lib/qr';
import { webEnv } from '@/lib/env';
import { PublicHeader } from '@/components/layout/public-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyChip } from '@/components/domain/copy-chip';
import { QrCodeSvg } from '@/components/domain/waste-passport-qr-card';
import { cn } from '@/lib/cn';

export function LandingPortal() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [selectedPublicId, setSelectedPublicId] = useState<string | null>(null);

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const passportsQuery = useQuery({
    queryKey: ['public-passports-landing'],
    queryFn: () => api.listPublicPassports({ limit: 8 }),
    retry: 1,
  });

  const items = passportsQuery.data?.items ?? [];
  const cleanSample =
    items.find((i) => !i.hasDiscrepancy && i.latestEventSeq > 0) ?? null;
  const flaggedSample = items.find((i) => i.hasDiscrepancy) ?? null;

  const activeFeaturedId =
    selectedPublicId ?? cleanSample?.publicId ?? flaggedSample?.publicId ?? null;

  const featuredPassportQuery = useQuery({
    queryKey: ['public-passport', activeFeaturedId],
    queryFn: () => api.getPublicPassport(activeFeaturedId!),
    enabled: Boolean(activeFeaturedId),
    retry: 1,
  });

  const featuredVerifyQuery = useQuery({
    queryKey: ['verify-passport', activeFeaturedId],
    queryFn: () => api.verifyPublicPassport(activeFeaturedId!),
    enabled: Boolean(activeFeaturedId),
    retry: 1,
  });

  const handleVerifySubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLookupError(null);
    const parsed = parseScannedQrPayload(searchInput);
    if (!parsed) {
      setLookupError('Enter a Batch Ref, Public ID, or TxHash to inspect.');
      return;
    }
    if (parsed.kind === 'public_id') {
      router.push(`/p/${encodeURIComponent(parsed.value)}`);
      return;
    }
    setLookupLoading(true);
    try {
      const resolved = await api.lookupPublicPassport(parsed.value);
      router.push(`/p/${encodeURIComponent(resolved.publicId)}`);
    } catch (err) {
      setLookupError(
        err instanceof ApiProblemError
          ? err.userMessage
          : 'No anchored passport found for that reference.',
      );
    } finally {
      setLookupLoading(false);
    }
  };

  const featured = featuredPassportQuery.data;
  const featuredVerify = featuredVerifyQuery.data;
  const chainInfo = chainInfoQuery.data;
  const explorerContractUrl =
    chainInfo?.ledgerAddress
      ? getExplorerAddressUrl(
          chainInfo.chainId,
          chainInfo.ledgerAddress,
          chainInfo.explorerBaseUrl,
        )
      : null;

  // Map real events into the 3-role preview slots
  const genEvent = featured?.events.find((e) => e.eventType === 'CREATED') ?? null;
  const transEvents =
    featured?.events.filter((e) => e.eventType === 'CUSTODY_TRANSFERRED') ?? [];
  const pickupEvent = transEvents[0] ?? null;
  const facilityEvent = transEvents[1] ?? null;
  const latestTx =
    featured?.events
      .slice()
      .reverse()
      .find((e) => e.txHash) ?? null;

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <PublicHeader />

      {/* Hero with soft mint-veridian radial ambient gradient */}
      <section className="relative overflow-hidden border-b border-line bg-[radial-gradient(ellipse_at_top,_rgba(15,61,62,0.11)_0%,_rgba(5,150,105,0.06)_38%,_rgba(217,119,6,0.05)_65%,_transparent_85%)]">
        <div className="mx-auto max-w-7xl px-4 pt-10 pb-14 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-brand-tint px-3.5 py-1 text-xs font-semibold text-brand shadow-xs">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Permen LHK No. 6/2021 Cryptographic Compliance Layer</span>
            </div>

            <h1 className="mt-5 text-3xl font-extrabold tracking-tight sm:text-5xl lg:text-[52px] lg:leading-[1.1]">
              <span className="bg-linear-to-r from-brand via-verified to-b3-amber bg-clip-text text-transparent">
                Tamper-Evident Chain of Custody for Industrial B3 Waste
              </span>
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-ink-secondary sm:text-base">
              TRACEB3 sits above existing regulatory workflows like{' '}
              <strong className="font-semibold text-ink">Festronik</strong> and{' '}
              <strong className="font-semibold text-ink">Jababeka MONIJA</strong> —
              anchoring SHA-256 evidence hashes, weighbridge handoffs, and append-only
              revisions onto {chainInfo?.networkName ?? 'Base Sepolia'} with zero
              proprietary IoT hardware.
            </p>
          </div>

          <div className="mt-10 grid items-start gap-8 lg:grid-cols-12">
            {/* Left Column: Instant Verifier + Metrics */}
            <div className="space-y-4 lg:col-span-6">
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-(--shadow-raised)">
                <p className="text-[11px] font-bold tracking-wider text-brand uppercase">
                  Instant Public &amp; Auditor Proof Verification (Zero Wallet Required)
                </p>

                <form
                  onSubmit={(e) => void handleVerifySubmit(e)}
                  className="mt-3 flex flex-col gap-2 sm:flex-row"
                >
                  <div className="relative flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted"
                    />
                    <input
                      type="text"
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      placeholder="Enter Batch Ref (e.g. TB3-...), Public ID, or TxHash (0x...)"
                      aria-label="Enter Batch Reference, Public ID, or Transaction Hash"
                      className="font-data h-11 w-full rounded-lg border border-line-input bg-surface pl-9 pr-10 text-sm text-ink placeholder:font-sans placeholder:text-ink-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
                    />
                    <Link
                      href="/scan"
                      aria-label="Open QR Scanner"
                      title="Scan QR Code"
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-ink-secondary hover:bg-well hover:text-ink"
                    >
                      <QrCode className="h-4 w-4" />
                    </Link>
                  </div>
                  <Button
                    type="submit"
                    size="md"
                    loading={lookupLoading}
                    className="h-11 shrink-0"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Verify Proof
                  </Button>
                </form>

                {lookupError && (
                  <p role="alert" className="mt-2 text-xs font-medium text-critical">
                    {lookupError}
                  </p>
                )}

                <div className="mt-3.5 border-t border-line pt-3">
                  <p className="text-xs font-medium text-ink-secondary">
                    Quick-Test Demo Passports:
                  </p>
                  {passportsQuery.isLoading ? (
                    <div className="mt-2 flex gap-2">
                      <Skeleton className="h-7 w-44" />
                      <Skeleton className="h-7 w-44" />
                    </div>
                  ) : cleanSample || flaggedSample ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {cleanSample && (
                        <button
                          type="button"
                          onClick={() => setSelectedPublicId(cleanSample.publicId)}
                          className={cn(
                            'font-data inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
                            activeFeaturedId === cleanSample.publicId
                              ? 'border-verified bg-verified-bg text-verified-fg'
                              : 'border-line bg-well text-ink hover:bg-verified-bg/60',
                          )}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 text-verified" />
                          <span>
                            {cleanSample.hasDiscrepancy ? 'Latest' : 'Verified'}:{' '}
                            {cleanSample.batchRef}
                          </span>
                        </button>
                      )}
                      {flaggedSample && flaggedSample.publicId !== cleanSample?.publicId && (
                        <button
                          type="button"
                          onClick={() => setSelectedPublicId(flaggedSample.publicId)}
                          className={cn(
                            'font-data inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
                            activeFeaturedId === flaggedSample.publicId
                              ? 'border-critical bg-critical-bg text-critical-fg'
                              : 'border-critical/30 bg-critical-bg/50 text-critical-fg hover:bg-critical-bg',
                          )}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 text-critical" />
                          <span>Flagged: {flaggedSample.batchRef}</span>
                        </button>
                      )}
                      {activeFeaturedId && (
                        <Link
                          href={`/p/${activeFeaturedId}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-brand hover:underline"
                        >
                          Open Full Passport →
                        </Link>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-xs text-ink-muted">
                      No waste passports anchored on this server yet. Connect a Generator
                      wallet or open{' '}
                      <Link href="/audit" className="font-medium text-brand underline">
                        Audit Explorer
                      </Link>
                      .
                    </p>
                  )}
                </div>
              </div>

              {/* 3 Stacked Value Metrics */}
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
                  <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                    Industrial Scale
                  </p>
                  <p className="mt-1 text-2xl font-extrabold text-ink">766 Tenants</p>
                  <p className="text-xs text-ink-secondary">
                    Jababeka Cikarang B3 compliance pilot architecture
                  </p>
                </div>

                <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
                  <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                    Revision Architecture
                  </p>
                  <p className="mt-1 text-2xl font-extrabold text-ink">Append-Only</p>
                  <p className="text-xs text-ink-secondary">
                    Original records preserved forever alongside cryptographic revisions
                  </p>
                </div>

                <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
                  <p className="text-[11px] font-bold tracking-wider text-ink-muted uppercase">
                    Field Deployment
                  </p>
                  <p className="mt-1 text-2xl font-extrabold text-ink">Zero IoT CapEx</p>
                  <p className="text-xs text-ink-secondary">
                    Standard smartphone QR scan + gas-sponsored EIP-712 wallet signing
                  </p>
                </div>
              </div>
            </div>

            {/* Right Column: Live Digital Waste Passport Preview Card */}
            <div className="lg:col-span-6">
              <div className="overflow-hidden rounded-2xl border border-brand/25 bg-surface shadow-(--shadow-raised)">
                <div className="flex items-center justify-between bg-brand px-5 py-3.5 text-white">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2.5 w-2.5 rounded-full',
                        featured ? 'bg-verified' : 'bg-b3-amber',
                      )}
                    />
                    <span className="text-sm font-semibold">
                      Live Digital Waste Passport
                    </span>
                  </div>
                  <span className="font-data text-xs font-semibold text-white/90">
                    {featured ? featured.batchRef : 'STANDBY'}
                  </span>
                </div>

                <div className="p-5">
                  {featuredPassportQuery.isLoading ? (
                    <div className="space-y-4">
                      <Skeleton className="h-24 w-full" />
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-32 w-full" />
                    </div>
                  ) : featured ? (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 space-y-1.5">
                          <Badge tone="amber" mono>
                            B3 CODE: {featured.wasteCode}
                          </Badge>
                          <h2 className="text-lg font-bold tracking-tight text-ink">
                            {featured.wasteName}
                          </h2>
                          <p className="text-xs text-ink-secondary">
                            {featured.generatorOrgName ?? 'Registered Generator'}
                          </p>
                          <Badge tone="neutral">
                            Status: {BATCH_STATUS_LABELS[featured.status]}
                          </Badge>
                        </div>
                        <div className="shrink-0">
                          <QrCodeSvg
                            value={`${webEnv.publicAppUrl}/p/${featured.publicId}`}
                            size={108}
                          />
                        </div>
                      </div>

                      {/* Live SHA-256 verification status strip */}
                      <div
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-semibold',
                          featuredVerify?.verdict === 'TAMPERED'
                            ? 'border-critical/35 bg-critical-bg text-critical-fg'
                            : featuredVerify?.verdict === 'VERIFIED'
                              ? 'border-verified/35 bg-verified-bg text-verified-fg'
                              : 'border-warning/35 bg-warning-bg text-warning-fg',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          {featuredVerify?.verdict === 'TAMPERED' ? (
                            <AlertTriangle className="h-4 w-4 text-critical" />
                          ) : featuredVerify?.verdict === 'VERIFIED' ? (
                            <ShieldCheck className="h-4 w-4 text-verified" />
                          ) : (
                            <Clock className="h-4 w-4 text-warning" />
                          )}
                          <span>
                            {featuredVerify?.verdict === 'TAMPERED'
                              ? 'Tampered Record Detected'
                              : featuredVerify?.verdict === 'VERIFIED'
                                ? `SHA-256 Proof Verified on ${chainInfo?.networkName ?? 'Base Sepolia'}`
                                : 'Checking On-Chain Anchor...'}
                          </span>
                        </div>
                        {featured.declaredWeightGrams && (
                          <span className="font-data font-bold">
                            {formatGramsAsKg(featured.declaredWeightGrams)} kg
                          </span>
                        )}
                      </div>

                      {/* 3-Role Custody Steps from real events */}
                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-ink-secondary">
                          3-Role Cryptographic Chain of Custody
                        </p>

                        {[
                          {
                            idx: '1. Generator',
                            event: genEvent,
                            fallbackOrg: featured.generatorOrgName,
                          },
                          {
                            idx: '2. Transporter',
                            event: pickupEvent,
                            fallbackOrg: 'Awaiting fleet pickup',
                          },
                          {
                            idx: '3. Treatment Facility',
                            event: facilityEvent,
                            fallbackOrg: 'Awaiting weighbridge intake',
                          },
                        ].map((row) => (
                          <div
                            key={row.idx}
                            className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              {row.event ? (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-verified" />
                              ) : (
                                <Clock className="h-4 w-4 shrink-0 text-ink-muted" />
                              )}
                              <div className="min-w-0">
                                <p className="font-semibold text-ink">{row.idx}</p>
                                <p className="truncate text-ink-secondary">
                                  {row.event?.actorOrgName ?? row.fallbackOrg}
                                </p>
                              </div>
                            </div>
                            <span className="font-data shrink-0 font-semibold text-ink">
                              {row.event?.quantity
                                ? `${formatGramsAsKg(row.event.quantity.grams)} kg`
                                : row.event
                                  ? 'Anchored'
                                  : 'Pending'}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                        {latestTx?.txHash ? (
                          <CopyChip
                            label="Tx"
                            value={latestTx.txHash}
                            href={latestTx.explorerUrl}
                          />
                        ) : (
                          <span className="font-data text-xs text-ink-muted">
                            Public ID: {featured.publicId}
                          </span>
                        )}

                        <Link
                          href={`/p/${featured.publicId}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
                        >
                          Inspect Full Passport
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                    </div>
                  ) : (
                    <div className="py-10 text-center space-y-3">
                      <p className="text-sm font-semibold text-ink">
                        Ready for Live Waste Passport Registration
                      </p>
                      <p className="mx-auto max-w-sm text-xs text-ink-secondary">
                        Connect an authorized Generator wallet to anchor your first batch,
                        or inspect the read-only Audit Explorer.
                      </p>
                      <div className="flex justify-center gap-2 pt-2">
                        <Link href="/connect">
                          <Button size="sm" variant="primary">
                            Connect Wallet
                          </Button>
                        </Link>
                        <Link href="/audit">
                          <Button size="sm" variant="outline">
                            Audit Explorer
                          </Button>
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom 3-Card Architecture Workflow */}
      <section
        id="how-it-works"
        className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-wider text-brand uppercase">
              Hybrid Web2/Web3 Architecture
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              End-to-End Hazardous Waste Custody Workflow
            </h2>
          </div>

          <Link href="/dashboard">
            <Button variant="outline" size="md">
              Open Live Operation Dashboard
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {[
            {
              num: '01',
              badgeTone: 'brand' as const,
              title: 'Generator Declares & Prints QR',
              body: 'Factory EHS officer enters B3 waste code, unit-normalized weight (kg/g/ton), lab PDF, and drum photo. TRACEB3 hashes files server-side and anchors createBatch() gaslessly via our relayer.',
            },
            {
              num: '02',
              badgeTone: 'amber' as const,
              title: 'Transporter Scans & Signs Pickup',
              body: 'Licensed fleet driver scans the container QR with a smartphone camera, confirms cargo weight in under 30 seconds, and signs an EIP-712 transferCustody() handoff.',
            },
            {
              num: '03',
              badgeTone: 'chain' as const,
              title: 'Treatment Verifies & Flags Variance',
              body: 'Receiving facility logs weighbridge intake. Any weight drop (e.g. 850 kg → 620 kg) or off-chain file swapping is immediately flagged for KLHK & estate auditors.',
            },
          ].map((step) => (
            <div
              key={step.num}
              className="rounded-2xl border border-line bg-surface p-6 shadow-(--shadow-card)"
            >
              <Badge tone={step.badgeTone} mono>
                {step.num}
              </Badge>
              <h3 className="mt-4 text-lg font-bold tracking-tight text-ink">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs text-ink-secondary sm:px-6 lg:px-8">
          <span>Compsphere 12 / HackSphere 2026 — Jababeka Cikarang B3 Compliance</span>
          <div className="flex flex-wrap items-center gap-4">
            {explorerContractUrl && chainInfo?.ledgerAddress && (
              <a
                href={explorerContractUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-data inline-flex items-center gap-1 text-chain hover:underline"
              >
                Contract ({formatShortHash(chainInfo.ledgerAddress, 8, 6)})
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <Link href="/audit" className="font-medium text-brand hover:underline">
              Public Audit Explorer →
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
