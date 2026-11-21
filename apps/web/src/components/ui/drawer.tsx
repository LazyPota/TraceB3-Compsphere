'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: 'left' | 'right';
  children: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  side = 'right',
  children,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex"
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-ink/40 backdrop-blur-[1px]"
      />
      <div
        className={cn(
          'relative z-10 flex h-full w-80 max-w-[90vw] flex-col border-line bg-surface shadow-xl',
          side === 'left' ? 'mr-auto border-r' : 'ml-auto border-l',
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <span className="text-sm font-semibold text-ink">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-lg p-1.5 text-ink-muted hover:bg-well hover:text-ink cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
