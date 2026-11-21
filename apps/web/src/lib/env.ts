const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

function parseChainId(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 84532;
}

export const webEnv = {
  apiUrl: stripTrailingSlash(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'),
  publicAppUrl: stripTrailingSlash(
    process.env.NEXT_PUBLIC_PUBLIC_APP_URL || 'http://localhost:3000',
  ),
  defaultChainId: parseChainId(process.env.NEXT_PUBLIC_CHAIN_ID),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org',
  demoMode: process.env.NEXT_PUBLIC_DEMO_MODE !== 'false',
  e2eMode: process.env.NEXT_PUBLIC_E2E === 'true',
} as const;
