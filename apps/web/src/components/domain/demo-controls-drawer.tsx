'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertOctagon,
  Copy,
  ExternalLink,
  FileWarning,
  FlaskConical,
  DatabaseZap,
} from 'lucide-react';
import { api, ApiProblemError, type DevTamperResponse } from '@/lib/api';
import { webEnv } from '@/lib/env';
import { BATCH_STATUS_LABELS } from '@/lib/b3-codes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Drawer } from '@/components/ui/drawer';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';

export function DemoControlsDrawer() {
  const [open, setOpen] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [busyMode, setBusyMode] = useState<'db' | 'file' | null>(null);
  const [lastResult, setLastResult] = useState<DevTamperResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const passportsQuery = useQuery({
    queryKey: ['public-passports-demo-drawer'],
    queryFn: () => api.listPublicPassports({ limit: 10 }),
    enabled: webEnv.demoMode && open,
    retry: 1,
  });

  if (!webEnv.demoMode) {
    return null;
  }

  const items = passportsQuery.data?.items ?? [];
  const activeItem =
    items.find((i) => i.batchId === selectedBatchId) ?? items[0] ?? null;

  const copyPublicUrl = async () => {
    if (!activeItem) return;
    const url = `${webEnv.publicAppUrl}/p/${activeItem.publicId}`;
    try {
      await navigator.clipboard.writeText(url);
      pushToast({
        tone: 'info',
        title: 'Passport URL copied',
        description: url,
      });
    } catch {
      // Clipboard blocked in non-HTTPS environments
    }
  };

  const triggerTamper = async (mode: 'db' | 'file') => {
    if (!activeItem) return;
    setErrorMsg(null);
    setLastResult(null);
    setBusyMode(mode);
    try {
      const res = await api.devTamper(
        mode === 'db'
          ? {
              mode: 'db',
              batchId: activeItem.batchId,
              eventSeq: activeItem.latestEventSeq >= 2 ? 2 : 1,
              tamperedWeightGrams: '999999',
            }
          : {
              mode: 'file',
              batchId: activeItem.batchId,
            },
      );
      setLastResult(res);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['verify-passport'] }),
        queryClient.invalidateQueries({ queryKey: ['audit-verifier'] }),
        queryClient.invalidateQueries({ queryKey: ['public-passport'] }),
        queryClient.invalidateQueries({ queryKey: ['public-passports-audit'] }),
        queryClient.invalidateQueries({ queryKey: ['public-passports-landing'] }),
        queryClient.invalidateQueries({ queryKey: ['batches'] }),
      ]);
      pushToast({
        tone: 'error',
        title: mode === 'db' ? 'DB row tamper simulated' : 'Evidence file swap simulated',
        description: 'Verification queries refreshed — inspect the TAMPERED verdict.',
      });
    } catch (err) {
      setErrorMsg(
        err instanceof ApiProblemError
          ? err.userMessage
          : 'Tamper demo requires DEMO_MODE=true on the backend API.',
      );
    } finally {
      setBusyMode(null);
    }
  };

  return (
    <div className="print:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-20 z-40 inline-flex items-center gap-2 rounded-full border border-b3-amber/40 bg-ink px-3.5 py-2 text-xs font-semibold text-white shadow-lg hover:bg-brand cursor-pointer md:bottom-4"
      >
        <FlaskConical className="h-3.5 w-3.5 text-b3-amber" />
        Demo Controls
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        side="right"
        title="Hackathon Demo Controls"
      >
        <div className="space-y-4 text-xs">
          <div className="rounded-xl border border-b3-amber/30 bg-warning-bg p-3 text-warning-fg">
            <p className="font-semibold">Stage Demonstration Helper</p>
            <p className="mt-1">
              Visible only when <code className="font-data">NEXT_PUBLIC_DEMO_MODE=true</code>.
              Simulate off-chain tampering and watch public verification flip to{' '}
              <strong className="font-data">TAMPERED</strong> live.
            </p>
          </div>

          {passportsQuery.isLoading ? (
            <p className="text-ink-secondary">Loading active waste batches...</p>
          ) : items.length === 0 ? (
            <p className="text-ink-secondary">
              No anchored batches found yet. Register a batch first, then test tamper
              detection here.
            </p>
          ) : (
            <>
              <div>
                <label
                  htmlFor="demoBatchSelect"
                  className="mb-1.5 block font-semibold text-ink-secondary"
                >
                  Target Batch
                </label>
                <Select
                  id="demoBatchSelect"
                  value={activeItem?.batchId ?? ''}
                  onChange={(e) => setSelectedBatchId(e.target.value)}
                >
                  {items.map((item) => (
                    <option key={item.batchId} value={item.batchId}>
                      {item.batchRef} · {item.wasteCode} ({BATCH_STATUS_LABELS[item.status]})
                    </option>
                  ))}
                </Select>
              </div>

              {activeItem && (
                <div className="rounded-xl border border-line bg-canvas p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-data font-bold text-ink">
                      {activeItem.batchRef}
                    </span>
                    <Badge tone="neutral" mono>
                      {activeItem.publicId}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void copyPublicUrl()}>
                      <Copy className="h-3.5 w-3.5" />
                      Copy QR URL
                    </Button>
                    <Link
                      href={`/p/${activeItem.publicId}`}
                      onClick={() => setOpen(false)}
                    >
                      <Button size="sm" variant="outline">
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open Passport
                      </Button>
                    </Link>
                  </div>
                </div>
              )}

              <div className="space-y-2 border-t border-line pt-3">
                <p className="font-semibold text-ink">Simulate Off-Chain Tampering</p>

                <Button
                  variant="danger"
                  size="md"
                  className="w-full justify-start"
                  loading={busyMode === 'file'}
                  disabled={!activeItem || busyMode !== null}
                  onClick={() => void triggerTamper('file')}
                >
                  <FileWarning className="h-4 w-4" />
                  Simulate File Swap Tamper
                </Button>

                <Button
                  variant="danger"
                  size="md"
                  className="w-full justify-start"
                  loading={busyMode === 'db'}
                  disabled={!activeItem || busyMode !== null}
                  onClick={() => void triggerTamper('db')}
                >
                  <DatabaseZap className="h-4 w-4" />
                  Simulate DB Row Tamper (999.9 kg)
                </Button>
              </div>
            </>
          )}

          {lastResult && (
            <div className="rounded-xl border border-critical/35 bg-critical-bg p-3 text-critical-fg space-y-1">
              <div className="flex items-center gap-1.5 font-bold">
                <AlertOctagon className="h-4 w-4 text-critical" />
                <span>Simulated Tamper Applied</span>
              </div>
              <p>{lastResult.detail}</p>
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="rounded-xl border border-critical/35 bg-critical-bg p-3 text-critical-fg"
            >
              {errorMsg}
            </div>
          )}
        </div>
      </Drawer>
    </div>
  );
}
