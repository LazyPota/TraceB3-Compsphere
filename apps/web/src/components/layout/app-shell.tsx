'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  FilePlus2,
  LayoutDashboard,
  LogOut,
  Menu,
  QrCode,
  Settings,
  ShieldCheck,
  UserCircle2,
  Wallet,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getChainDisplayName } from '@/lib/wagmi';
import { webEnv } from '@/lib/env';
import { ACTOR_ROLE_LABELS, formatShortAddress } from '@/lib/b3-codes';
import { cn } from '@/lib/cn';
import { BrandLogo } from './brand-logo';
import { Drawer } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { WalletRoleBadge } from '@/components/domain/wallet-role-badge';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  match: (pathname: string) => boolean;
}

const BASE_NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    match: (p) =>
      p === '/dashboard' ||
      (p.startsWith('/batches/') && p !== '/batches/new'),
  },
  {
    href: '/scan',
    label: 'Scan & Handoff',
    icon: QrCode,
    match: (p) => p.startsWith('/scan') || p.startsWith('/handoff/'),
  },
  {
    href: '/batches/new',
    label: 'Register Batch',
    icon: FilePlus2,
    match: (p) => p === '/batches/new',
  },
  {
    href: '/audit',
    label: 'Audit Explorer',
    icon: ShieldCheck,
    match: (p) => p.startsWith('/audit'),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    match: (p) => p.startsWith('/settings'),
  },
];

function SidebarContent({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  const { isAuthenticated, member, signOut } = useAuth();
  const chainLabel = getChainDisplayName(webEnv.defaultChainId);

  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-5">
        <div className="px-1">
          <div className="mb-4 flex items-center justify-between">
            <BrandLogo href="/" />
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs font-medium text-ink-secondary">
            <span className="h-2 w-2 rounded-full bg-verified" />
            <span>{chainLabel}</span>
          </div>
        </div>

        <nav aria-label="Operations navigation" className="space-y-1">
          {BASE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-brand text-white shadow-xs'
                    : 'text-ink-secondary hover:bg-well hover:text-ink',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-line pt-4">
        {isAuthenticated && member ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-canvas p-3">
              <p className="truncate text-sm font-semibold text-ink">
                {member.displayName}
              </p>
              <p className="truncate text-xs text-ink-secondary">
                {ACTOR_ROLE_LABELS[member.role]} · {member.orgName}
              </p>
              <p className="font-data mt-1 text-xs text-ink-muted">
                {formatShortAddress(member.walletAddress)}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => signOut(false)}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out Session
            </Button>
          </div>
        ) : (
          <Link href="/connect" onClick={onNavigate}>
            <Button variant="primary" size="sm" className="w-full">
              <Wallet className="h-4 w-4" />
              Connect Wallet
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}

export interface AppShellProps {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  chainLabel?: string;
}

export function AppShell({
  title,
  actions,
  children,
  chainLabel,
}: AppShellProps) {
  const pathname = usePathname() ?? '';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { isAuthenticated, member } = useAuth();

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      {/* Desktop persistent 248px sidebar (>= 1280px) */}
      <aside className="hidden xl:fixed xl:inset-y-0 xl:left-0 xl:flex xl:w-[248px] xl:flex-col xl:border-r xl:border-line xl:bg-surface xl:p-4">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Tablet/Mobile drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        side="left"
        title="TRACEB3 Navigation"
      >
        <SidebarContent pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
      </Drawer>

      <div className="xl:pl-[248px] flex min-h-dvh flex-col">
        {/* Top bar (mobile/tablet trigger + desktop page header actions) */}
        <header className="sticky top-0 z-20 flex h-14 xl:h-16 items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 sm:px-6 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-secondary hover:bg-well xl:hidden cursor-pointer"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="xl:hidden">
              <BrandLogo href="/" />
            </div>
            {title && (
              <h1 className="hidden xl:block truncate text-xl font-bold tracking-tight text-ink">
                {title}
              </h1>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            {chainLabel && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-line bg-well px-2.5 py-1 text-xs font-medium text-ink-secondary">
                <span className="h-1.5 w-1.5 rounded-full bg-verified" />
                {chainLabel}
              </span>
            )}
            {actions}
            <div className="hidden md:block xl:hidden">
              {isAuthenticated && member ? (
                <WalletRoleBadge role={member.role} compact />
              ) : (
                <Link href="/connect">
                  <Button size="sm" variant="outline">
                    Connect
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-5 pb-24 sm:px-6 md:pb-10">
          {title && (
            <h1 className="mb-4 text-xl font-bold tracking-tight text-ink xl:hidden">
              {title}
            </h1>
          )}
          {children}
        </main>
      </div>

      {/* Mobile fixed 64px 4-slot bottom nav (< 768px) */}
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-center justify-around border-t border-line bg-surface px-2 md:hidden"
      >
        <Link
          href="/dashboard"
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[11px] font-medium',
            pathname === '/dashboard' ? 'text-brand' : 'text-ink-secondary',
          )}
        >
          <LayoutDashboard className="h-5 w-5" />
          <span>Dashboard</span>
        </Link>

        <Link
          href="/scan"
          aria-label="Scan QR"
          className="-mt-5 flex h-13 w-13 flex-col items-center justify-center rounded-full bg-brand text-white shadow-lg ring-4 ring-canvas"
        >
          <QrCode className="h-5 w-5" />
        </Link>

        <Link
          href="/audit"
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[11px] font-medium',
            pathname.startsWith('/audit') ? 'text-brand' : 'text-ink-secondary',
          )}
        >
          <ShieldCheck className="h-5 w-5" />
          <span>Audit</span>
        </Link>

        <Link
          href={isAuthenticated ? '/settings' : '/connect'}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[11px] font-medium',
            pathname.startsWith('/settings') || pathname.startsWith('/connect')
              ? 'text-brand'
              : 'text-ink-secondary',
          )}
        >
          <UserCircle2 className="h-5 w-5" />
          <span>{isAuthenticated ? 'Account' : 'Connect'}</span>
        </Link>
      </nav>
    </div>
  );
}
