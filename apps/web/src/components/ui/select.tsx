import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-10 w-full rounded-lg border border-line-input bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:bg-well disabled:text-ink-secondary disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
