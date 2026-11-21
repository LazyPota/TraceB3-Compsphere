import type { ActorRole } from '@traceb3/core';
import { ShieldCheck } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { ACTOR_ROLE_LABELS, formatShortAddress } from '@/lib/b3-codes';

const ROLE_TONES: Record<ActorRole, BadgeTone> = {
  GENERATOR: 'brand',
  TRANSPORTER: 'chain',
  FACILITY: 'verified',
  AUDITOR: 'amber',
  ADMIN: 'neutral',
};

export interface WalletRoleBadgeProps {
  role: ActorRole;
  walletAddress?: string;
  orgName?: string;
  compact?: boolean;
}

export function WalletRoleBadge({
  role,
  walletAddress,
  orgName,
  compact = false,
}: WalletRoleBadgeProps) {
  return (
    <Badge tone={ROLE_TONES[role]} className="gap-1.5">
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold">{ACTOR_ROLE_LABELS[role]}</span>
      {!compact && orgName && (
        <span className="hidden sm:inline text-ink-secondary font-normal">
          · {orgName}
        </span>
      )}
      {!compact && walletAddress && (
        <span className="font-data text-[11px] opacity-80">
          {formatShortAddress(walletAddress)}
        </span>
      )}
    </Badge>
  );
}
