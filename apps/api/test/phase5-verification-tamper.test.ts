import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACEB3_LEDGER_ABI } from '@traceb3/contracts';
import {
  computeOnChainBatchId,
  deserializeTypedData,
  EVENT_TYPE_TO_UINT8,
  type CustodyIntentTypedDataJson,
  type EventType,
} from '@traceb3/core';
import { eq } from 'drizzle-orm';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ChainClient } from '../src/chain/client.js';
import { ChainRelayWorker } from '../src/chain/relayer.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDatabase, type DatabaseClient } from '../src/db/index.js';
import { batches, custodyEvents } from '../src/db/schema.js';
import { ChainReconciler } from '../src/jobs/reconciler.js';
import { createLogger } from '../src/logger.js';
import { verifyProofBundleAgainstRpc } from '../src/services/bundle-verifier.js';
import { LocalFsStorage } from '../src/storage/local-fs.js';

const RELAYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADMIN_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const GENERATOR_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const TRANSPORTER_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const FACILITY_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const AUDITOR_ACCOUNT = privateKeyToAccount(generatePrivateKey());

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
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

const VALID_PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'utf8',
);

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForRpc(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const client = createPublicClient({
    chain: hardhat,
    transport: http(rpcUrl),
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await client.getChainId()) === 31337) {
        return;
      }
    } catch {
      // Wait for Hardhat node boot
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Hardhat RPC not ready at ${rpcUrl}`);
}

async function signIn(
  app: ReturnType<typeof createApp>,
  account: ReturnType<typeof privateKeyToAccount>,
  config: AppConfig,
): Promise<string> {
  const nonceRes = await app.request('/v1/auth/nonce');
  expect(nonceRes.status).toBe(200);
  const nonceBody = (await nonceRes.json()) as {
    nonce: string;
    domain: string;
    chainId: number;
  };
  const message = createSiweMessage({
    address: account.address,
    chainId: nonceBody.chainId,
    domain: nonceBody.domain,
    nonce: nonceBody.nonce,
    uri: config.API_PUBLIC_URL,
    version: '1',
    statement: 'Sign in to TRACEB3',
  });
  const signature = await account.signMessage({ message });
  const verifyRes = await app.request('/v1/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  expect(verifyRes.status).toBe(200);
  return ((await verifyRes.json()) as { token: string }).token;
}

async function runSignedIntent(params: {
  app: ReturnType<typeof createApp>;
  relayer: ChainRelayWorker;
  token: string;
  account: ReturnType<typeof privateKeyToAccount>;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ eventId: string; batchId: string; seq: number }> {
  const createRes = await params.app.request('/v1/intents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify(params.payload),
  });
  expect(createRes.status).toBe(201);
  const intent = (await createRes.json()) as {
    intentId: string;
    batchId: string;
    seq: number;
    typedData: CustodyIntentTypedDataJson;
  };
  const sig = await params.account.signTypedData(
    deserializeTypedData(intent.typedData),
  );
  const submitRes = await params.app.request(
    `/v1/intents/${intent.intentId}/submit`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.token}`,
        'Idempotency-Key': params.idempotencyKey,
      },
      body: JSON.stringify({ signature: sig }),
    },
  );
  expect(submitRes.status).toBe(202);
  const submitted = (await submitRes.json()) as { eventId: string };
  await params.relayer.triggerDrain();
  await params.relayer.waitForIdle();

  const statusRes = await params.app.request(
    `/v1/events/${submitted.eventId}/status`,
    { headers: { Authorization: `Bearer ${params.token}` } },
  );
  expect(statusRes.status).toBe(200);
  expect(((await statusRes.json()) as { chainStatus: string }).chainStatus).toBe(
    'ANCHORED',
  );

  return {
    eventId: submitted.eventId,
    batchId: intent.batchId,
    seq: intent.seq,
  };
}

describe('Phase 5 Verification, Public Passports, QR, Reconciler, Tamper Demo & P1 Features', () => {
  let hardhatProc: ChildProcess | null = null;
  let db: DatabaseClient | null = null;
  let relayer: ChainRelayWorker | null = null;
  let reconciler: ChainReconciler | null = null;
  let storage!: LocalFsStorage;
  let chain!: ChainClient;
  let tempDir = '';
  let rpcUrl = '';
  let configFullDemo!: AppConfig;
  let app!: ReturnType<typeof createApp>;

  let generatorToken = '';
  let transporterToken = '';
  let facilityToken = '';
  let auditorToken = '';

  let primaryBatchId = '';
  let primaryPublicId = '';
  let primaryEvidenceId = '';

  beforeAll(async () => {
    const port = await findFreePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'traceb3-phase5-'));

    hardhatProc = spawn(
      process.execPath,
      [HARDHAT_CLI, 'node', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: CONTRACTS_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    await waitForRpc(rpcUrl);

    const artifact = JSON.parse(await fs.readFile(ARTIFACT_PATH, 'utf8')) as {
      bytecode: Hex;
    };
    const relayerAccount = privateKeyToAccount(RELAYER_KEY);
    const deployWallet = createWalletClient({
      account: relayerAccount,
      chain: hardhat,
      transport: http(rpcUrl),
    });
    const publicClient = createPublicClient({
      chain: hardhat,
      transport: http(rpcUrl),
    });

    const deployHash = await deployWallet.deployContract({
      abi: TRACEB3_LEDGER_ABI,
      bytecode: artifact.bytecode,
      args: [relayerAccount.address, relayerAccount.address],
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    });

    configFullDemo = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'pglite://memory',
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: tempDir,
      CHAIN_RPC_URL: rpcUrl,
      CHAIN_ID: '31337',
      LEDGER_ADDRESS: receipt.contractAddress!,
      RELAYER_PRIVATE_KEY: RELAYER_KEY,
      JWT_SECRET: 'phase5-verification-test-secret-key-01',
      SIWE_DOMAIN: 'localhost:3001',
      PUBLIC_APP_URL: 'https://passport.traceb3.example',
      API_PUBLIC_URL: 'http://localhost:3001',
      PUBLIC_VIEW_LEVEL: 'full',
      DEMO_MODE: 'true',
      WEIGHT_TOLERANCE_PCT: '2',
      CUSTODY_GAP_HOURS: '24',
    });

    const logger = createLogger({ level: 'silent' });
    db = await createDatabase('pglite://memory');
    await db.migrate();
    storage = new LocalFsStorage({
      baseDir: tempDir,
      apiPublicUrl: configFullDemo.API_PUBLIC_URL,
      signingSecret: configFullDemo.JWT_SECRET,
    });
    chain = new ChainClient(configFullDemo);
    relayer = new ChainRelayWorker({ config: configFullDemo, logger, db, chain });
    reconciler = new ChainReconciler({
      config: configFullDemo,
      logger,
      db,
      chain,
    });
    relayer.start(200);
    app = createApp({
      config: configFullDemo,
      logger,
      db,
      storage,
      chain,
      relayer,
    });

    // Seed via DEMO_MODE /v1/dev/seed
    const seedRes = await app.request('/v1/dev/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallets: {
          ADMIN: ADMIN_ACCOUNT.address,
          GENERATOR: GENERATOR_ACCOUNT.address,
          TRANSPORTER: TRANSPORTER_ACCOUNT.address,
          FACILITY: FACILITY_ACCOUNT.address,
          AUDITOR: AUDITOR_ACCOUNT.address,
        },
      }),
    });
    expect(seedRes.status).toBe(200);
    const seedJson = (await seedRes.json()) as { onChainRegisteredCount: number };
    expect(seedJson.onChainRegisteredCount).toBe(3);

    generatorToken = await signIn(app, GENERATOR_ACCOUNT, configFullDemo);
    transporterToken = await signIn(app, TRANSPORTER_ACCOUNT, configFullDemo);
    facilityToken = await signIn(app, FACILITY_ACCOUNT, configFullDemo);
    auditorToken = await signIn(app, AUDITOR_ACCOUNT, configFullDemo);
  }, 60_000);

  afterAll(async () => {
    reconciler?.stop();
    if (relayer) {
      await relayer.stop();
    }
    if (db) {
      await db.close();
    }
    if (hardhatProc && !hardhatProc.killed) {
      hardhatProc.kill();
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('completes full lifecycle with SSE status stream, TREATMENT event, batch queries, discrepancies, QR codes, and audit logs', async () => {
    const pdfForm = new FormData();
    pdfForm.append(
      'file',
      new File([VALID_PDF_BYTES], 'manifest-p5.pdf', { type: 'application/pdf' }),
    );
    pdfForm.append('label', 'Festronik Manifest PDF');
    const uploadRes = await app.request('/v1/batches/staging/evidence', {
      method: 'POST',
      headers: { Authorization: `Bearer ${generatorToken}` },
      body: pdfForm,
    });
    expect(uploadRes.status).toBe(201);
    primaryEvidenceId = ((await uploadRes.json()) as { id: string }).id;

    // Create intent #1 and subscribe via SSE stream
    const intentRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${generatorToken}`,
      },
      body: JSON.stringify({
        kind: 'CREATED',
        data: {
          batchRef: 'TB3-2026-P5-001',
          wasteCode: 'B105d',
          wasteName: 'Spent Solvent Blend',
          quantity: { value: '850', unit: 'kg' },
          festronikRef: 'FEST-P5-001',
        },
        evidenceIds: [primaryEvidenceId],
      }),
    });
    expect(intentRes.status).toBe(201);
    const intent1 = (await intentRes.json()) as {
      intentId: string;
      batchId: string;
      typedData: CustodyIntentTypedDataJson;
    };
    primaryBatchId = intent1.batchId;

    const sig1 = await GENERATOR_ACCOUNT.signTypedData(
      deserializeTypedData(intent1.typedData),
    );
    const sub1 = await app.request(`/v1/intents/${intent1.intentId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${generatorToken}`,
        'Idempotency-Key': 'p5-create-1',
      },
      body: JSON.stringify({ signature: sig1 }),
    });
    expect(sub1.status).toBe(202);
    const ev1Id = ((await sub1.json()) as { eventId: string }).eventId;

    // Read SSE stream until closed after ANCHORED
    const sseRes = await app.request(`/v1/events/${ev1Id}/stream`, {
      headers: { Authorization: `Bearer ${generatorToken}` },
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const sseText = await sseRes.text();
    expect(sseText).toContain('ANCHORED');

    // Pickup -> Delivery (620 kg) -> Revision (845 kg) -> Treatment
    await runSignedIntent({
      app,
      relayer: relayer!,
      token: transporterToken,
      account: TRANSPORTER_ACCOUNT,
      payload: {
        kind: 'CUSTODY_TRANSFERRED',
        batchId: primaryBatchId,
        data: { quantity: { value: '850', unit: 'kg' } },
      },
      idempotencyKey: 'p5-pickup-1',
    });

    await runSignedIntent({
      app,
      relayer: relayer!,
      token: facilityToken,
      account: FACILITY_ACCOUNT,
      payload: {
        kind: 'CUSTODY_TRANSFERRED',
        batchId: primaryBatchId,
        data: { quantity: { value: '620', unit: 'kg' } },
      },
      idempotencyKey: 'p5-delivery-1',
    });

    await runSignedIntent({
      app,
      relayer: relayer!,
      token: facilityToken,
      account: FACILITY_ACCOUNT,
      payload: {
        kind: 'REVISION',
        batchId: primaryBatchId,
        data: {
          targetSeq: 3,
          reasonCode: 'SCALE_RECALIBRATION',
          quantity: { value: '845', unit: 'kg' },
          notes: 'Corrected scale offset',
        },
      },
      idempotencyKey: 'p5-revision-1',
    });

    await runSignedIntent({
      app,
      relayer: relayer!,
      token: facilityToken,
      account: FACILITY_ACCOUNT,
      payload: {
        kind: 'TREATMENT',
        batchId: primaryBatchId,
        data: { notes: 'Thermal oxidation completed at PT Nusantara B3 Recovery' },
      },
      idempotencyKey: 'p5-treatment-1',
    });

    // Query batches as generator and auditor
    const listRes = await app.request('/v1/batches?status=TREATED', {
      headers: { Authorization: `Bearer ${generatorToken}` },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      items: Array<{ id: string; publicId: string; status: string }>;
      total: number;
    };
    expect(listJson.total).toBe(1);
    expect(listJson.items[0]?.status).toBe('TREATED');
    primaryPublicId = listJson.items[0]!.publicId;

    // Batch detail, timeline & discrepancies
    const detailRes = await app.request(`/v1/batches/${primaryBatchId}`, {
      headers: { Authorization: `Bearer ${auditorToken}` },
    });
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as { publicPassportUrl: string };
    expect(detailJson.publicPassportUrl).toBe(
      `https://passport.traceb3.example/p/${primaryPublicId}`,
    );

    const timelineRes = await app.request(`/v1/batches/${primaryBatchId}/timeline`, {
      headers: { Authorization: `Bearer ${auditorToken}` },
    });
    expect(timelineRes.status).toBe(200);
    const timelineJson = (await timelineRes.json()) as {
      events: Array<{ seq: number; revisedBySeqs: number[]; eventType: string }>;
    };
    expect(timelineJson.events).toHaveLength(5);
    expect(timelineJson.events[2]?.revisedBySeqs).toEqual([4]);
    expect(timelineJson.events[4]?.eventType).toBe('TREATMENT');

    const discRes = await app.request(`/v1/batches/${primaryBatchId}/discrepancies`, {
      headers: { Authorization: `Bearer ${auditorToken}` },
    });
    expect(discRes.status).toBe(200);
    const discJson = (await discRes.json()) as {
      hasDiscrepancy: boolean;
      maxSeverity: string;
      flags: Array<{ code: string }>;
    };
    expect(discJson.hasDiscrepancy).toBe(false);
    expect(discJson.maxSeverity).toBe('info');
    expect(discJson.flags.some((f) => f.code === 'VALUE_REVISED')).toBe(true);

    // QR PNG + SVG
    const qrPngRes = await app.request(`/v1/batches/${primaryBatchId}/qr?format=png`, {
      headers: { Authorization: `Bearer ${generatorToken}` },
    });
    expect(qrPngRes.status).toBe(200);
    expect(qrPngRes.headers.get('content-type')).toContain('image/png');
    const qrPngBuf = Buffer.from(await qrPngRes.arrayBuffer());
    expect(qrPngBuf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const qrSvgRes = await app.request(`/v1/batches/${primaryBatchId}/qr?format=svg`, {
      headers: { Authorization: `Bearer ${generatorToken}` },
    });
    expect(qrSvgRes.status).toBe(200);
    expect(qrSvgRes.headers.get('content-type')).toContain('image/svg+xml');
    expect(await qrSvgRes.text()).toContain('<svg');

    // Audit log recorded auditor reads
    const auditRes = await app.request('/v1/audit-logs?action=AUDITOR_READ_BATCH', {
      headers: { Authorization: `Bearer ${auditorToken}` },
    });
    expect(auditRes.status).toBe(200);
    const auditJson = (await auditRes.json()) as { items: Array<{ action: string }> };
    expect(auditJson.items.length).toBeGreaterThanOrEqual(1);
    expect(
      (
        await app.request('/v1/audit-logs', {
          headers: { Authorization: `Bearer ${generatorToken}` },
        })
      ).status,
    ).toBe(403);
  });

  it('serves redacted vs full public passports, verifies VERIFIED, and verifies portable proof bundle against RPC only', async () => {
    // Full public passport
    const fullRes = await app.request(`/v1/public/passports/${primaryPublicId}`);
    expect(fullRes.status).toBe(200);
    const fullPassport = (await fullRes.json()) as {
      viewLevel: string;
      declaredWeightGrams?: string;
      events: Array<{ quantity?: unknown; evidence?: unknown[] }>;
    };
    expect(fullPassport.viewLevel).toBe('full');
    expect(fullPassport.declaredWeightGrams).toBe('850000');
    expect(fullPassport.events[0]?.quantity).toBeDefined();
    expect(fullPassport.events[0]?.evidence).toHaveLength(1);

    // Redacted view app sharing same DB/storage/chain
    const redactedConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'pglite://memory',
      CHAIN_RPC_URL: rpcUrl,
      CHAIN_ID: '31337',
      LEDGER_ADDRESS: configFullDemo.LEDGER_ADDRESS,
      RELAYER_PRIVATE_KEY: RELAYER_KEY,
      JWT_SECRET: configFullDemo.JWT_SECRET,
      PUBLIC_VIEW_LEVEL: 'redacted',
      DEMO_MODE: 'false',
    });
    const redactedApp = createApp({
      config: redactedConfig,
      logger: createLogger({ level: 'silent' }),
      db: db!,
      storage,
      chain,
      relayer: relayer!,
    });

    const redRes = await redactedApp.request(
      `/v1/public/passports/${primaryPublicId}`,
    );
    expect(redRes.status).toBe(200);
    const redPassport = (await redRes.json()) as Record<string, unknown>;
    expect(redPassport.viewLevel).toBe('redacted');
    expect(redPassport.declaredWeightGrams).toBeUndefined();
    const redEvents = redPassport.events as Array<Record<string, unknown>>;
    expect(redEvents[0]?.quantity).toBeUndefined();
    expect(redEvents[0]?.evidence).toBeUndefined();

    // DEMO_MODE=false returns 404 for /v1/dev/*
    expect(
      (
        await redactedApp.request('/v1/dev/tamper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'file', batchId: primaryBatchId }),
        })
      ).status,
    ).toBe(404);

    // Public verify -> VERIFIED
    const verifyRes = await app.request(
      `/v1/public/passports/${primaryPublicId}/verify`,
    );
    expect(verifyRes.status).toBe(200);
    const verifyJson = (await verifyRes.json()) as {
      verdict: string;
      onChainEventCount: number;
      events: Array<{ verdict: string }>;
    };
    expect(verifyJson.verdict).toBe('VERIFIED');
    expect(verifyJson.onChainEventCount).toBe(5);
    expect(verifyJson.events.every((e) => e.verdict === 'MATCH')).toBe(true);

    // Proof bundle -> verified strictly via RPC URL
    const bundleRes = await app.request(
      `/v1/public/passports/${primaryPublicId}/proof-bundle`,
    );
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json();
    const bundleVerdict = await verifyProofBundleAgainstRpc(bundle, rpcUrl);
    expect(bundleVerdict.verdict).toBe('VERIFIED');
    expect(bundleVerdict.onChainEventCount).toBe(5);
  });

  it('reconciles on-chain confirmed events left PENDING in PostgreSQL via ChainReconciler', async () => {
    // Pause relayer briefly so we simulate a confirmed on-chain tx whose DB status never got updated
    await relayer!.stop();

    const intentRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${generatorToken}`,
      },
      body: JSON.stringify({
        kind: 'CREATED',
        data: {
          batchRef: 'TB3-2026-RECON-01',
          wasteCode: 'B105d',
          wasteName: 'Reconciler Batch',
          quantity: { value: '300', unit: 'kg' },
        },
      }),
    });
    expect(intentRes.status).toBe(201);
    const intent = (await intentRes.json()) as {
      intentId: string;
      batchId: string;
      typedData: CustodyIntentTypedDataJson;
    };
    const sig = await GENERATOR_ACCOUNT.signTypedData(
      deserializeTypedData(intent.typedData),
    );

    const submitRes = await app.request(`/v1/intents/${intent.intentId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${generatorToken}`,
        'Idempotency-Key': 'p5-reconcile-1',
      },
      body: JSON.stringify({ signature: sig }),
    });
    expect(submitRes.status).toBe(202);
    const { eventId } = (await submitRes.json()) as { eventId: string };

    // Wait for any in-flight drain triggered by submit (though relayer was stopped, waitForIdle ensures quiet)
    await relayer!.waitForIdle();
    const preRows = await db!.db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.id, eventId))
      .limit(1);
    const preEv = preRows[0]!;

    if (preEv.chainStatus !== 'ANCHORED') {
      // Submit directly on-chain bypassing DB anchor update
      const td = deserializeTypedData(intent.typedData);
      const txHash = await chain.walletClient!.writeContract({
        address: chain.requireLedgerAddress(),
        abi: TRACEB3_LEDGER_ABI,
        functionName: 'createBatch',
        args: [
          {
            batchId: computeOnChainBatchId(intent.batchId),
            eventType: EVENT_TYPE_TO_UINT8['CREATED' as EventType],
            eventHash: td.message.eventHash,
            prevHash: td.message.prevHash,
            targetSeq: td.message.targetSeq,
            actor: getAddress(td.message.actor),
            nonce: td.message.nonce,
            deadline: td.message.deadline,
          },
          sig,
        ],
      });
      await chain.publicClient.waitForTransactionReceipt({ hash: txHash });

      const recResult = await reconciler!.reconcileOnce();
      expect(recResult.reconciledEvents).toBe(1);
      expect(recResult.reconciledEventIds).toContain(eventId);
    }

    const postBatch = (
      await db!.db
        .select()
        .from(batches)
        .where(eq(batches.id, intent.batchId))
        .limit(1)
    )[0]!;
    expect(postBatch.status).toBe('REGISTERED');
    relayer!.start(200);
  });

  it('detects file tampering (FILE_MISMATCH) and DB record tampering (HASH_MISMATCH) naming exact targets', async () => {
    // 1. File tamper -> FILE_MISMATCH naming exact evidenceId & filename
    const fileTamperRes = await app.request('/v1/dev/tamper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'file',
        batchId: primaryBatchId,
        evidenceId: primaryEvidenceId,
      }),
    });
    expect(fileTamperRes.status).toBe(200);

    const verifyAfterFileTamper = await app.request(
      `/v1/public/passports/${primaryPublicId}/verify`,
    );
    expect(verifyAfterFileTamper.status).toBe(200);
    const fileVerdict = (await verifyAfterFileTamper.json()) as {
      verdict: string;
      affectedFiles: Array<{
        evidenceId: string | null;
        filename: string;
        issue: string;
      }>;
      events: Array<{ seq: number; verdict: string }>;
    };
    expect(fileVerdict.verdict).toBe('TAMPERED');
    expect(fileVerdict.events[0]?.verdict).toBe('FILE_MISMATCH');
    expect(fileVerdict.affectedFiles[0]).toMatchObject({
      evidenceId: primaryEvidenceId,
      filename: 'manifest-p5.pdf',
      issue: 'FILE_MISMATCH',
    });

    // 2. DB tamper on seq #2 -> HASH_MISMATCH naming exact eventId & seq
    const dbTamperRes = await app.request('/v1/dev/tamper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'db',
        batchId: primaryBatchId,
        eventSeq: 2,
        tamperedWeightGrams: '999999',
      }),
    });
    expect(dbTamperRes.status).toBe(200);
    const dbTamperedBody = (await dbTamperRes.json()) as { eventId: string };

    // Trigger must remain re-enabled after tamper demo
    await expect(
      db!.db
        .update(custodyEvents)
        .set({ eventHash: '0x' + 'ff'.repeat(32) })
        .where(eq(custodyEvents.id, dbTamperedBody.eventId)),
    ).rejects.toThrow(/immutable/i);

    const verifyAfterDbTamper = await app.request(
      `/v1/public/passports/${primaryPublicId}/verify`,
    );
    expect(verifyAfterDbTamper.status).toBe(200);
    const dbVerdict = (await verifyAfterDbTamper.json()) as {
      verdict: string;
      affectedEvents: Array<{ eventId: string; seq: number; verdict: string }>;
      events: Array<{ seq: number; verdict: string }>;
    };
    expect(dbVerdict.verdict).toBe('TAMPERED');
    expect(dbVerdict.events[1]?.verdict).toBe('HASH_MISMATCH');
    expect(
      dbVerdict.affectedEvents.some(
        (e) =>
          e.eventId === dbTamperedBody.eventId &&
          e.seq === 2 &&
          e.verdict === 'HASH_MISMATCH',
      ),
    ).toBe(true);

    // Exported proof bundle also fails trustless verification against RPC
    const tamperedBundle = await (
      await app.request(`/v1/public/passports/${primaryPublicId}/proof-bundle`)
    ).json();
    const bundleCheck = await verifyProofBundleAgainstRpc(tamperedBundle, rpcUrl);
    expect(bundleCheck.verdict).toBe('TAMPERED');
    expect(bundleCheck.events[1]?.verdict).toBe('HASH_MISMATCH');
  });

  it('enforces RFC 9457 rate limiting on public routes', async () => {
    const rlApp = createApp({
      config: configFullDemo,
      logger: createLogger({ level: 'silent' }),
      db: db!,
      storage,
      chain,
      relayer: relayer!,
      rateLimits: { publicMax: 2, authMax: 5, windowMs: 60_000 },
    });

    expect(
      (await rlApp.request(`/v1/public/passports/${primaryPublicId}`)).status,
    ).toBe(200);
    expect(
      (await rlApp.request(`/v1/public/passports/${primaryPublicId}`)).status,
    ).toBe(200);

    const limitedRes = await rlApp.request(
      `/v1/public/passports/${primaryPublicId}`,
    );
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get('retry-after')).toBeTruthy();
    expect(((await limitedRes.json()) as { code: string }).code).toBe(
      'RATE_LIMITED',
    );
  });

  it('lists public passports and resolves public lookups by publicId, batchRef, and txHash', async () => {
    const listRes = await app.request('/v1/public/passports?limit=10');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      viewLevel: string;
      total: number;
      items: Array<{
        publicId: string;
        batchId: string;
        batchRef: string;
        hasRevisions: boolean;
        hasDiscrepancy: boolean;
        declaredWeightGrams: string | null;
        effectiveWeights: {
          declaredGrams: string | null;
          pickupGrams: string | null;
          deliveryGrams: string | null;
        };
      }>;
    };
    expect(listBody.viewLevel).toBe('full');
    expect(listBody.total).toBeGreaterThanOrEqual(1);
    const found = listBody.items.find((i) => i.publicId === primaryPublicId);
    expect(found).toBeDefined();
    expect(found?.hasRevisions).toBe(true);
    expect(found?.declaredWeightGrams).toBe('850000');

    const flaggedRes = await app.request('/v1/public/passports?flagged=true');
    expect(flaggedRes.status).toBe(200);
    const flaggedBody = (await flaggedRes.json()) as {
      items: Array<{ publicId: string; hasDiscrepancy: boolean }>;
    };
    expect(flaggedBody.items.every((i) => i.hasDiscrepancy)).toBe(true);

    // Lookup by publicId
    const byPub = await app.request(
      `/v1/public/lookup?q=${encodeURIComponent(primaryPublicId)}`,
    );
    expect(byPub.status).toBe(200);
    expect(((await byPub.json()) as { matchedBy: string }).matchedBy).toBe('publicId');

    // Lookup by case-insensitive batchRef
    const byRef = await app.request(
      `/v1/public/lookup?q=${encodeURIComponent(found!.batchRef.toLowerCase())}`,
    );
    expect(byRef.status).toBe(200);
    const byRefBody = (await byRef.json()) as { publicId: string; matchedBy: string };
    expect(byRefBody.publicId).toBe(primaryPublicId);
    expect(byRefBody.matchedBy).toBe('batchRef');

    // Lookup by txHash
    const passportRes = await app.request(`/v1/public/passports/${primaryPublicId}`);
    const passportJson = (await passportRes.json()) as {
      events: Array<{ txHash: string | null }>;
    };
    const txHash = passportJson.events.find((e) => e.txHash)?.txHash;
    expect(txHash).toBeTruthy();

    const byTx = await app.request(`/v1/public/lookup?q=${encodeURIComponent(txHash!)}`);
    expect(byTx.status).toBe(200);
    const byTxBody = (await byTx.json()) as { publicId: string; matchedBy: string };
    expect(byTxBody.publicId).toBe(primaryPublicId);
    expect(byTxBody.matchedBy).toBe('txHash');

    // Unknown lookup -> 404
    const missing = await app.request('/v1/public/lookup?q=DOES-NOT-EXIST-999');
    expect(missing.status).toBe(404);
  });
});
