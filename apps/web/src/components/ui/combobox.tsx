'use client';

import { useId, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface ComboboxOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string, option?: ComboboxOption) => void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select or type code...',
  disabled = false,
  ariaLabel,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const q = value.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (opt) =>
          opt.value.toLowerCase().includes(q) ||
          opt.label.toLowerCase().includes(q) ||
          opt.sublabel?.toLowerCase().includes(q),
      )
    : options;

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <div className="relative flex items-center">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          className="font-data h-10 w-full rounded-lg border border-line-input bg-surface pl-3 pr-9 text-sm text-ink placeholder:font-sans placeholder:text-ink-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Toggle options"
          onClick={() => setOpen((prev) => !prev)}
          className="absolute right-2 flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:text-ink cursor-pointer"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-ink-secondary">
              Using custom B3 code{' '}
              <span className="font-data font-medium text-ink">{value}</span>
            </li>
          ) : (
            filtered.map((opt) => {
              const selected = opt.value.toLowerCase() === q;
              return (
                <li key={opt.value} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // Prevent blur closing before click commits
                      e.preventDefault();
                      onChange(opt.value, opt);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm cursor-pointer transition-colors',
                      selected ? 'bg-brand-tint text-brand' : 'hover:bg-well text-ink',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-data font-semibold text-xs text-warning-fg bg-warning-bg px-1.5 py-0.5 rounded">
                          {opt.value}
                        </span>
                        <span className="truncate font-medium">{opt.label}</span>
                      </div>
                      {opt.sublabel && (
                        <p className="mt-0.5 text-xs text-ink-muted">{opt.sublabel}</p>
                      )}
                    </div>
                    {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
