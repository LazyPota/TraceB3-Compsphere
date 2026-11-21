import { Suspense } from 'react';
import { AuditExplorer } from '@/components/pages/audit-explorer';
import { Skeleton } from '@/components/ui/skeleton';

export default function AuditPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl px-4 py-8 space-y-4">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <AuditExplorer />
    </Suspense>
  );
}
