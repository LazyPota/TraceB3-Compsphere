'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatGramsAsKg, normalizeWeightToGrams, type WeightUnit } from '@traceb3/core';
import { AlertTriangle, CheckCircle2, Lock, PenLine, ShieldCheck, Wallet } from 'lucide-react';
import { api, type CreateIntentPayload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  ACTOR_ROLE_LABELS,
  B3_WASTE_CODES,
  CONTAINER_TYPES,
  formatShortAddress,
  formatShortHash,
  generateBatchRef,
} from '@/lib/b3-codes';
import { serializeBatchNotes } from '@/lib/notes';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  EvidenceDropzone,
  type UploadedEvidenceItem,
} from '@/components/domain/evidence-dropzone';
import {
  Web3TxProgressModal,
  type Web3TxResult,
} from '@/components/domain/web3-tx-progress-modal';

const B3_OPTIONS: ComboboxOption[] = B3_WASTE_CODES.map((c) => ({
  value: c.code,
  label: c.name,
  sublabel: c.category,
}));

export function RegisterBatchForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, token, member } = useAuth();

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const [batchRef, setBatchRef] = useState(() => generateBatchRef());
  const [wasteCode, setWasteCode] = useState('A102d');
  const [wasteName, setWasteName] = useState('Spent Organic Solvents & Thinners');
  const [wasteCategory, setWasteCategory] = useState('Category 1');
  const [festronikRef, setFestronikRef] = useState('');
  const [monijaRef, setMonijaRef] = useState('');

  const [weightValue, setWeightValue] = useState('850');
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('kg');
  const [unitConfirmed, setUnitConfirmed] = useState(false);

  const [containerCount, setContainerCount] = useState('4');
  const [containerType, setContainerType] = useState<string>(CONTAINER_TYPES[0]);
  const [labReportRef, setLabReportRef] = useState('');
  const [labSummary, setLabSummary] = useState('');
  const [freeNotes, setFreeNotes] = useState('');

  const [photoEvidence, setPhotoEvidence] = useState<UploadedEvidenceItem | null>(null);
  const [pdfEvidence, setPdfEvidence] = useState<UploadedEvidenceItem | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<CreateIntentPayload | null>(null);
  const [previewDigest, setPreviewDigest] = useState<string | null>(null);

  const normalizedWeight = useMemo(() => {
    if (!weightValue.trim()) return { normalized: null, error: null };
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

  const evidenceList = useMemo(
    () => [photoEvidence, pdfEvidence].filter((x): x is UploadedEvidenceItem => x !== null),
    [photoEvidence, pdfEvidence],
  );

  const canonicalNotesPreview = useMemo(
    () =>
      serializeBatchNotes({
        containerCount,
        containerType,
        labSummary,
        labReportRef,
        freeNotes,
      }),
    [containerCount, containerType, labSummary, labReportRef, freeNotes],
  );

  // Async WebCrypto SHA-256 preview fingerprint of current payload
  useEffect(() => {
    let cancelled = false;
    const previewBody = JSON.stringify({
      batchRef: batchRef.trim(),
      wasteCode: wasteCode.trim(),
      wasteName: wasteName.trim(),
      grams: normalizedWeight.normalized?.grams ?? null,
      evidence: evidenceList.map((e) => e.sha256),
      notes: canonicalNotesPreview ?? null,
    });

    if (typeof window === 'undefined' || !window.crypto?.subtle) {
      return;
    }

    const bytes = new TextEncoder().encode(previewBody);
    void window.crypto.subtle
      .digest('SHA-256', bytes)
      .then((buf) => {
        if (cancelled) return;
        const hex = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        setPreviewDigest(`0x${hex}`);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [batchRef, wasteCode, wasteName, normalizedWeight.normalized?.grams, evidenceList, canonicalNotesPreview]);

  const handleWasteCodeChange = (nextCode: string, opt?: ComboboxOption) => {
    setWasteCode(nextCode);
    if (opt) {
      setWasteName(opt.label);
      if (opt.sublabel) setWasteCategory(opt.sublabel);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!batchRef.trim() || !wasteCode.trim() || !wasteName.trim()) {
      setFormError('Batch Reference ID, B3 Waste Code, and Waste Description are required.');
      return;
    }
    if (!normalizedWeight.normalized) {
      setFormError(normalizedWeight.error ?? 'Enter a valid positive weight.');
      return;
    }
    if (!unitConfirmed) {
      setFormError(`Please confirm the declared weight unit (${weightUnit}) before signing.`);
      return;
    }

    const payload: CreateIntentPayload = {
      kind: 'CREATED',
      data: {
        batchRef: batchRef.trim(),
        wasteCode: wasteCode.trim(),
        wasteName: wasteName.trim(),
        wasteCategory: wasteCategory.trim() || undefined,
        festronikRef: festronikRef.trim() || undefined,
        monijaRef: monijaRef.trim() || undefined,
        quantity: {
          value: weightValue.trim(),
          unit: weightUnit,
        },
        notes: canonicalNotesPreview,
      },
      evidenceIds: evidenceList.map((ev) => ev.id),
    };

    setPendingPayload(payload);
    setTxModalOpen(true);
  };

  const handleAnchored = (result: Web3TxResult) => {
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    void queryClient.invalidateQueries({ queryKey: ['public-passports-landing'] });
    void queryClient.invalidateQueries({ queryKey: ['public-passports-audit'] });
    void result;
  };

  return (
    <AppShell
      title="Register New Waste Batch"
      chainLabel={chainInfoQuery.data?.networkName}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Breadcrumb" className="text-xs text-ink-secondary">
          <Link href="/dashboard" className="hover:text-ink">
            Dashboard
          </Link>
          <span className="mx-1.5">/</span>
          <span className="font-medium text-ink">Register New Waste Batch</span>
        </nav>
        <p className="text-xs text-ink-secondary">
          All details are hashed via SHA-256 and anchored on{' '}
          {chainInfoQuery.data?.networkName ?? 'Base Sepolia'}.
        </p>
      </div>

      {!isAuthenticated || !token || !member ? (
        <Card className="mx-auto max-w-xl">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <Wallet className="mx-auto h-10 w-10 text-brand" />
            <h2 className="text-xl font-bold text-ink">Wallet Sign-In Required</h2>
            <p className="text-sm text-ink-secondary">
              Connect and sign in with an authorized Generator wallet to create a batch.
            </p>
            <Link href="/connect?next=/batches/new">
              <Button variant="primary">Connect &amp; Sign In</Button>
            </Link>
          </CardContent>
        </Card>
      ) : member.role !== 'GENERATOR' ? (
        <Card className="mx-auto max-w-xl border-warning/40">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <Lock className="mx-auto h-10 w-10 text-warning" />
            <h2 className="text-xl font-bold text-ink">Generator Role Required</h2>
            <p className="text-sm text-ink-secondary">
              You are signed in as{' '}
              <strong className="text-ink">{ACTOR_ROLE_LABELS[member.role]}</strong> (
              {member.orgName}). Only registered{' '}
              <strong className="text-ink">Generator</strong> organizations can anchor new
              B3 waste batches.
            </p>
            <div className="flex justify-center gap-3">
              <Link href="/dashboard">
                <Button variant="outline">Back to Dashboard</Button>
              </Link>
              <Link href="/scan">
                <Button variant="primary">Scan QR for Handoff</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <form onSubmit={handleSubmit} className="grid items-start gap-6 lg:grid-cols-12">
          {/* Left 8 Columns: 3 Form Cards */}
          <div className="space-y-5 lg:col-span-8">
            <Card>
              <CardHeader>
                <CardTitle>1. Waste Classification &amp; Origin</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-ink-secondary">
                    Origin Facility
                  </label>
                  <Input value={member.orgName} disabled />
                </div>

                <div>
                  <label
                    htmlFor="batchRef"
                    className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                  >
                    Batch Reference ID
                  </label>
                  <Input
                    id="batchRef"
                    value={batchRef}
                    onChange={(e) => setBatchRef(e.target.value)}
                    className="font-data"
                    required
                  />
                </div>

                <div className="sm:col-span-2">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <label
                      htmlFor="wasteCode"
                      className="block text-xs font-semibold text-ink-secondary"
                    >
                      B3 Waste Code
                    </label>
                    <Badge tone="amber" mono>
                      B3 Hazard · {wasteCode || 'Custom'}
                    </Badge>
                  </div>
                  <Combobox
                    id="wasteCode"
                    value={wasteCode}
                    onChange={handleWasteCodeChange}
                    options={B3_OPTIONS}
                    placeholder="Type PP 22/2021 code (e.g. A102d, B105d)"
                    ariaLabel="B3 Waste Code"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor="wasteName"
                    className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                  >
                    Waste Description
                  </label>
                  <Input
                    id="wasteName"
                    value={wasteName}
                    onChange={(e) => setWasteName(e.target.value)}
                    placeholder="e.g. Methyl Ethyl Ketone sludge / Spent Industrial Solvent"
                    required
                  />
                </div>

                <div>
                  <label
                    htmlFor="festronikRef"
                    className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                  >
                    Festronik Manifest ID (optional)
                  </label>
                  <Input
                    id="festronikRef"
                    value={festronikRef}
                    onChange={(e) => setFestronikRef(e.target.value)}
                    placeholder="FEST-2026-..."
                    className="font-data"
                  />
                </div>

                <div>
                  <label
                    htmlFor="monijaRef"
                    className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                  >
                    Jababeka MONIJA Ref (optional)
                  </label>
                  <Input
                    id="monijaRef"
                    value={monijaRef}
                    onChange={(e) => setMonijaRef(e.target.value)}
                    placeholder="MONIJA-2026-..."
                    className="font-data"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>2. Quantity &amp; Laboratory Measurements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <label
                      htmlFor="declaredWeight"
                      className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                    >
                      Declared Net Weight
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id="declaredWeight"
                        inputMode="decimal"
                        value={weightValue}
                        onChange={(e) => setWeightValue(e.target.value)}
                        className="font-data flex-1"
                        required
                      />
                      <Select
                        aria-label="Weight unit"
                        value={weightUnit}
                        onChange={(e) => {
                          setWeightUnit(e.target.value as WeightUnit);
                          setUnitConfirmed(false);
                        }}
                        className="font-data w-24"
                      >
                        <option value="kg">kg</option>
                        <option value="g">g</option>
                        <option value="ton">ton</option>
                      </Select>
                    </div>
                  </div>

                  <div className="sm:col-span-3">
                    <label
                      htmlFor="containerCount"
                      className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                    >
                      Container Count
                    </label>
                    <Input
                      id="containerCount"
                      inputMode="numeric"
                      value={containerCount}
                      onChange={(e) => setContainerCount(e.target.value)}
                      className="font-data"
                    />
                  </div>

                  <div className="sm:col-span-4">
                    <label
                      htmlFor="containerType"
                      className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                    >
                      Container Type
                    </label>
                    <Select
                      id="containerType"
                      value={containerType}
                      onChange={(e) => setContainerType(e.target.value)}
                    >
                      {CONTAINER_TYPES.map((ct) => (
                        <option key={ct} value={ct}>
                          {ct}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                {normalizedWeight.normalized ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-well px-3.5 py-2 text-xs">
                    <span className="text-ink-secondary">
                      Exact Canonical Integer Normalization
                    </span>
                    <span className="font-data font-semibold text-ink">
                      {formatGramsAsKg(normalizedWeight.normalized.grams)} kg (
                      {normalizedWeight.normalized.grams} g)
                    </span>
                  </div>
                ) : normalizedWeight.error ? (
                  <p className="text-xs font-medium text-critical">{normalizedWeight.error}</p>
                ) : null}

                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={unitConfirmed}
                    onChange={(e) => setUnitConfirmed(e.target.checked)}
                    className="h-4 w-4 accent-brand"
                  />
                  <span>
                    I confirm the weight is accurate in{' '}
                    <strong className="font-data">{weightUnit}</strong>.
                  </span>
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="labReportRef"
                      className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                    >
                      Laboratory Report Ref
                    </label>
                    <Input
                      id="labReportRef"
                      value={labReportRef}
                      onChange={(e) => setLabReportRef(e.target.value)}
                      placeholder="LAB-2026-041"
                      className="font-data"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="labSummary"
                      className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                    >
                      Lab Summary
                    </label>
                    <Input
                      id="labSummary"
                      value={labSummary}
                      onChange={(e) => setLabSummary(e.target.value)}
                      placeholder="pH 6.5, Flash Pt < 23°C"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="freeNotes"
                    className="mb-1.5 block text-xs font-semibold text-ink-secondary"
                  >
                    Additional Manifest Notes (included in canonical hash)
                  </label>
                  <Textarea
                    id="freeNotes"
                    rows={2}
                    value={freeNotes}
                    onChange={(e) => setFreeNotes(e.target.value)}
                    placeholder="Seal numbers, warehouse bay, or handling remarks..."
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>3. Off-Chain Evidence Upload</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <EvidenceDropzone
                  token={token}
                  batchIdOrStaging="staging"
                  label="Container Photograph"
                  title="Container Photograph"
                  description="JPEG, PNG, or WebP drum seal photo (max 10 MB)"
                  accept="image/jpeg,image/png,image/webp"
                  enableCameraCapture
                  value={photoEvidence}
                  onChange={setPhotoEvidence}
                />

                <EvidenceDropzone
                  token={token}
                  batchIdOrStaging="staging"
                  label="Laboratory & Festronik PDF"
                  title="Laboratory / Manifest PDF"
                  description="Lab certificate or Festronik PDF (max 10 MB)"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  value={pdfEvidence}
                  onChange={setPdfEvidence}
                />
              </CardContent>
            </Card>
          </div>

          {/* Right 4 Columns: Sticky Live Cryptographic Preview */}
          <div className="lg:col-span-4 lg:sticky lg:top-20">
            <Card>
              <CardHeader>
                <CardTitle>Live Cryptographic Preview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-secondary">Preview Batch ID</dt>
                    <dd className="font-data font-bold text-ink">{batchRef || '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-secondary">Waste Type</dt>
                    <dd className="truncate max-w-[190px] font-semibold text-ink">
                      {wasteName || '—'} ({wasteCode || '—'})
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-secondary">Declared Weight</dt>
                    <dd className="font-data font-semibold text-ink">
                      {normalizedWeight.normalized
                        ? `${formatGramsAsKg(normalizedWeight.normalized.grams)} kg`
                        : '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-secondary">Evidence Count</dt>
                    <dd className="font-data font-semibold text-ink">
                      {evidenceList.length} File{evidenceList.length === 1 ? '' : 's'}
                    </dd>
                  </div>
                </dl>

                <div className="rounded-xl border border-line bg-well p-3">
                  <p className="text-[11px] font-semibold text-ink-secondary">
                    Payload Fingerprint Preview (SHA-256)
                  </p>
                  <p className="font-data mt-1 text-xs font-medium text-ink break-all">
                    {previewDigest
                      ? formatShortHash(previewDigest, 14, 10)
                      : 'Computing digest...'}
                  </p>
                  <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-verified-fg">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Canonical RFC 8785 record finalized server-side
                  </p>
                </div>

                <dl className="space-y-2 border-t border-line pt-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-secondary">Signing Wallet Address</dt>
                    <dd className="font-data font-medium text-ink">
                      {formatShortAddress(member.walletAddress)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-secondary">Gas Fee</dt>
                    <dd className="font-semibold text-verified-fg">
                      $0 (Sponsored via Relayer)
                    </dd>
                  </div>
                </dl>

                {formError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-critical/35 bg-critical-bg px-3 py-2 text-xs text-critical-fg"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-critical" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="space-y-2 pt-1">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    className="w-full"
                    disabled={!normalizedWeight.normalized || !unitConfirmed}
                  >
                    <PenLine className="h-4 w-4" />
                    Hash Evidence &amp; Sign Batch Creation
                  </Button>
                  <Link href="/dashboard" className="block">
                    <Button type="button" variant="outline" size="md" className="w-full">
                      Cancel
                    </Button>
                  </Link>
                </div>

                <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-brand" />
                  Append-only anchor — weight can be revised transparently later if needed.
                </p>
              </CardContent>
            </Card>
          </div>
        </form>
      )}

      <Web3TxProgressModal
        open={txModalOpen}
        onClose={() => setTxModalOpen(false)}
        title="Sign & Anchor New B3 Waste Batch"
        token={token}
        intentPayload={pendingPayload}
        onAnchored={handleAnchored}
        successActionLabel="Inspect Waste Passport"
        onSuccessAction={(res) => {
          setTxModalOpen(false);
          router.push(`/batches/${res.batchId}`);
        }}
      />
    </AppShell>
  );
}
