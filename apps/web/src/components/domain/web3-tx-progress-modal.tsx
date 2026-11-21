'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  PenLine,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { deserializeTypedData } from '@traceb3/core';
import { useSignTypedData } from 'wagmi';
import {
  api,
  ApiProblemError,
  watchEventStatus,
  type CreateIntentPayload,
  type CreateIntentResponse,
  type EventStatusResponse,
} from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CopyChip } from './copy-chip';
import { cn } from '@/lib/cn';

export type TxStepStage =
  | 'idle'
  | 'preparing'
  | 'signing'
  | 'relaying'
  | 'anchored'
  | 'failed';

export interface Web3TxResult {
  batchId: string;
  eventId: string;
  seq: number;
  status: EventStatusResponse;
}

export interface Web3TxProgressModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  token: string | null;
  intentPayload: CreateIntentPayload | null;
  onAnchored?: (result: Web3TxResult) => void;
  successActionLabel?: string;
  onSuccessAction?: (result: Web3TxResult) => void;
}

export function Web3TxProgressModal({
  open,
  onClose,
  title,
  token,
  intentPayload,
  onAnchored,
  successActionLabel = 'Inspect Waste Passport',
  onSuccessAction,
}: Web3TxProgressModalProps) {
  const { mutateAsync: signTypedDataAsync } = useSignTypedData();

  const [stage, setStage] = useState<TxStepStage>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<'preparing' | 'signing' | 'relaying'>('preparing');
  const [intent, setIntent] = useState<CreateIntentResponse | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [eventStatus, setEventStatus] = useState<EventStatusResponse | null>(null);

  // Maintain stable Idempotency-Key per prepared intent so retries are atomic
  const idempotencyKeyRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const startedForKeyRef = useRef<string | null>(null);

  const runFlow = useCallback(
    async (opts?: {
      existingIntent?: CreateIntentResponse | null;
      existingSignature?: string | null;
    }) => {
      if (!token || !intentPayload) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setErrorMsg(null);
      let activeIntent = opts?.existingIntent ?? null;
      let activeSignature = opts?.existingSignature ?? null;

      try {
        if (!activeIntent) {
          setFailedAt('preparing');
          setStage('preparing');
          activeIntent = await api.createIntent(token, intentPayload);
          if (ac.signal.aborted) return;
          setIntent(activeIntent);
          idempotencyKeyRef.current = crypto.randomUUID();
          activeSignature = null;
          setSignature(null);
        }

        if (!activeSignature) {
          setFailedAt('signing');
          setStage('signing');
          const typedData = deserializeTypedData(activeIntent.typedData);
          activeSignature = await signTypedDataAsync({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          });
          if (ac.signal.aborted) return;
          setSignature(activeSignature);
        }

        setFailedAt('relaying');
        setStage('relaying');
        const submitted = await api.submitIntent(
          token,
          activeIntent.intentId,
          activeSignature,
          idempotencyKeyRef.current || crypto.randomUUID(),
        );
        if (ac.signal.aborted) return;

        const finalStatus = await watchEventStatus(
          token,
          submitted.eventId,
          (update) => {
            if (!ac.signal.aborted) {
              setEventStatus(update);
            }
          },
          ac.signal,
        );
        if (ac.signal.aborted) return;

        if (finalStatus.chainStatus === 'FAILED') {
          setErrorMsg(
            finalStatus.failureReason ||
              'On-chain validation rejected this custody transaction.',
          );
          setStage('failed');
          return;
        }

        setEventStatus(finalStatus);
        setStage('anchored');
        onAnchored?.({
          batchId: submitted.batchId,
          eventId: submitted.eventId,
          seq: submitted.seq,
          status: finalStatus,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        if (err instanceof ApiProblemError) {
          setErrorMsg(err.userMessage);
          // Clear expired or rejected intent so retry rebuilds a fresh one
          if (err.code === 'INTENT_EXPIRED') {
            setIntent(null);
            setSignature(null);
          } else if (err.code === 'BAD_SIGNATURE') {
            setSignature(null);
          }
        } else if (err instanceof Error) {
          setErrorMsg(err.message);
        } else {
          setErrorMsg('Transaction signing or relay failed.');
        }
        setStage('failed');
      }
    },
    [token, intentPayload, signTypedDataAsync, onAnchored],
  );

  // Trigger flow automatically when dialog opens with a fresh payload
  useEffect(() => {
    if (!open || !intentPayload || !token) {
      startedForKeyRef.current = null;
      return;
    }
    const serializedKey = JSON.stringify(intentPayload);
    if (startedForKeyRef.current === serializedKey) return;
    startedForKeyRef.current = serializedKey;

    queueMicrotask(() => {
      setIntent(null);
      setSignature(null);
      setEventStatus(null);
      setErrorMsg(null);
      void runFlow();
    });

    return () => {
      abortRef.current?.abort();
    };
  }, [open, intentPayload, token, runFlow]);

  const handleRetry = () => {
    if (failedAt === 'preparing') {
      void runFlow({ existingIntent: null, existingSignature: null });
    } else if (failedAt === 'signing') {
      void runFlow({ existingIntent: intent, existingSignature: null });
    } else {
      void runFlow({ existingIntent: intent, existingSignature: signature });
    }
  };

  const stepState = (step: 1 | 2 | 3): 'done' | 'active' | 'error' | 'pending' => {
    const mapIdx =
      stage === 'preparing'
        ? 1
        : stage === 'signing'
          ? 2
          : stage === 'relaying'
            ? 3
            : stage === 'anchored'
              ? 4
              : failedAt === 'preparing'
                ? 1
                : failedAt === 'signing'
                  ? 2
                  : 3;

    if (stage === 'failed' && step === mapIdx) return 'error';
    if (step < mapIdx) return 'done';
    if (step === mapIdx && stage !== 'anchored') return 'active';
    return 'pending';
  };

  const steps: Array<{ num: 1 | 2 | 3; label: string; detail: string; icon: typeof ShieldCheck }> = [
    {
      num: 1,
      label: 'Preparing canonical record & SHA-256 hash',
      detail: intent
        ? `Event #${intent.seq} · ${intent.eventHash.slice(0, 14)}…`
        : 'Normalizing weights & computing RFC 8785 hash',
      icon: ShieldCheck,
    },
    {
      num: 2,
      label: 'Waiting for EIP-712 wallet signature (Gasless)',
      detail: signature
        ? 'Signature verified locally'
        : 'Confirm the gas-free EIP-712 prompt in your wallet ($0 fee)',
      icon: PenLine,
    },
    {
      num: 3,
      label: 'Relaying & confirming on-chain anchor',
      detail: eventStatus?.txHash
        ? `Anchored in block #${eventStatus.blockNumber ?? '…'}`
        : 'Relayer submitting signed intent to TraceB3Ledger',
      icon: CheckCircle2,
    },
  ];

  const isBusy = stage === 'preparing' || stage === 'signing' || stage === 'relaying';

  return (
    <Dialog
      open={open}
      onClose={isBusy ? undefined : onClose}
      preventClose={isBusy}
      title={title}
      description="Users never pay gas. Signatures are verified on-chain via our relayer."
    >
      <div className="space-y-3">
        {steps.map((step) => {
          const state = stepState(step.num);
          return (
            <div
              key={step.num}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3.5 transition-colors',
                state === 'done'
                  ? 'border-verified/30 bg-verified-bg/60'
                  : state === 'active'
                    ? 'border-brand/40 bg-brand-tint/60'
                    : state === 'error'
                      ? 'border-critical/40 bg-critical-bg'
                      : 'border-line bg-canvas',
              )}
            >
              <div className="mt-0.5 shrink-0">
                {state === 'done' ? (
                  <CheckCircle2 className="h-5 w-5 text-verified" />
                ) : state === 'active' ? (
                  <Loader2 className="h-5 w-5 animate-spin text-brand" />
                ) : state === 'error' ? (
                  <XCircle className="h-5 w-5 text-critical" />
                ) : (
                  <span className="font-data flex h-5 w-5 items-center justify-center rounded-full border border-line-input text-xs text-ink-muted">
                    {step.num}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{step.label}</p>
                <p className="font-data mt-0.5 text-xs text-ink-secondary break-all">
                  {step.detail}
                </p>
              </div>
            </div>
          );
        })}

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl border border-critical/35 bg-critical-bg px-3.5 py-3 text-xs text-critical-fg"
          >
            <p className="font-semibold">Action could not complete</p>
            <p className="mt-1">{errorMsg}</p>
          </div>
        )}

        {stage === 'anchored' && eventStatus && (
          <div className="rounded-xl border border-verified/30 bg-verified-bg p-3.5 space-y-2">
            <p className="text-xs font-semibold text-verified-fg">
              Custody record anchored on-chain
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {eventStatus.txHash && (
                <CopyChip
                  label="TxHash"
                  value={eventStatus.txHash}
                  href={eventStatus.explorerUrl}
                />
              )}
              {eventStatus.explorerUrl && (
                <a
                  href={eventStatus.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-chain hover:underline"
                >
                  Open Explorer
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          {stage === 'failed' && (
            <>
              <Button variant="outline" onClick={onClose}>
                Back to Form
              </Button>
              <Button variant="primary" onClick={handleRetry}>
                Retry Step
              </Button>
            </>
          )}
          {stage === 'anchored' && eventStatus && intent && (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {onSuccessAction && (
                <Button
                  variant="primary"
                  onClick={() =>
                    onSuccessAction({
                      batchId: intent.batchId,
                      eventId: eventStatus.eventId,
                      seq: eventStatus.seq,
                      status: eventStatus,
                    })
                  }
                >
                  {successActionLabel}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
