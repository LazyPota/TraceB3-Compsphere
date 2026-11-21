import { readFileSync } from 'node:fs';
import { verifyProofBundleAgainstRpc } from '../apps/api/src/index.js';

function parseArgs(argv: string[]): {
  file?: string;
  url?: string;
  rpc: string;
} {
  let file: string | undefined;
  let url: string | undefined;
  let rpc = process.env.CHAIN_RPC_URL || 'http://127.0.0.1:8545';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--file' && next) {
      file = next;
      i += 1;
    } else if (arg === '--url' && next) {
      url = next;
      i += 1;
    } else if (arg === '--rpc' && next) {
      rpc = next;
      i += 1;
    }
  }

  return { file, url, rpc };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file && !args.url) {
    console.error(
      'Usage: tsx scripts/verify-bundle.ts (--file <bundle.json> | --url <proof-bundle-url>) [--rpc <rpcUrl>]',
    );
    process.exitCode = 1;
    return;
  }

  let rawBundle: unknown;
  if (args.file) {
    rawBundle = JSON.parse(readFileSync(args.file, 'utf8'));
  } else if (args.url) {
    const res = await fetch(args.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch proof bundle from ${args.url}: HTTP ${res.status}`);
    }
    rawBundle = await res.json();
  }

  const result = await verifyProofBundleAgainstRpc(rawBundle, args.rpc);
  console.log(JSON.stringify(result, null, 2));

  if (result.verdict !== 'VERIFIED') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Bundle verification failed:', err);
  process.exitCode = 1;
});
