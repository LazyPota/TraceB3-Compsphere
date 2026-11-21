import { Suspense } from 'react';
import { ConnectWalletView } from '@/components/pages/connect-wallet-view';
import { Skeleton } from '@/components/ui/skeleton';

export default function ConnectPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-[540px] px-4 py-14 space-y-4">
          <Skeleton className="h-10 w-64 mx-auto" />
          <Skeleton className="h-80 w-full" />
        </div>
      }
    >
      <ConnectWalletView />
    </Suspense>
  );
}
