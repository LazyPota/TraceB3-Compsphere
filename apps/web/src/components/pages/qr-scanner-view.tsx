'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Camera, CameraOff, QrCode, Search } from 'lucide-react';
import { api, ApiProblemError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseScannedQrPayload } from '@/lib/qr';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const QrScanner = dynamic(
  () => import('@yudiel/react-qr-scanner').then((mod) => mod.Scanner),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center rounded-xl bg-well text-xs text-ink-secondary">
        Initializing camera viewfinder...
      </div>
    ),
  },
);

export function QrScannerView() {
  const router = useRouter();
  const { isAuthenticated, member } = useAuth();

  const [cameraActive, setCameraActive] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const lastHandledRef = useRef<string>('');

  const chainInfoQuery = useQuery({
    queryKey: ['chain-info'],
    queryFn: api.getChainInfo,
    retry: 1,
  });

  const routeToBatchOrPassport = useCallback(
    async (rawPayload: string) => {
      const trimmed = rawPayload.trim();
      if (!trimmed || resolving) return;
      setLookupError(null);

      const parsed = parseScannedQrPayload(trimmed);
      if (!parsed) {
        setLookupError('Scan a valid TRACEB3 QR code or enter a Batch ID.');
        return;
      }

      setResolving(true);
      try {
        let publicId = parsed.kind === 'public_id' ? parsed.value : '';
        if (!publicId) {
          const resolved = await api.lookupPublicPassport(parsed.value);
          publicId = resolved.publicId;
        }
        const passport = await api.getPublicPassport(publicId);

        const canActHandoff =
          isAuthenticated &&
          member &&
          ((member.role === 'TRANSPORTER' && passport.status === 'REGISTERED') ||
            (member.role === 'FACILITY' &&
              (passport.status === 'IN_TRANSIT' || passport.status === 'RECEIVED')));

        if (canActHandoff) {
          router.push(`/handoff/${passport.batchId}`);
        } else if (isAuthenticated) {
          router.push(`/batches/${passport.batchId}`);
        } else {
          router.push(`/p/${passport.publicId}`);
        }
      } catch (err) {
        lastHandledRef.current = '';
        setLookupError(
          err instanceof ApiProblemError
            ? err.userMessage
            : 'No TRACEB3 passport found matching that QR or batch identifier.',
        );
      } finally {
        setResolving(false);
      }
    },
    [isAuthenticated, member, resolving, router],
  );

  const handleManualSubmit = (e: FormEvent) => {
    e.preventDefault();
    void routeToBatchOrPassport(manualInput);
  };

  return (
    <AppShell
      title="Scan Container QR & Custody Handoff"
      chainLabel={chainInfoQuery.data?.networkName}
    >
      <div className="mx-auto max-w-[600px] space-y-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-brand" />
              <CardTitle>Camera QR Viewfinder</CardTitle>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCameraError(null);
                setCameraActive((prev) => !prev);
              }}
            >
              {cameraActive ? (
                <>
                  <CameraOff className="h-4 w-4" />
                  Pause Camera
                </>
              ) : (
                <>
                  <Camera className="h-4 w-4" />
                  Start Camera
                </>
              )}
            </Button>
          </CardHeader>

          <CardContent className="space-y-3">
            {cameraActive && !cameraError ? (
              <div className="overflow-hidden rounded-xl border border-line bg-ink/5">
                <QrScanner
                  formats={['qr_code']}
                  paused={!cameraActive || resolving}
                  onScan={(codes) => {
                    const value = codes[0]?.rawValue;
                    if (!value || value === lastHandledRef.current) return;
                    lastHandledRef.current = value;
                    void routeToBatchOrPassport(value);
                  }}
                  onError={(err) => {
                    const msg =
                      err instanceof Error
                        ? err.message
                        : 'Camera permission denied or no camera device detected.';
                    setCameraError(msg);
                    setCameraActive(false);
                  }}
                  styles={{
                    container: { width: '100%' },
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-input bg-canvas px-4 py-10 text-center">
                <CameraOff className="h-7 w-7 text-ink-muted" />
                <p className="mt-2 text-sm font-semibold text-ink">
                  {cameraError ? 'Camera Unavailable' : 'Camera Paused'}
                </p>
                <p className="mt-1 max-w-sm text-xs text-ink-secondary">
                  {cameraError ??
                    'Use camera scanning on mobile devices, or enter a Batch ID manually below.'}
                </p>
              </div>
            )}

            <p className="text-xs text-ink-secondary">
              Point at a drum or IBC tote QR label. Authorized drivers and facilities route
              directly to the gasless handoff confirmation screen.
            </p>
          </CardContent>
        </Card>

        {/* Persistent Manual Fallback Sheet */}
        <Card>
          <CardHeader>
            <CardTitle>Manual Batch ID / Passport Lookup</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleManualSubmit} className="space-y-3">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink-muted"
                />
                <Input
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder="Enter TB3-..., Public ID, Batch UUID, or /p/..."
                  aria-label="Manual Batch ID or Passport URL"
                  className="font-data h-12 pl-10 text-sm"
                />
              </div>
              {lookupError && (
                <p role="alert" className="text-xs font-medium text-critical">
                  {lookupError}
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                variant="primary"
                loading={resolving}
                disabled={!manualInput.trim()}
                className="w-full"
              >
                Open Custody Handoff / Passport
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
