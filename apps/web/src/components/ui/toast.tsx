'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setItems((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-20 z-60 flex w-full max-w-sm flex-col gap-2 md:bottom-4"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface p-3.5 shadow-lg',
              item.tone === 'error'
                ? 'border-critical/40'
                : item.tone === 'success'
                  ? 'border-verified/40'
                  : 'border-line',
            )}
          >
            {item.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verified" />
            ) : item.tone === 'error' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-critical" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-chain" />
            )}
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold text-ink">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 text-xs text-ink-secondary">{item.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
              className="rounded p-1 text-ink-muted hover:bg-well hover:text-ink cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      pushToast: () => undefined,
    };
  }
  return ctx;
}
