'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ActorRole } from '@traceb3/core';
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useSwitchChain,
} from 'wagmi';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  LogOut,
  Network,
  PenLine,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { api, ApiProblemError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortAddress } from '@/lib/b3-codes';
import { webEnv } from '@/lib/env';
import { getChainDisplayName } from '@/lib/wagmi';
import { PublicHeader } from '@/components/layout/public-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { WalletRoleBadge } from '@/components/domain/wallet-role-badge';

const emptySubscribe = () => () => {};

const DEMO_ROLE_GUIDE = [
  {
    role: 'GENERATOR',
    org: 'PT Cikarang Kimia Manufaktur',
    capabilities: 'Register batches, upload manifests, print QR labels, submit revisions',
  },
  {
    role: 'TRANSPORTER',
    org: 'PT Logistik Limbah Nusantara',
    capabilities: 'Scan drum QR & sign pickup custody handoff (REGISTERED → IN_TRANSIT)',
  },
  {
    role: 'FACILITY',
    org: 'PT PPLI Cileungsi Treatment',
    capabilities: 'Log weighbridge intake (IN_TRANSIT → RECEIVED), record treatment, revise',
  },
  {
    role: 'AUDITOR',
    org: 'KLHK / Jababeka Compliance Audit',
    capabilities: 'Read-only access to all batches, forensic verification & audit logs',
  },
  {
    role: 'ADMIN',
    org: 'TRACEB3 Registry Operator',
    capabilities: 'Organization & member registration on-chain',
  },
] as const;

function hasRpcCode(err: unknown, code: number): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('code' in err && (err as { code?: unknown }).code === code) return true;
  if ('cause' in err) return hasRpcCode((err as { cause?: unknown }).cause, code);
  return false;
}

function formatWalletError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback;
  const lower = msg.toLowerCase();
  if (hasRpcCode(err, 4100) || lower.includes('4100') || lower.includes('not been authorized')) {
    return 'Wallet account is not authorized for this site yet. Unlock MetaMask and approve the account connection popup.';
  }
  if (
    hasRpcCode(err, 4001) ||
    lower.includes('4001') ||
    lower.includes('user rejected') ||
    lower.includes('user denied')
  ) {
    return 'Request was cancelled in your wallet.';
  }
  return msg;
}

export function ConnectWalletView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get('next');
  const nextPath =
    rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
      ? rawNext
      : '/dashboard';

  const isHydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const { address, chainId: activeChainId, isConnected } = useConnection();
  const walletConnected = isHydrated && isConnected;
  const connectors = useConnectors();
  const namedConnectors = connectors.filter((c) => c.id !== 'injected');
  const visibleConnectors = (namedConnectors.length > 0 ? namedConnectors : connectors).filter(
    (connector, index, list) => list.findIndex((item) => item.id === connector.id) === index,
  );
  const { mutateAsync: connectAsync, isPending: isConnecting } = useConnect();
  const { mutate: disconnectWallet } = useDisconnect();
  const { mutateAsync: switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { isAuthenticated, member, isSigningIn, authError, signInWithSiwe, signOut, clearError } =
    useAuth();

  const [walletError, setWalletError] = useState<string | null>(null);
  const [demoRole, setDemoRole] = useState<ActorRole>('GENERATOR');
  const [isRegisteringDemo, setIsRegisteringDemo] = useState(false);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const targetChainId = chainInfoQuery.data?.chainId ?? webEnv.defaultChainId;
  const targetNetworkName =
    chainInfoQuery.data?.networkName ?? getChainDisplayName(targetChainId);
  const chainMatches = walletConnected && activeChainId === targetChainId;

  const handleDemoRegister = async () => {
    if (!address) return;
    setWalletError(null);
    setDemoNotice(null);
    clearError();
    setIsRegisteringDemo(true);
    try {
      if (isAuthenticated) {
        signOut(false);
      }
      const res = await api.devSeed({ wallets: { [demoRole]: address } });
      const chainSyncNote =
        res.onChainRegisteredCount > 0 ? ' and synced on Base Sepolia' : '';
      setDemoNotice(
        `Registered ${formatShortAddress(address)} as ${demoRole}${chainSyncNote}. Click Sign In with Wallet above to activate your session.`,
      );
    } catch (err) {
      setWalletError(
        err instanceof ApiProblemError
          ? err.userMessage
          : err instanceof Error
            ? err.message
            : 'Demo wallet registration failed.',
      );
    } finally {
      setIsRegisteringDemo(false);
    }
  };

  const handleConnect = async (connector: (typeof connectors)[number]) => {
    setWalletError(null);
    clearError();
    try {
      await connectAsync({ connector });
    } catch (err) {
      setWalletError(formatWalletError(err, 'Wallet connection was cancelled.'));
    }
  };

  const handleSwitchNetwork = async () => {
    setWalletError(null);
    try {
      await switchChainAsync({ chainId: targetChainId });
    } catch (err) {
      setWalletError(
        formatWalletError(
          err,
          `Could not switch wallet to ${targetNetworkName} (chainId ${targetChainId}).`,
        ),
      );
    }
  };

  const handleSiwe = async () => {
    setWalletError(null);
    try {
      await signInWithSiwe();
      router.push(nextPath);
    } catch {
      // authError is set inside AuthProvider
    }
  };

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <PublicHeader />

      <main className="mx-auto max-w-[540px] px-4 py-10 sm:py-14">
        <div className="mb-6 text-center">
          <Badge tone="brand" className="mb-3">
            <ShieldCheck className="h-3.5 w-3.5" />
            SIWE (EIP-4361) B2B Authentication
          </Badge>
          <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Connect Authorized Wallet
          </h1>
          <p className="mt-1.5 text-sm text-ink-secondary">
            Sign in gas-free with your registered organization wallet. No ETH balance is
            needed for custody signatures.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>3-Step Session Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Step 1: Browser Wallet */}
            <div className="rounded-xl border border-line bg-canvas p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  {walletConnected ? (
                    <CheckCircle2 className="h-4 w-4 text-verified" />
                  ) : (
                    <Wallet className="h-4 w-4 text-brand" />
                  )}
                  <span>1. Connect Browser Wallet</span>
                </div>
                {walletConnected && address && (
                  <span className="font-data rounded bg-well px-2 py-0.5 text-xs font-medium text-ink">
                    {formatShortAddress(address)}
                  </span>
                )}
              </div>

              {!isHydrated ? (
                <Button size="md" variant="outline" disabled className="w-full">
                  <Wallet className="h-4 w-4" />
                  Detecting browser wallets...
                </Button>
              ) : walletConnected ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-ink-secondary">
                    Wallet connected and ready for network check.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDemoNotice(null);
                      signOut(true);
                      disconnectWallet();
                    }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Disconnect
                  </Button>
                </div>
              ) : visibleConnectors.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {visibleConnectors.map((connector) => (
                    <Button
                      key={connector.uid}
                      size="md"
                      variant="primary"
                      loading={isConnecting}
                      onClick={() => void handleConnect(connector)}
                      className="w-full"
                    >
                      <Wallet className="h-4 w-4" />
                      Connect {connector.name}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-warning-fg">
                  No browser wallet detected. Install MetaMask, Coinbase Wallet, or Rabby
                  and refresh this page.
                </p>
              )}
            </div>

            {/* Step 2: Chain Match */}
            <div className="rounded-xl border border-line bg-canvas p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  {chainMatches ? (
                    <CheckCircle2 className="h-4 w-4 text-verified" />
                  ) : (
                    <Network className="h-4 w-4 text-brand" />
                  )}
                  <span>2. Verify Target Network</span>
                </div>
                <Badge tone={chainMatches ? 'verified' : 'neutral'} mono>
                  {targetNetworkName} ({targetChainId})
                </Badge>
              </div>

              {walletConnected ? (
                chainMatches ? (
                  <p className="text-xs text-verified-fg">
                    Active wallet network matches {targetNetworkName}.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-warning-fg">
                      Wallet is on chain #{activeChainId}. Switch to {targetNetworkName}.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={isSwitching}
                      onClick={() => void handleSwitchNetwork()}
                    >
                      Switch to {targetNetworkName}
                    </Button>
                  </div>
                )
              ) : (
                <p className="text-xs text-ink-muted">
                  Connect your wallet first to verify the active EVM network.
                </p>
              )}
            </div>

            {/* Step 3: SIWE Session */}
            <div className="rounded-xl border border-line bg-canvas p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                {isAuthenticated ? (
                  <CheckCircle2 className="h-4 w-4 text-verified" />
                ) : (
                  <PenLine className="h-4 w-4 text-brand" />
                )}
                <span>3. Authenticate Organization Session (SIWE)</span>
              </div>

              {isAuthenticated && member ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-verified/30 bg-verified-bg p-3">
                    <p className="text-xs font-medium text-verified-fg">
                      Signed in as {member.displayName}
                    </p>
                    <div className="mt-2">
                      <WalletRoleBadge
                        role={member.role}
                        orgName={member.orgName}
                        walletAddress={member.walletAddress}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Link href={nextPath} className="flex-1">
                      <Button variant="primary" size="md" className="w-full">
                        Continue to Operations
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => signOut(false)}
                    >
                      Sign Out
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  className="w-full"
                  disabled={!walletConnected}
                  loading={isSigningIn}
                  onClick={() => void handleSiwe()}
                >
                  <PenLine className="h-4 w-4" />
                  Sign In with Wallet ($0 Gas)
                </Button>
              )}
            </div>

            {webEnv.demoMode && walletConnected && address && (
              <div className="rounded-xl border border-b3-amber/35 bg-warning-bg/55 p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink">
                    Demo Quick-Register Connected Wallet
                  </span>
                  <Badge tone="warning">DEMO_MODE</Badge>
                </div>
                <p className="text-xs text-ink-secondary">
                  Assign <span className="font-data font-medium text-ink">{formatShortAddress(address)}</span>{' '}
                  to any Jababeka role (and sync operational roles on-chain via gas-sponsored relayer)
                  before signing in.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select
                    aria-label="Demo Role"
                    value={demoRole}
                    onChange={(e) => setDemoRole(e.target.value as ActorRole)}
                    className="sm:w-44"
                  >
                    <option value="GENERATOR">GENERATOR</option>
                    <option value="TRANSPORTER">TRANSPORTER</option>
                    <option value="FACILITY">FACILITY</option>
                    <option value="AUDITOR">AUDITOR</option>
                    <option value="ADMIN">ADMIN</option>
                  </Select>
                  <Button
                    variant="outline"
                    size="md"
                    loading={isRegisteringDemo}
                    onClick={() => void handleDemoRegister()}
                    className="flex-1"
                  >
                    Register as {demoRole}
                  </Button>
                </div>
                {demoNotice && (
                  <p className="rounded-lg border border-verified/30 bg-verified-bg px-3 py-2 text-xs font-medium text-verified-fg">
                    {demoNotice}
                  </p>
                )}
              </div>
            )}

            {(walletError || authError) && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-critical/35 bg-critical-bg px-3.5 py-3 text-xs text-critical-fg"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-critical" />
                <div>
                  <p className="font-semibold">Authentication Issue</p>
                  <p className="mt-0.5">{authError ?? walletError}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {webEnv.demoMode && (
          <details className="mt-5 rounded-xl border border-line bg-surface p-4 text-xs">
            <summary className="flex cursor-pointer items-center justify-between font-semibold text-ink list-none">
              <span>Demo Wallets &amp; Role Guide (Gas-Sponsored)</span>
              <ChevronDown className="h-4 w-4 text-ink-muted" />
            </summary>
            <p className="mt-2 text-ink-secondary">
              Local stacks generate demo keys in gitignored <code className="font-data">.env.demo</code>.
              Custody transactions are relayed gaslessly, so demo actor wallets need{' '}
              <strong className="text-ink">$0 ETH</strong>.
            </p>
            <ul className="mt-3 space-y-2">
              {DEMO_ROLE_GUIDE.map((entry) => (
                <li
                  key={entry.role}
                  className="rounded-lg border border-line bg-canvas p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-data font-bold text-brand">{entry.role}</span>
                    <span className="font-medium text-ink">{entry.org}</span>
                  </div>
                  <p className="mt-0.5 text-ink-secondary">{entry.capabilities}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </div>
  );
}
