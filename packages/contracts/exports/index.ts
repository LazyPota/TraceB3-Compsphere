export const CONTRACTS_VERSION = '0.1.0';

export { TRACEB3_LEDGER_ABI } from './abi.js';
export { LEDGER_ADDRESSES } from './addresses.js';

import { LEDGER_ADDRESSES } from './addresses.js';

export const CHAIN_EXPLORER_BASE_URLS: Readonly<Record<number, string>> = {
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
};

/**
 * Returns the deployed TraceB3Ledger contract address for the given chainId, if available.
 */
export function getLedgerAddress(chainId: number): `0x${string}` | undefined {
  return LEDGER_ADDRESSES[chainId];
}

/**
 * Returns the block explorer transaction URL for supported chains, or null for local chains.
 */
export function getExplorerTxUrl(
  chainId: number,
  txHash: string,
): string | null {
  const baseUrl = CHAIN_EXPLORER_BASE_URLS[chainId];
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/tx/${txHash}`;
}
