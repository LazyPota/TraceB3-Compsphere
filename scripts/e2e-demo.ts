import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChainClient,
  ChainRelayWorker,
  createApp,
  createDatabase,
  createLogger,
  loadConfig,
  LocalFsStorage,
  verifyProofBundleAgainstRpc,
} from '../apps/api/src/index.js';
import {
  createPublicClient,
  createSiweMessage,
  createWalletClient,
  deserializeTypedData,
  dotenv,
  generatePrivateKey,
  getExplorerTxUrl,
  hardhat,
  http,
  privateKeyToAccount,
  serve,
  TRACEB3_LEDGER_ABI,
  type ActorRole,
  type CustodyIntentTypedDataJson,
  type Hex,
} from '../apps/api/src/services/seed-cli-deps.js';

const HARDHAT_DEV_ACCOUNT_0_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CONTRACTS_DIR = path.join(REPO_ROOT, 'packages', 'contracts');
const HARDHAT_CLI = path.join(
  CONTRACTS_DIR,
  'node_modules',
  'hardhat',
  'dist',
  'src',
  'cli.js',
);
const ARTIFACT_PATH = path.join(
  CONTRACTS_DIR,
  'artifacts',
  'contracts',
  'TraceB3Ledger.sol',
  'TraceB3Ledger.json',
);

const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'utf8',
);
const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function parseCliArgs(argv: string[]): {
  selfHosted: boolean;
  apiUrl?: string;
  rpcUrl?: string;
} {
  let selfHosted = false;
  let apiUrl: string | undefined;
  let rpcUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--self-hosted') {
      selfHosted = true;
    } else if (arg === '--api' && next) {
      apiUrl = next;
      i += 1;
    } else if (arg === '--rpc' && next) {
      rpcUrl = next;
      i += 1;
    }
  }
  return { selfHosted, apiUrl, rpcUrl };
}

function normalizeHexKey(raw: string | undefined): Hex | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed)
    ? (prefixed.toLowerCase() as Hex)
    : null;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to obtain port')));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForRpc(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.getChainId();
      return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC did not become ready at ${rpcUrl}`);
}

async function apiJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; data: T }> {
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, data };
}

function assertOk(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`E2E assertion failed: ${message}`);
  }
}

async function siweLogin(
  apiUrl: string,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<string> {
  const { status: nonceStatus, data: nonceData } = await apiJson<{
    nonce: string;
    domain: string;
    chainId: number;
  }>(`${apiUrl}/v1/auth/nonce`);
  assertOk(nonceStatus === 200, `GET /v1/auth/nonce returned ${nonceStatus}`);

  const message = createSiweMessage({
    address: account.address,
    chainId: nonceData.chainId,
    domain: nonceData.domain,
    nonce: nonceData.nonce,
    uri: apiUrl,
    version: '1',
    statement: 'Sign in to TRACEB3 E2E Demo',
  });
  const signature = await account.signMessage({ message });

  const { status: verifyStatus, data: verifyData } = await apiJson<{
    token: string;
  }>(`${apiUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  assertOk(
    verifyStatus === 200,
    `POST /v1/auth/verify failed (${verifyStatus}): ${JSON.stringify(verifyData)}`,
  );
  return verifyData.token;
}

async function waitForAnchored(
  apiUrl: string,
  token: string,
  eventId: string,
  timeoutMs = 90_000,
): Promise<{
  eventId: string;
  seq: number;
  eventType: string;
  chainStatus: string;
  txHash: string | null;
  blockNumber: number | null;
  anchoredAt: string | null;
  explorerUrl: string | null;
  failureReason: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, data } = await apiJson<{
      eventId: string;
      seq: number;
      eventType: string;
      chainStatus: string;
      txHash: string | null;
      blockNumber: number | null;
      anchoredAt: string | null;
      explorerUrl: string | null;
      failureReason: string | null;
    }>(`${apiUrl}/v1/events/${eventId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertOk(status === 200, `GET /v1/events/${eventId}/status returned ${status}`);
    if (data.chainStatus === 'ANCHORED') {
      return data;
    }
    if (data.chainStatus === 'FAILED') {
      throw new Error(
        `Event ${eventId} FAILED on-chain: ${data.failureReason ?? 'unknown reason'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for event ${eventId} to reach ANCHORED`);
}

async function uploadEvidence(
  apiUrl: string,
  token: string,
  batchParam: string,
  bytes: Buffer,
  filename: string,
  mime: string,
  label: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], filename, { type: mime }));
  form.append('label', label);

  const { status, data } = await apiJson<{ id: string }>(
    `${apiUrl}/v1/batches/${batchParam}/evidence`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );
  assertOk(
    status === 201,
    `Evidence upload failed (${status}): ${JSON.stringify(data)}`,
  );
  return data.id;
}

async function executeSignedCustodyStep(params: {
  apiUrl: string;
  token: string;
  account: ReturnType<typeof privateKeyToAccount>;
  body: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const { status: intentStatus, data: intent } = await apiJson<{
    intentId: string;
    batchId: string;
    seq: number;
    eventHash: string;
    typedData: CustodyIntentTypedDataJson;
  }>(`${params.apiUrl}/v1/intents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify(params.body),
  });
  assertOk(
    intentStatus === 201,
    `POST /v1/intents failed (${intentStatus}): ${JSON.stringify(intent)}`,
  );

  const signature = await params.account.signTypedData(
    deserializeTypedData(intent.typedData),
  );

  const { status: submitStatus, data: submitted } = await apiJson<{
    eventId: string;
    batchId: string;
  }>(`${params.apiUrl}/v1/intents/${intent.intentId}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
      'Idempotency-Key': params.idempotencyKey,
    },
    body: JSON.stringify({ signature }),
  });
  assertOk(
    submitStatus === 202,
    `POST /v1/intents/${intent.intentId}/submit failed (${submitStatus}): ${JSON.stringify(submitted)}`,
  );

  const anchored = await waitForAnchored(
    params.apiUrl,
    params.token,
    submitted.eventId,
  );
  return { batchId: intent.batchId, anchored };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const envPath = path.join(REPO_ROOT, '.env');
  const envDemoPath = path.join(REPO_ROOT, '.env.demo');

  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
  if (!args.selfHosted && existsSync(envDemoPath)) {
    dotenv.config({ path: envDemoPath, override: true });
  }

  let hardhatProc: ChildProcess | null = null;
  let httpServer: ReturnType<typeof serve> | null = null;
  let relayer: ChainRelayWorker | null = null;
  let dbClient: Awaited<ReturnType<typeof createDatabase>> | null = null;
  let tempDir = '';

  let apiUrl = args.apiUrl || process.env.DEMO_API_URL || 'http://127.0.0.1:3001';
  let rpcUrl =
    args.rpcUrl ||
    process.env.DEMO_CHAIN_RPC_URL ||
    process.env.CHAIN_RPC_URL ||
    'http://127.0.0.1:8545';

  const keys: Record<ActorRole, Hex> = {
    ADMIN:
      normalizeHexKey(process.env.DEMO_ADMIN_PRIVATE_KEY) ?? generatePrivateKey(),
    GENERATOR:
      normalizeHexKey(process.env.DEMO_GENERATOR_PRIVATE_KEY) ??
      generatePrivateKey(),
    TRANSPORTER:
      normalizeHexKey(process.env.DEMO_TRANSPORTER_PRIVATE_KEY) ??
      generatePrivateKey(),
    FACILITY:
      normalizeHexKey(process.env.DEMO_FACILITY_PRIVATE_KEY) ??
      generatePrivateKey(),
    AUDITOR:
      normalizeHexKey(process.env.DEMO_AUDITOR_PRIVATE_KEY) ??
      generatePrivateKey(),
  };

  try {
    if (args.selfHosted) {
      const rpcPort = await findFreePort();
      const apiPort = await findFreePort();
      rpcUrl = `http://127.0.0.1:${rpcPort}`;
      apiUrl = `http://127.0.0.1:${apiPort}`;
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'traceb3-e2e-'));

      hardhatProc = spawn(
        process.execPath,
        [HARDHAT_CLI, 'node', '--port', String(rpcPort), '--hostname', '127.0.0.1'],
        { cwd: CONTRACTS_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await waitForRpc(rpcUrl);

      const artifact = JSON.parse(await fs.readFile(ARTIFACT_PATH, 'utf8')) as {
        bytecode: Hex;
      };
      const relayerAccount = privateKeyToAccount(HARDHAT_DEV_ACCOUNT_0_KEY);
      const deployWallet = createWalletClient({
        account: relayerAccount,
        chain: hardhat,
        transport: http(rpcUrl),
      });
      const publicClient = createPublicClient({
        chain: hardhat,
        transport: http(rpcUrl),
      });
      const deployTx = await deployWallet.deployContract({
        abi: TRACEB3_LEDGER_ABI,
        bytecode: artifact.bytecode,
        args: [relayerAccount.address, relayerAccount.address],
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: deployTx,
      });

      const config = loadConfig({
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        PORT: String(apiPort),
        HOST: '127.0.0.1',
        DATABASE_URL: 'pglite://memory',
        STORAGE_DRIVER: 'local',
        LOCAL_STORAGE_DIR: tempDir,
        CHAIN_RPC_URL: rpcUrl,
        CHAIN_ID: '31337',
        LEDGER_ADDRESS: receipt.contractAddress!,
        RELAYER_PRIVATE_KEY: HARDHAT_DEV_ACCOUNT_0_KEY,
        JWT_SECRET: 'e2e-self-hosted-demo-secret-key-01',
        SIWE_DOMAIN: `127.0.0.1:${apiPort}`,
        API_PUBLIC_URL: apiUrl,
        PUBLIC_VIEW_LEVEL: 'full',
        DEMO_MODE: 'true',
      });

      const logger = createLogger({ level: config.LOG_LEVEL });
      dbClient = await createDatabase(config.DATABASE_URL);
      await dbClient.migrate();
      const storage = new LocalFsStorage({
        baseDir: tempDir,
        apiPublicUrl: config.API_PUBLIC_URL,
        signingSecret: config.JWT_SECRET,
      });
      const chain = new ChainClient(config);
      relayer = new ChainRelayWorker({ config, logger, db: dbClient, chain });
      relayer.start(200);

      const app = createApp({ config, logger, db: dbClient, storage, chain, relayer });
      httpServer = serve({ fetch: app.fetch, port: apiPort, hostname: '127.0.0.1' });
      console.log(`[e2e] Self-hosted mode ready: API=${apiUrl}, RPC=${rpcUrl}`);
    }

    // Step 1: Check readiness & chain info
    const ready = await apiJson<{ status: string }>(`${apiUrl}/readyz`);
    assertOk(
      ready.status === 200 && ready.data.status === 'ready',
      `/readyz must return 200 ready, got ${ready.status} (${JSON.stringify(ready.data)})`,
    );

    const chainInfoRes = await apiJson<{
      chainId: number;
      networkName: string;
      ledgerAddress: string;
    }>(`${apiUrl}/v1/chain/info`);
    assertOk(chainInfoRes.status === 200, 'GET /v1/chain/info failed');
    const chainInfo = chainInfoRes.data;

    // Seed actors via /v1/dev/seed when DEMO_MODE=true
    const accounts = {
      GENERATOR: privateKeyToAccount(keys.GENERATOR),
      TRANSPORTER: privateKeyToAccount(keys.TRANSPORTER),
      FACILITY: privateKeyToAccount(keys.FACILITY),
      AUDITOR: privateKeyToAccount(keys.AUDITOR),
      ADMIN: privateKeyToAccount(keys.ADMIN),
    };
    const seedRes = await apiJson<{ onChainRegisteredCount: number }>(
      `${apiUrl}/v1/dev/seed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallets: {
            ADMIN: accounts.ADMIN.address,
            GENERATOR: accounts.GENERATOR.address,
            TRANSPORTER: accounts.TRANSPORTER.address,
            FACILITY: accounts.FACILITY.address,
            AUDITOR: accounts.AUDITOR.address,
          },
        }),
      },
    );
    const demoModeActive = seedRes.status === 200;

    // Step 2: SIWE logins
    const genToken = await siweLogin(apiUrl, accounts.GENERATOR);
    const transToken = await siweLogin(apiUrl, accounts.TRANSPORTER);
    const facToken = await siweLogin(apiUrl, accounts.FACILITY);
    const audToken = await siweLogin(apiUrl, accounts.AUDITOR);

    const runId = Date.now();
    const anchoredTimeline: Array<{
      seq: number;
      eventType: string;
      txHash: string | null;
      blockNumber: number | null;
      anchoredAt: string | null;
      explorerUrl: string | null;
    }> = [];

    // Step 3: Generator creates batch (850 kg + PDF)
    const pdfId = await uploadEvidence(
      apiUrl,
      genToken,
      'staging',
      SAMPLE_PDF,
      'festronik-manifest.pdf',
      'application/pdf',
      'Festronik B3 Manifest',
    );
    const created = await executeSignedCustodyStep({
      apiUrl,
      token: genToken,
      account: accounts.GENERATOR,
      body: {
        kind: 'CREATED',
        data: {
          batchRef: `TB3-DEMO-${runId}`,
          wasteCode: 'B105d',
          wasteName: 'Spent Industrial Solvent',
          quantity: { value: '850', unit: 'kg' },
          festronikRef: `FEST-${runId}`,
          notes: 'Generated at PT Jababeka Precision Manufacturing',
        },
        evidenceIds: [pdfId],
      },
      idempotencyKey: `e2e-create-${runId}`,
    });
    const batchId = created.batchId;
    anchoredTimeline.push(created.anchored);

    // Step 4: Transporter pickup (850 kg + PNG)
    const pngId = await uploadEvidence(
      apiUrl,
      transToken,
      batchId,
      SAMPLE_PNG,
      'pickup-weighbridge.png',
      'image/png',
      'Pickup Weighbridge Photo',
    );
    const pickup = await executeSignedCustodyStep({
      apiUrl,
      token: transToken,
      account: accounts.TRANSPORTER,
      body: {
        kind: 'CUSTODY_TRANSFERRED',
        batchId,
        data: {
          quantity: { value: '850', unit: 'kg' },
          notes: 'Loaded onto hazmat fleet B-9124-TB3',
        },
        evidenceIds: [pngId],
      },
      idempotencyKey: `e2e-pickup-${runId}`,
    });
    anchoredTimeline.push(pickup.anchored);

    // Step 5: Facility delivery (620 kg -> critical discrepancy 230 kg / 27.06%)
    const delivery = await executeSignedCustodyStep({
      apiUrl,
      token: facToken,
      account: accounts.FACILITY,
      body: {
        kind: 'CUSTODY_TRANSFERRED',
        batchId,
        data: {
          quantity: { value: '620', unit: 'kg' },
          notes: 'Initial facility intake scale reading',
        },
      },
      idempotencyKey: `e2e-delivery-${runId}`,
    });
    anchoredTimeline.push(delivery.anchored);

    const discBefore = await apiJson<{
      hasDiscrepancy: boolean;
      maxSeverity: string;
      flags: Array<{
        code: string;
        deltaKg: string | null;
        percent: number | null;
        severity: string;
      }>;
    }>(`${apiUrl}/v1/batches/${batchId}/discrepancies`, {
      headers: { Authorization: `Bearer ${audToken}` },
    });
    assertOk(discBefore.status === 200, 'Discrepancies check failed');
    const totalMismatch = discBefore.data.flags.find(
      (f) => f.code === 'WEIGHT_MISMATCH_TOTAL',
    );
    assertOk(
      discBefore.data.hasDiscrepancy &&
      discBefore.data.maxSeverity === 'critical' &&
      totalMismatch?.deltaKg === '230' &&
      totalMismatch?.percent === 27.06,
      `Expected critical 230kg / 27.06% discrepancy, got ${JSON.stringify(discBefore.data)}`,
    );

    // Step 6: Facility signed revision (845 kg)
    const revision = await executeSignedCustodyStep({
      apiUrl,
      token: facToken,
      account: accounts.FACILITY,
      body: {
        kind: 'REVISION',
        batchId,
        data: {
          targetSeq: 3,
          reasonCode: 'SCALE_RECALIBRATION',
          quantity: { value: '845', unit: 'kg' },
          notes: 'Recalibrated weighbridge scale; original #3 preserved',
        },
      },
      idempotencyKey: `e2e-revision-${runId}`,
    });
    anchoredTimeline.push(revision.anchored);

    // Step 7: Treatment completion (TREATED)
    const treatment = await executeSignedCustodyStep({
      apiUrl,
      token: facToken,
      account: accounts.FACILITY,
      body: {
        kind: 'TREATMENT',
        batchId,
        data: {
          notes: 'Neutralization and recovery completed per KLHK SOP',
        },
      },
      idempotencyKey: `e2e-treatment-${runId}`,
    });
    anchoredTimeline.push(treatment.anchored);

    // Fetch publicId & QR code
    const batchDetail = await apiJson<{ publicId: string; batchRef: string }>(
      `${apiUrl}/v1/batches/${batchId}`,
      { headers: { Authorization: `Bearer ${audToken}` } },
    );
    assertOk(batchDetail.status === 200, 'GET /v1/batches/:id failed');
    const { publicId, batchRef } = batchDetail.data;

    const qrRes = await fetch(`${apiUrl}/v1/batches/${batchId}/qr?format=png`, {
      headers: { Authorization: `Bearer ${genToken}` },
    });
    assertOk(qrRes.status === 200, 'QR generation failed');
    const qrBytes = Buffer.from(await qrRes.arrayBuffer());
    assertOk(
      qrBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
      'QR endpoint did not return PNG bytes',
    );

    // Step 8: Public verification -> VERIFIED & proof bundle -> VERIFIED
    const verifyClean = await apiJson<{ verdict: string }>(
      `${apiUrl}/v1/public/passports/${publicId}/verify`,
    );
    assertOk(
      verifyClean.status === 200 && verifyClean.data.verdict === 'VERIFIED',
      `Expected VERIFIED before tamper, got ${JSON.stringify(verifyClean.data)}`,
    );

    const bundleRes = await apiJson<unknown>(
      `${apiUrl}/v1/public/passports/${publicId}/proof-bundle`,
    );
    assertOk(bundleRes.status === 200, 'GET proof-bundle failed');
    const rpcBundleCheck = await verifyProofBundleAgainstRpc(
      bundleRes.data,
      rpcUrl,
    );
    assertOk(
      rpcBundleCheck.verdict === 'VERIFIED',
      `Trustless bundle check expected VERIFIED, got ${JSON.stringify(rpcBundleCheck)}`,
    );

    // Step 9: Tamper & verify TAMPERED (when DEMO_MODE=true)
    if (demoModeActive) {
      const fileTamper = await apiJson<{ tampered: boolean }>(
        `${apiUrl}/v1/dev/tamper`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'file', batchId, evidenceId: pdfId }),
        },
      );
      assertOk(fileTamper.status === 200, 'File tamper endpoint failed');
      const afterFile = await apiJson<{
        verdict: string;
        affectedFiles: Array<{ issue: string }>;
      }>(`${apiUrl}/v1/public/passports/${publicId}/verify`);
      assertOk(
        afterFile.data.verdict === 'TAMPERED' &&
        afterFile.data.affectedFiles[0]?.issue === 'FILE_MISMATCH',
        `Expected TAMPERED/FILE_MISMATCH, got ${JSON.stringify(afterFile.data)}`,
      );

      const dbTamper = await apiJson<{ tampered: boolean }>(
        `${apiUrl}/v1/dev/tamper`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'db',
            batchId,
            eventSeq: 2,
            tamperedWeightGrams: '999999',
          }),
        },
      );
      assertOk(dbTamper.status === 200, 'DB tamper endpoint failed');
      const afterDb = await apiJson<{
        verdict: string;
        affectedEvents: Array<{ seq: number; verdict: string }>;
      }>(`${apiUrl}/v1/public/passports/${publicId}/verify`);
      assertOk(
        afterDb.data.verdict === 'TAMPERED' &&
        afterDb.data.affectedEvents.some(
          (e) => e.seq === 2 && e.verdict === 'HASH_MISMATCH',
        ),
        `Expected TAMPERED/HASH_MISMATCH on seq 2, got ${JSON.stringify(afterDb.data)}`,
      );
    }

    // Step 10: Print summary + explorer links
    console.log('\n==============================================================');
    console.log(` TRACEB3 E2E Demo PASSED (${chainInfo.networkName}, chainId=${chainInfo.chainId})`);
    console.log('==============================================================');
    console.log(` Batch Ref      : ${batchRef} (${batchId})`);
    console.log(` Public ID      : ${publicId}`);
    console.log(` Ledger Address : ${chainInfo.ledgerAddress}`);
    console.log(' Anchored Events:');
    for (const ev of anchoredTimeline) {
      const explorer =
        ev.explorerUrl ??
        (ev.txHash ? getExplorerTxUrl(chainInfo.chainId, ev.txHash) : null) ??
        '(local hardhat)';
      console.log(
        `   #${ev.seq} ${ev.eventType.padEnd(20)} tx=${ev.txHash} block=${ev.blockNumber} time=${ev.anchoredAt} explorer=${explorer}`,
      );
    }
    console.log(
      demoModeActive
        ? ' Tamper Checks  : VERIFIED -> FILE_MISMATCH (TAMPERED) -> HASH_MISMATCH (TAMPERED)'
        : ' Tamper Checks  : skipped (DEMO_MODE=false on target API)',
    );
  } finally {
    if (relayer) {
      await relayer.stop();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    if (dbClient) {
      await dbClient.close();
    }
    if (hardhatProc && !hardhatProc.killed) {
      hardhatProc.kill();
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((err) => {
  console.error('[e2e] Failed:', err);
  process.exit(1);
});
