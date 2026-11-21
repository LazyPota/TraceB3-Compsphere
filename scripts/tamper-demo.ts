import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dotenv } from '../apps/api/src/services/seed-cli-deps.js';

function parseArgs(argv: string[]) {
  let batchId = '';
  let publicId = '';
  let mode: 'db' | 'file' = 'db';
  let seq = 2;
  let apiUrl = process.env.DEMO_API_URL || 'http://127.0.0.1:3001';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--batch' && next) {
      batchId = next;
      i += 1;
    } else if (arg === '--public' && next) {
      publicId = next;
      i += 1;
    } else if (arg === '--mode' && (next === 'db' || next === 'file')) {
      mode = next;
      i += 1;
    } else if (arg === '--seq' && next) {
      seq = Number(next);
      i += 1;
    } else if (arg === '--api' && next) {
      apiUrl = next;
      i += 1;
    }
  }

  return { batchId, publicId, mode, seq, apiUrl };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const envDemoPath = path.join(repoRoot, '.env.demo');
  if (existsSync(envDemoPath)) {
    dotenv.config({ path: envDemoPath });
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.batchId || !args.publicId) {
    console.error(
      'Usage: tsx scripts/tamper-demo.ts --batch <batchUuid> --public <publicId> [--mode db|file] [--seq 2] [--api http://127.0.0.1:3001]',
    );
    process.exitCode = 1;
    return;
  }

  const beforeRes = await fetch(
    `${args.apiUrl}/v1/public/passports/${args.publicId}/verify`,
  );
  const before = (await beforeRes.json()) as { verdict: string };
  console.log('Before tamper:', JSON.stringify(before, null, 2));

  const tamperRes = await fetch(`${args.apiUrl}/v1/dev/tamper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: args.mode,
      batchId: args.batchId,
      eventSeq: args.mode === 'db' ? args.seq : undefined,
      tamperedWeightGrams: args.mode === 'db' ? '999999' : undefined,
    }),
  });
  if (!tamperRes.ok) {
    throw new Error(
      `POST /v1/dev/tamper failed: HTTP ${tamperRes.status} ${await tamperRes.text()}`,
    );
  }
  const tamperResult = await tamperRes.json();
  console.log('Tamper applied:', JSON.stringify(tamperResult, null, 2));

  const afterRes = await fetch(
    `${args.apiUrl}/v1/public/passports/${args.publicId}/verify`,
  );
  const after = (await afterRes.json()) as {
    verdict: string;
    affectedEvents: unknown[];
    affectedFiles: unknown[];
  };
  console.log('After tamper:', JSON.stringify(after, null, 2));

  if (after.verdict !== 'TAMPERED') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Tamper demo failed:', err);
  process.exitCode = 1;
});
