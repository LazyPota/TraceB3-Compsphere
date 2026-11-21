'use client';

import Link from 'next/link';
import { Wallet, ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { BrandLogo } from './brand-logo';
import { WalletRoleBadge } from '@/components/domain/wallet-role-badge';
import { Button } from '@/components/ui/button';

export function PublicHeader() {
  const { isAuthenticated, member } = useAuth();

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <BrandLogo href="/" />

        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-ink-secondary"
        >
          <Link href="/#how-it-works" className="hover:text-ink transition-colors">
            How It Works
          </Link>
          <Link href="/dashboard" className="hover:text-ink transition-colors">
            Operation Dashboard
          </Link>
          <Link href="/audit" className="hover:text-ink transition-colors">
            Audit Explorer
          </Link>
        </nav>

        <div className="flex items-center gap-2.5">
          {isAuthenticated && member ? (
            <Link href="/dashboard" className="inline-flex items-center gap-2">
              <WalletRoleBadge
                role={member.role}
                walletAddress={member.walletAddress}
                compact
              />
              <Button size="sm" variant="primary">
                Dashboard
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          ) : (
            <Link href="/connect">
              <Button size="sm" variant="primary">
                <Wallet className="h-4 w-4" />
                Connect Wallet
              </Button>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
