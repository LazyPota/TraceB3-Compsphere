import type { AppType } from '@traceb3/api';
import { hc } from 'hono/client';

export const SDK_VERSION = '0.1.0';

export type { AppType } from '@traceb3/api';
export * from '@traceb3/core';
export {
  CHAIN_EXPLORER_BASE_URLS,
  CONTRACTS_VERSION,
  getExplorerTxUrl,
  getLedgerAddress,
  LEDGER_ADDRESSES,
  TRACEB3_LEDGER_ABI,
} from '@traceb3/contracts';

export interface TraceB3ClientOptions {
  token?: string;
  getToken?: () => string | undefined;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

/**
 * Creates an end-to-end typed Hono RPC client for the TRACEB3 API.
 */
export function createTraceB3Client(
  baseUrl: string,
  options?: TraceB3ClientOptions,
) {
  return hc<AppType>(baseUrl, {
    fetch: options?.fetch,
    headers: () => {
      const merged: Record<string, string> = { ...(options?.headers ?? {}) };
      const token = options?.token ?? options?.getToken?.();
      if (token) {
        merged.Authorization = `Bearer ${token}`;
      }
      return merged;
    },
  });
}

export type TraceB3Client = ReturnType<typeof createTraceB3Client>;
