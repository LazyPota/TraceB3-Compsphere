import { cookieStorage, createConfig, createStorage, http, injected } from 'wagmi';
import { baseSepolia, hardhat } from 'wagmi/chains';
import { webEnv } from './env';

export const SUPPORTED_CHAINS = [baseSepolia, hardhat] as const;

export function getWagmiConfig() {
  return createConfig({
    chains: SUPPORTED_CHAINS,
    ssr: true,
    storage: createStorage({
      storage: cookieStorage,
    }),
    connectors: [injected()],
    transports: {
      [baseSepolia.id]: http(
        webEnv.defaultChainId === baseSepolia.id ? webEnv.rpcUrl : undefined,
      ),
      [hardhat.id]: http(
        webEnv.defaultChainId === hardhat.id ? webEnv.rpcUrl : 'http://127.0.0.1:8545',
      ),
    },
  });
}

export function getChainDisplayName(chainId: number): string {
  if (chainId === baseSepolia.id) return 'Base Sepolia';
  if (chainId === hardhat.id) return 'Local Hardhat';
  return `Chain #${chainId}`;
}

export function getExplorerAddressUrl(
  chainId: number,
  address: string,
  explorerBaseUrl?: string | null,
): string | null {
  const base =
    explorerBaseUrl ?? (chainId === baseSepolia.id ? 'https://sepolia.basescan.org' : null);
  return base ? `${base.replace(/\/+$/, '')}/address/${address}` : null;
}

export function getExplorerTxLink(
  chainId: number,
  txHash: string,
  explorerBaseUrl?: string | null,
): string | null {
  const base =
    explorerBaseUrl ?? (chainId === baseSepolia.id ? 'https://sepolia.basescan.org' : null);
  return base ? `${base.replace(/\/+$/, '')}/tx/${txHash}` : null;
}
