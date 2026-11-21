import path from 'node:path';
import type { NextConfig } from 'next';

// apps/web -> monorepo root (pnpm workspace) for standalone tracing + Turbopack root.
const repoRoot = path.resolve(process.cwd(), '../..');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  serverExternalPackages: ['@electric-sql/pglite', 'pino', 'postgres', 'qrcode'],
  transpilePackages: ['@traceb3/core', '@traceb3/contracts'],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
