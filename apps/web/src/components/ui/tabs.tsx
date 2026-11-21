'use client';

import { cn } from '@/lib/cn';

export interface TabOption<T extends string> {
  id: T;
  label: string;
  count?: number;
  tone?: 'default' | 'critical' | 'warning';
}

export interface TabsProps<T extends string> {
  items: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: TabsProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        'flex items-center gap-1.5 overflow-x-auto border-b border-line pb-2',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        const toneActive =
          item.tone === 'critical'
            ? 'bg-critical-bg text-critical-fg border-critical/30'
            : item.tone === 'warning'
              ? 'bg-warning-bg text-warning-fg border-warning/30'
              : 'bg-brand-tint text-brand border-brand/25';

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors cursor-pointer',
              active
                ? toneActive
                : 'border-transparent bg-transparent text-ink-secondary hover:bg-well hover:text-ink',
            )}
          >
            <span>{item.label}</span>
            {item.count !== undefined && (
              <span className="font-data rounded-full bg-surface/80 px-1.5 py-0.2 text-xs">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
