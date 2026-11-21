import Link from 'next/link';
import { cn } from '@/lib/cn';

export function BrandLogo({
  href = '/',
  className,
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-2.5 font-bold tracking-tight text-brand',
        className,
      )}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white shadow-xs">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12 2.5L20 7v10l-8 4.5L4 17V7l8-4.5z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M12 12l8-5M12 12v9.5M12 12L4 7"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-lg font-extrabold tracking-tight text-ink">
        TRACE<span className="text-brand">B3</span>
      </span>
    </Link>
  );
}
