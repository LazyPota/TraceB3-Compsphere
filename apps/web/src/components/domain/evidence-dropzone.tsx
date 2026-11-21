'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Camera, CheckCircle2, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { api, ApiProblemError, type EvidenceUploadResponse } from '@/lib/api';
import { formatByteSize, formatShortHash } from '@/lib/b3-codes';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_BYTES = 10 * 1024 * 1024;

export interface UploadedEvidenceItem extends EvidenceUploadResponse {
  previewUrl?: string;
}

export interface EvidenceDropzoneProps {
  token: string | null;
  batchIdOrStaging: string;
  label: string;
  title: string;
  description: string;
  accept?: string;
  enableCameraCapture?: boolean;
  value: UploadedEvidenceItem | null;
  onChange: (item: UploadedEvidenceItem | null) => void;
  disabled?: boolean;
}

export function EvidenceDropzone({
  token,
  batchIdOrStaging,
  label,
  title,
  description,
  accept = 'application/pdf,image/jpeg,image/png,image/webp',
  enableCameraCapture = false,
  value,
  onChange,
  disabled = false,
}: EvidenceDropzoneProps) {
  const inputId = useId();
  const cameraInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localPreviewUrl = useMemo(() => value?.previewUrl ?? null, [value?.previewUrl]);

  useEffect(() => {
    return () => {
      if (localPreviewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(localPreviewUrl);
      }
    };
  }, [localPreviewUrl]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);

    if (file.size > MAX_BYTES) {
      setError('File exceeds maximum allowed 10 MB size limit.');
      return;
    }
    if (file.type && !ALLOWED_MIME.has(file.type)) {
      setError('Only PDF, JPEG, PNG, or WebP files are accepted.');
      return;
    }
    if (!token) {
      setError('Sign in with your registered wallet before uploading evidence.');
      return;
    }

    const previewUrl = file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : undefined;

    setUploading(true);
    try {
      const uploaded = await api.uploadEvidence(token, batchIdOrStaging, file, label);
      onChange({ ...uploaded, previewUrl });
    } catch (err) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (err instanceof ApiProblemError) {
        setError(err.userMessage);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to upload and hash evidence file.');
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled && !uploading) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (disabled || uploading) return;
        const dropped = e.dataTransfer.files?.[0];
        void handleFile(dropped);
      }}
      className={cn(
        'rounded-xl border border-dashed p-4 transition-colors',
        dragActive
          ? 'border-brand bg-brand-tint/60'
          : 'border-line-input bg-canvas/70',
      )}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        disabled={disabled || uploading}
        className="sr-only"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {enableCameraCapture && (
        <input
          ref={cameraRef}
          id={cameraInputId}
          type="file"
          accept="image/*"
          capture="environment"
          disabled={disabled || uploading}
          className="sr-only"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      )}

      {value ? (
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {value.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={value.previewUrl}
                alt={value.filename}
                className="h-14 w-14 shrink-0 rounded-lg border border-line object-cover"
              />
            ) : (
              <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg border border-line bg-critical-bg text-critical-fg">
                <FileText className="h-5 w-5" />
                <span className="font-data text-[10px] font-bold">
                  {value.mimeType === 'application/pdf' ? 'PDF' : 'FILE'}
                </span>
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{value.filename}</p>
              <p className="font-data text-xs text-ink-secondary">
                {formatByteSize(value.sizeBytes)}
              </p>
              <div className="mt-1 inline-flex items-center gap-1 rounded bg-verified-bg px-1.5 py-0.5 text-[11px] font-medium text-verified-fg">
                <CheckCircle2 className="h-3 w-3 shrink-0" />
                <span className="font-data">
                  SHA-256: {formatShortHash(value.sha256, 10, 6)}
                </span>
              </div>
            </div>
          </div>

          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || uploading}
            onClick={() => onChange(null)}
            aria-label={`Remove ${value.filename}`}
          >
            <Trash2 className="h-4 w-4 text-critical" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold text-ink">{title}</p>
            <p className="mt-0.5 text-xs text-ink-secondary">{description}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {enableCameraCapture && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || uploading}
                onClick={() => cameraRef.current?.click()}
              >
                <Camera className="h-4 w-4" />
                Camera
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading ? 'Hashing...' : 'Select File'}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
