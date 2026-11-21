import type { OverallVerificationVerdict } from '@traceb3/core';
import { AlertOctagon, Clock, ShieldCheck } from 'lucide-react';
import type { VerificationResponse } from '@/lib/api';
import { formatShortHash } from '@/lib/b3-codes';
import { cn } from '@/lib/cn';

export interface HashVerificationBannerProps {
  verdict: OverallVerificationVerdict;
  networkLabel?: string;
  affectedEvents?: VerificationResponse['affectedEvents'];
  affectedFiles?: VerificationResponse['affectedFiles'];
  missingOnChainSeqs?: number[];
  checkedAt?: string;
  className?: string;
}

export function HashVerificationBanner({
  verdict,
  networkLabel = 'Base Sepolia',
  affectedEvents = [],
  affectedFiles = [],
  missingOnChainSeqs = [],
  className,
}: HashVerificationBannerProps) {
  if (verdict === 'VERIFIED') {
    return (
      <div
        role="status"
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-verified/30 bg-verified px-4 py-3 text-white shadow-xs',
          className,
        )}
      >
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 shrink-0" />
          <p className="text-sm font-semibold">
            Cryptographic integrity verified — off-chain record &amp; evidence match{' '}
            {networkLabel} anchor
          </p>
        </div>
        <span className="font-data rounded bg-white/15 px-2 py-0.5 text-xs font-medium">
          VERIFIED
        </span>
      </div>
    );
  }

  if (verdict === 'TAMPERED') {
    return (
      <div
        role="alert"
        className={cn(
          'rounded-xl border-2 border-critical bg-critical-bg p-4 text-critical-fg shadow-xs',
          className,
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <AlertOctagon className="h-5 w-5 shrink-0 text-critical" />
            <p className="text-sm font-bold tracking-tight">
              INTEGRITY BREACH — TAMPERED RECORD OR EVIDENCE DETECTED
            </p>
          </div>
          <span className="font-data rounded bg-critical px-2 py-0.5 text-xs font-semibold text-white">
            TAMPERED
          </span>
        </div>

        <ul className="mt-3 space-y-1.5 text-xs">
          {affectedEvents.map((ev) => (
            <li
              key={ev.eventId}
              className="rounded-lg border border-critical/25 bg-surface px-3 py-2"
            >
              <span className="font-data font-bold text-critical">
                Event #{ev.seq} · {ev.verdict}
              </span>
              <span className="ml-2 text-ink">{ev.reason}</span>
            </li>
          ))}
          {affectedFiles.map((file, idx) => (
            <li
              key={`${file.eventId}-${file.filename}-${idx}`}
              className="rounded-lg border border-critical/25 bg-surface px-3 py-2"
            >
              <span className="font-data font-bold text-critical">
                Event #{file.seq} File ({file.filename}) · {file.issue}
              </span>
              <div className="font-data mt-1 text-[11px] text-ink-secondary">
                Expected SHA-256: {formatShortHash(file.expectedSha256, 14, 10)} ·
                Actual: {file.actualSha256 ? formatShortHash(file.actualSha256, 14, 10) : 'MISSING'}
              </div>
            </li>
          ))}
          {missingOnChainSeqs.length > 0 && (
            <li className="rounded-lg border border-critical/25 bg-surface px-3 py-2">
              <span className="font-data font-bold text-critical">
                Missing On-Chain Sequences: #{missingOnChainSeqs.join(', #')}
              </span>
            </li>
          )}
        </ul>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/35 bg-warning-bg px-4 py-3 text-warning-fg',
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <Clock className="h-5 w-5 shrink-0 text-warning" />
        <p className="text-sm font-medium">
          {verdict === 'PENDING'
            ? `Verification pending — latest custody event is still confirming on ${networkLabel}.`
            : 'Verification incomplete — one or more custody anchors could not be reconciled yet.'}
        </p>
      </div>
      <span className="font-data rounded bg-warning/15 px-2 py-0.5 text-xs font-semibold">
        {verdict}
      </span>
    </div>
  );
}
