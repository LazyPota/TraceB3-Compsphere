'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatShortHash } from '@/lib/b3-codes';

export interface CopyChipProps {
  value: string;
  displayValue?: string;
  label?: string;
  href?: string | null;
  className?: string;
}

export function CopyChip({
  value,
  displayValue,
  label,
  href,
  className,
}: CopyChipProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable in non-HTTPS contexts
    }
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-line bg-well px-2 py-0.5 text-xs text-ink',
        className,
      )}
    >
      {label && <span className="text-ink-muted">{label}</span>}
      <span className="font-data font-medium">{displayValue ?? formatShortHash(value)}</span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Copied to clipboard' : `Copy ${label ?? 'value'}`}
        title={value}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-secondary hover:bg-surface hover:text-ink cursor-pointer"
      >
        {copied ? (
          <Check className="h-3 w-3 text-verified" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View on BaseScan explorer"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-chain hover:bg-surface"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
