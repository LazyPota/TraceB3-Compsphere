'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, LogOut, Network, Printer, ShieldCheck, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { webEnv } from '@/lib/env';
import { getChainDisplayName, getExplorerAddressUrl } from '@/lib/wagmi';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyChip } from '@/components/domain/copy-chip';
import { WalletRoleBadge } from '@/components/domain/wallet-role-badge';
import { cn } from '@/lib/cn';

type PrintPreset = 'a6_thermal' | 'a4_sheet';
const PRINT_PRESET_KEY = 'traceb3_print_preset_v1';
const presetListeners = new Set<() => void>();

function subscribePreset(cb: () => void): () => void {
  presetListeners.add(cb);
  return () => presetListeners.delete(cb);
}

function readPrintPreset(): PrintPreset {
  if (typeof window === 'undefined') return 'a6_thermal';
  try {
    const val = window.localStorage.getItem(PRINT_PRESET_KEY);
    return val === 'a4_sheet' ? 'a4_sheet' : 'a6_thermal';
  } catch {
    return 'a6_thermal';
  }
}

function writePrintPreset(preset: PrintPreset): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(PRINT_PRESET_KEY, preset);
    } catch {
      // Ignore storage errors
    }
  }
  for (const listener of presetListeners) {
    listener();
  }
}

export function SettingsView() {
  const { isAuthenticated, member, expiresAt, signOut } = useAuth();
  const printPreset = useSyncExternalStore(
    subscribePreset,
    readPrintPreset,
    () => 'a6_thermal',
  );

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const chainInfo = chainInfoQuery.data;
  const activeChainId = chainInfo?.chainId ?? webEnv.defaultChainId;
  const networkName = chainInfo?.networkName ?? getChainDisplayName(activeChainId);
  const explorerUrl = chainInfo?.ledgerAddress
    ? getExplorerAddressUrl(
        activeChainId,
        chainInfo.ledgerAddress,
        chainInfo.explorerBaseUrl,
      )
    : null;

  return (
    <AppShell title="Settings" chainLabel={networkName}>
      <div className="mx-auto max-w-3xl space-y-5">
        {/* Identity & Organization Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-brand" />
              <CardTitle>Organization Profile &amp; SIWE Session</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-xs">
            {isAuthenticated && member ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-canvas p-4">
                  <div>
                    <p className="text-sm font-bold text-ink">{member.displayName}</p>
                    <p className="mt-0.5 text-ink-secondary">{member.orgName}</p>
                    <div className="mt-2">
                      <WalletRoleBadge
                        role={member.role}
                        walletAddress={member.walletAddress}
                      />
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => signOut(true)}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign Out &amp; Disconnect
                  </Button>
                </div>

                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-ink-muted">On-Chain Organization Hash</dt>
                    <dd className="mt-1">
                      <CopyChip value={member.onChainOrgId} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Session Expires</dt>
                    <dd className="font-data mt-1 font-medium text-ink">
                      {expiresAt ? new Date(expiresAt).toLocaleString() : 'Active'}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-canvas p-4">
                <p className="text-ink-secondary">
                  No wallet session is currently signed in.
                </p>
                <Link href="/connect?next=/settings">
                  <Button size="sm" variant="primary">
                    <Wallet className="h-4 w-4" />
                    Connect Wallet
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Blockchain & Contract Config */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Network className="h-5 w-5 text-brand" />
              <CardTitle>Network &amp; Smart Contract Anchoring</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ink-secondary">Target EVM Network</span>
              <Badge tone="verified" mono>
                {networkName} (chainId {activeChainId})
              </Badge>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ink-secondary">TraceB3Ledger Contract</span>
              {chainInfo?.ledgerAddress ? (
                <div className="flex items-center gap-2">
                  <CopyChip value={chainInfo.ledgerAddress} href={explorerUrl} />
                  {explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-chain hover:underline"
                    >
                      BaseScan
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ) : (
                <span className="text-ink-muted">Resolving from API...</span>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ink-secondary">Custody Transaction Gas Fee</span>
              <span className="font-semibold text-verified-fg">
                $0 (Sponsored via Relayer)
              </span>
            </div>
          </CardContent>
        </Card>

        {/* QR Print Defaults */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Printer className="h-5 w-5 text-brand" />
              <CardTitle>QR Label Print Defaults</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 text-xs">
            {(
              [
                {
                  id: 'a6_thermal',
                  title: 'A6 Thermal Drum Sticker (105 × 148 mm)',
                  desc: 'High-contrast monochrome layout for warehouse thermal printers.',
                },
                {
                  id: 'a4_sheet',
                  title: 'A4 Compliance Manifest Sheet',
                  desc: 'Standard office laser/inkjet sheet matching Festronik binders.',
                },
              ] as const
            ).map((opt) => {
              const selected = printPreset === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => writePrintPreset(opt.id)}
                  className={cn(
                    'rounded-xl border p-3.5 text-left transition-colors cursor-pointer',
                    selected
                      ? 'border-brand bg-brand-tint/60'
                      : 'border-line bg-canvas hover:bg-well',
                  )}
                >
                  <p className="font-semibold text-ink">{opt.title}</p>
                  <p className="mt-1 text-ink-secondary">{opt.desc}</p>
                </button>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
