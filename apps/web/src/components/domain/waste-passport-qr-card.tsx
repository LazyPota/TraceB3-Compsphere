'use client';

import { useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Download, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { webEnv } from '@/lib/env';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CopyChip } from './copy-chip';

export function QrCodeSvg({
  value,
  size = 180,
  label = 'TRACEB3 Waste Passport QR Code',
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const { pathD, viewBoxSize } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const quiet = 2;
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.modules.get(r, c)) {
          d += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return { pathD: d, viewBoxSize: count + quiet * 2 };
  }, [value]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="rounded-lg border border-line bg-white p-1"
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      <path d={pathD} fill="#0F172A" />
    </svg>
  );
}

export interface WastePassportQRCardProps {
  batchId?: string;
  publicId: string;
  batchRef: string;
  wasteCode: string;
  wasteName?: string;
  txHash: string | null;
  explorerUrl?: string | null;
  networkLabel?: string;
  token?: string | null;
}

export function WastePassportQRCard({
  batchId,
  publicId,
  batchRef,
  wasteCode,
  wasteName,
  txHash,
  explorerUrl,
  networkLabel = 'Base Sepolia',
  token,
}: WastePassportQRCardProps) {
  const [printOpen, setPrintOpen] = useState(false);
  const [downloading, setDownloading] = useState<'png' | 'svg' | null>(null);

  const passportUrl = `${webEnv.publicAppUrl}/p/${publicId}`;

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadSvg = async () => {
    setDownloading('svg');
    try {
      const svg =
        token && batchId
          ? await api.fetchBatchQrSvg(token, batchId)
          : await QRCode.toString(passportUrl, { type: 'svg', margin: 2 });
      triggerDownload(
        new Blob([svg], { type: 'image/svg+xml' }),
        `traceb3-${batchRef}.svg`,
      );
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadPng = async () => {
    setDownloading('png');
    try {
      if (token && batchId) {
        const blob = await api.fetchBatchQrPngBlob(token, batchId);
        triggerDownload(blob, `traceb3-${batchRef}.png`);
      } else {
        const dataUrl = await QRCode.toDataURL(passportUrl, { width: 512, margin: 2 });
        const res = await fetch(dataUrl);
        triggerDownload(await res.blob(), `traceb3-${batchRef}.png`);
      }
    } finally {
      setDownloading(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Printable QR Waste Passport</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <QrCodeSvg value={passportUrl} size={172} />

          <div className="space-y-1">
            <p className="font-data text-sm font-bold text-ink">Batch: {batchRef}</p>
            <p className="text-xs text-ink-secondary">
              Scan to verify on-chain custody history
            </p>
          </div>

          {txHash && (
            <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
              <span className="text-ink-muted">{networkLabel} TxHash</span>
              <CopyChip value={txHash} href={explorerUrl} />
            </div>
          )}

          <div className="flex w-full flex-col gap-2">
            <Button
              variant="primary"
              size="md"
              className="w-full"
              onClick={() => setPrintOpen(true)}
            >
              <Printer className="h-4 w-4" />
              Print QR Label
            </Button>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                loading={downloading === 'png'}
                onClick={() => void handleDownloadPng()}
              >
                <Download className="h-3.5 w-3.5" />
                PNG
              </Button>
              <Button
                variant="outline"
                size="sm"
                loading={downloading === 'svg'}
                onClick={() => void handleDownloadSvg()}
              >
                <Download className="h-3.5 w-3.5" />
                SVG
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="Print A6 Thermal Drum Label"
        description="Optimized monochrome contrast for industrial B3 container labels."
        maxWidthClass="max-w-md"
      >
        <div className="print-area rounded-xl border-2 border-ink bg-white p-5 text-ink">
          <div className="flex items-center justify-between border-b border-ink pb-2">
            <span className="text-base font-extrabold tracking-tight">TRACEB3</span>
            <span className="font-data rounded border border-ink px-2 py-0.5 text-xs font-bold">
              B3 · {wasteCode}
            </span>
          </div>

          <div className="my-4 flex flex-col items-center gap-2 text-center">
            <QrCodeSvg value={passportUrl} size={184} />
            <p className="font-data text-base font-bold">{batchRef}</p>
            {wasteName && <p className="text-xs font-medium">{wasteName}</p>}
          </div>

          <div className="border-t border-ink/30 pt-2 text-[11px] space-y-0.5">
            <p className="font-data break-all">Passport: {passportUrl}</p>
            {txHash && <p className="font-data break-all">Tx: {txHash}</p>}
            <p className="text-ink-secondary">
              Tamper-evident custody anchor on {networkLabel}
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setPrintOpen(false)}>
            Close
          </Button>
          <Button variant="primary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Print Label
          </Button>
        </div>
      </Dialog>
    </>
  );
}
