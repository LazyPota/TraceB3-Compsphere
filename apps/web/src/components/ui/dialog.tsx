'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  maxWidthClass?: string;
  preventClose?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  maxWidthClass = 'max-w-lg',
  preventClose = false,
}: DialogProps) {
  useEffect(() => {
    if (!open || preventClose || !onClose) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, preventClose, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="traceb3-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        aria-hidden="true"
        onClick={() => {
          if (!preventClose) onClose?.();
        }}
        className="fixed inset-0 bg-ink/45 backdrop-blur-[2px]"
      />
      <div
        className={cn(
          'relative z-10 w-full rounded-xl border border-line bg-surface p-6 shadow-(--shadow-raised)',
          maxWidthClass,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="traceb3-dialog-title"
              className="text-lg font-semibold tracking-tight text-ink"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-sm text-ink-secondary">{description}</p>
            )}
          </div>
          {!preventClose && onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-lg p-1.5 text-ink-muted hover:bg-well hover:text-ink cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
