import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'verified'
  | 'warning'
  | 'critical'
  | 'chain'
  | 'amber';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-well text-ink-secondary border-line',
  brand: 'bg-brand-tint text-brand border-brand/20',
  verified: 'bg-verified-bg text-verified-fg border-verified/25',
  warning: 'bg-warning-bg text-warning-fg border-warning/25',
  critical: 'bg-critical-bg text-critical-fg border-critical/25',
  chain: 'bg-chain-bg text-chain-fg border-chain/25',
  amber: 'bg-warning-bg text-warning-fg border-b3-amber/30',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  mono?: boolean;
}

export function Badge({
  tone = 'neutral',
  mono = false,
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium leading-5',
        mono && 'font-data',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  );
}
