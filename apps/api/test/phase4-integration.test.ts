import { createHash } from 'node:crypto';
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
  type CustodyIntentTypedDataJson,
} from '@traceb3/core';
import { eq } from 'drizzle-orm';
import {
  createPublicClient,
  createWalletClient,
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
import { batches, chainJobs, members, newId, organizations } from '../src/db/schema.js';
import { createLogger } from '../src/logger.js';
import { LocalFsStorage } from '../src/storage/local-fs.js';

// Hardhat deterministic dev accounts (test-only)
const RELAYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ADMIN_ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const GENERATOR_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const TRANSPORTER_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const FACILITY_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const AUDITOR_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const EXTRA_GEN_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const STRANGER_ACCOUNT = privateKeyToAccount(generatePrivateKey());

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
// Minimal valid 1x1 PNG
const VALID_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to obtain free port')));
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
      const chainId = await client.getChainId();
      if (chainId === 31337) {
        return;
      }
    } catch {
      // Retry until node finishes booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Hardhat RPC did not become ready at ${rpcUrl} within ${timeoutMs}ms`);
}

async function signInWithSiwe(
  app: ReturnType<typeof createApp>,
  account: ReturnType<typeof privateKeyToAccount>,
  config: AppConfig,
) {
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

  return { verifyRes, message, signature, nonce: nonceBody.nonce };
}

async function waitForEventTerminalStatus(
  app: ReturnType<typeof createApp>,
  token: string,
  eventId: string,
  relayer: ChainRelayWorker,
): Promise<{
  eventId: string;
  chainStatus: string;
  txHash: string | null;
  blockNumber: number | null;
  anchoredAt: string | null;
  failureReason: string | null;
}> {
  await relayer.triggerDrain();
  await relayer.waitForIdle();

  const res = await app.request(`/v1/events/${eventId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    eventId: string;
    chainStatus: string;
    txHash: string | null;
    blockNumber: number | null;
    anchoredAt: string | null;
    failureReason: string | null;
  };
}

describe('Phase 4 Integration — Auth, Admin Registry, Evidence, Intents & Chain Relay against Local Hardhat', () => {
  let hardhatProc: ChildProcess | null = null;
  let db: DatabaseClient | null = null;
  let relayer: ChainRelayWorker | null = null;
  let tempDir = '';
  let config!: AppConfig;
  let chain!: ChainClient;
  let app!: ReturnType<typeof createApp>;

  let adminToken = '';
  let generatorToken = '';
  let transporterToken = '';
  let facilityToken = '';
  let auditorToken = '';
  let extraGenToken = '';

  let genOrgId = '';
  let transOrgId = '';
  let facOrgId = '';

  beforeAll(async () => {
    const port = await findFreePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'traceb3-phase4-'));

    const hhLogs: string[] = [];
    hardhatProc = spawn(
      process.execPath,
      [HARDHAT_CLI, 'node', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: CONTRACTS_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    hardhatProc.stdout?.on('data', (chunk) => hhLogs.push(String(chunk)));
    hardhatProc.stderr?.on('data', (chunk) => hhLogs.push(String(chunk)));

    await waitForRpc(rpcUrl);

    const artifactRaw = await fs.readFile(ARTIFACT_PATH, 'utf8');
    const artifact = JSON.parse(artifactRaw) as { bytecode: Hex };
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

    const deployTxHash = await deployWallet.deployContract({
      abi: TRACEB3_LEDGER_ABI,
      bytecode: artifact.bytecode,
      args: [relayerAccount.address, relayerAccount.address],
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployTxHash,
    });
    const ledgerAddress = deployReceipt.contractAddress!;

    config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'pglite://memory',
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: tempDir,
      CHAIN_RPC_URL: rpcUrl,
      CHAIN_ID: '31337',
      LEDGER_ADDRESS: ledgerAddress,
      RELAYER_PRIVATE_KEY: RELAYER_KEY,
      JWT_SECRET: 'phase4-integration-test-secret-key-01',
      SIWE_DOMAIN: 'localhost:3001',
      API_PUBLIC_URL: 'http://localhost:3001',
      MAX_UPLOAD_MB: '0.05', // 50 KB threshold for quick size-limit testing
      WEIGHT_TOLERANCE_PCT: '2',
      CUSTODY_GAP_HOURS: '24',
    });

    const logger = createLogger({ level: 'silent' });
    db = await createDatabase('pglite://memory');
    await db.migrate();
    const storage = new LocalFsStorage({
      baseDir: tempDir,
      apiPublicUrl: config.API_PUBLIC_URL,
      signingSecret: config.JWT_SECRET,
    });
    chain = new ChainClient(config);
    relayer = new ChainRelayWorker({ config, logger, db, chain });
    relayer.start(200);
    app = createApp({ config, logger, db, storage, chain, relayer });

    // Seed initial bootstrap ADMIN organization + member directly in DB
    const regOrgId = newId();
    await db.db.insert(organizations).values({
      id: regOrgId,
      name: 'Jababeka Regulator Bootstrap',
      orgType: 'regulator',
      code: 'JAB-ADMIN-BOOT',
      onChainOrgId: '0x' + 'aa'.repeat(32),
    });
    await db.db.insert(members).values({
      id: newId(),
      orgId: regOrgId,
      walletAddress: ADMIN_ACCOUNT.address.toLowerCase(),
      displayName: 'Bootstrap Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
  }, 60_000);

  afterAll(async () => {
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

  it('reports /readyz ready and /v1/chain/info + OpenAPI routes', async () => {
    const readyRes = await app.request('/readyz');
    expect(readyRes.status).toBe(200);
    const readyJson = (await readyRes.json()) as {
      status: string;
      checks: {
        database: { ok: boolean };
        storage: { ok: boolean };
        chain: { ok: boolean; contract: { ok: boolean }; relayer: { ok: boolean } };
      };
    };
    expect(readyJson.status).toBe('ready');
    expect(readyJson.checks.chain.ok).toBe(true);
    expect(readyJson.checks.chain.contract.ok).toBe(true);
    expect(readyJson.checks.chain.relayer.ok).toBe(true);

    const chainRes = await app.request('/v1/chain/info');
    expect(chainRes.status).toBe(200);
    const chainInfo = (await chainRes.json()) as {
      chainId: number;
      ledgerAddress: string;
    };
    expect(chainInfo.chainId).toBe(31337);
    expect(chainInfo.ledgerAddress.toLowerCase()).toBe(
      config.LEDGER_ADDRESS!.toLowerCase(),
    );

    const specRes = await app.request('/openapi.json');
    expect(specRes.status).toBe(200);
    const spec = (await specRes.json()) as { paths: Record<string, unknown> };
    expect(spec.paths['/v1/auth/verify']).toBeDefined();
    expect(spec.paths['/v1/intents']).toBeDefined();
    expect(spec.paths['/v1/batches/{id}/evidence']).toBeDefined();
  });

  it('authenticates via SIWE, blocks nonce replay & unregistered wallets, and provisions actors on-chain via Admin API', async () => {
    // 1. Unregistered wallet rejected with 403
    const strangerAttempt = await signInWithSiwe(app, STRANGER_ACCOUNT, config);
    expect(strangerAttempt.verifyRes.status).toBe(403);

    // 2. Admin logs in via SIWE
    const adminLogin = await signInWithSiwe(app, ADMIN_ACCOUNT, config);
    expect(adminLogin.verifyRes.status).toBe(200);
    const adminSession = (await adminLogin.verifyRes.json()) as {
      token: string;
      member: { role: string };
    };
    expect(adminSession.member.role).toBe('ADMIN');
    adminToken = adminSession.token;

    // 3. Replay of used SIWE nonce is rejected with 401
    const replayRes = await app.request('/v1/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: adminLogin.message,
        signature: adminLogin.signature,
      }),
    });
    expect(replayRes.status).toBe(401);

    // 4. /v1/auth/me reflects active session
    const meRes = await app.request('/v1/auth/me', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(meRes.status).toBe(200);

    // 5. Admin creates organizations & registers members (with on-chain actor registration)
    const createOrg = async (name: string, orgType: string, code: string) => {
      const res = await app.request('/v1/admin/organizations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name, orgType, code }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; onChainOrgId: string };
    };

    const genOrg = await createOrg('PT Jababeka Mfg', 'generator', 'GEN-01');
    const transOrg = await createOrg('PT Cikarang Logistics', 'transporter', 'TRN-01');
    const facOrg = await createOrg('PT Nusantara Recovery', 'facility', 'FAC-01');
    const regOrg = await createOrg('KLHK Audit Desk', 'regulator', 'REG-01');

    genOrgId = genOrg.id;
    transOrgId = transOrg.id;
    facOrgId = facOrg.id;

    const createMember = async (
      orgId: string,
      walletAddress: string,
      displayName: string,
      role: string,
    ) => {
      const res = await app.request('/v1/admin/members', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ orgId, walletAddress, displayName, role }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; onChainTxHash: string | null };
    };

    const genMem = await createMember(genOrgId, GENERATOR_ACCOUNT.address, 'Gen Op', 'GENERATOR');
    const transMem = await createMember(transOrgId, TRANSPORTER_ACCOUNT.address, 'Driver', 'TRANSPORTER');
    const facMem = await createMember(facOrgId, FACILITY_ACCOUNT.address, 'Facility Mgr', 'FACILITY');
    const audMem = await createMember(regOrg.id, AUDITOR_ACCOUNT.address, 'Auditor', 'AUDITOR');
    await createMember(genOrgId, EXTRA_GEN_ACCOUNT.address, 'Extra Gen Op', 'GENERATOR');

    expect(genMem.onChainTxHash).toBeTruthy();
    expect(transMem.onChainTxHash).toBeTruthy();
    expect(facMem.onChainTxHash).toBeTruthy();
    expect(audMem.onChainTxHash).toBeNull();

    // Verify on-chain actor state directly
    const onChainGen = await chain.getActorInfo(GENERATOR_ACCOUNT.address);
    expect(onChainGen.active).toBe(true);
    expect(onChainGen.role).toBe(1);
    expect(onChainGen.orgId.toLowerCase()).toBe(genOrg.onChainOrgId.toLowerCase());

    // Login all test actors via SIWE
    generatorToken = ((await (await signInWithSiwe(app, GENERATOR_ACCOUNT, config)).verifyRes.json()) as { token: string }).token;
    transporterToken = ((await (await signInWithSiwe(app, TRANSPORTER_ACCOUNT, config)).verifyRes.json()) as { token: string }).token;
    facilityToken = ((await (await signInWithSiwe(app, FACILITY_ACCOUNT, config)).verifyRes.json()) as { token: string }).token;
    auditorToken = ((await (await signInWithSiwe(app, AUDITOR_ACCOUNT, config)).verifyRes.json()) as { token: string }).token;
    extraGenToken = ((await (await signInWithSiwe(app, EXTRA_GEN_ACCOUNT, config)).verifyRes.json()) as { token: string }).token;
  });

  it('enforces role x endpoint authorization matrix', async () => {
    // 401 unauthenticated
    expect((await app.request('/v1/auth/me')).status).toBe(401);
    expect(
      (
        await app.request('/v1/admin/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request('/v1/intents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);

    // 403 non-admin on admin endpoints
    expect(
      (
        await app.request('/v1/admin/organizations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${generatorToken}`,
          },
          body: JSON.stringify({
            name: 'Unauthorized Org',
            orgType: 'generator',
            code: 'UNAUTH-01',
          }),
        })
      ).status,
    ).toBe(403);

    // 403 auditor cannot upload evidence or create intents
    const auditorForm = new FormData();
    auditorForm.append(
      'file',
      new File([VALID_PDF_BYTES], 'manifest.pdf', { type: 'application/pdf' }),
    );
    expect(
      (
        await app.request('/v1/batches/staging/evidence', {
          method: 'POST',
          headers: { Authorization: `Bearer ${auditorToken}` },
          body: auditorForm,
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await app.request('/v1/intents', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auditorToken}`,
          },
          body: JSON.stringify({
            kind: 'CREATED',
            data: {
              wasteCode: 'B105d',
              wasteName: 'Solvent',
              quantity: { value: '100', unit: 'kg' },
            },
          }),
        })
      ).status,
    ).toBe(403);

    // 403 transporter cannot submit CREATED intent
    expect(
      (
        await app.request('/v1/intents', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${transporterToken}`,
          },
          body: JSON.stringify({
            kind: 'CREATED',
            data: {
              wasteCode: 'B105d',
              wasteName: 'Solvent',
              quantity: { value: '100', unit: 'kg' },
            },
          }),
        })
      ).status,
    ).toBe(403);
  });

  it('validates multipart magic bytes and size limits, computes server-side SHA-256, and serves signed downloads', async () => {
    // Reject spoofed Content-Type with non-PDF bytes
    const spoofedForm = new FormData();
    spoofedForm.append(
      'file',
      new File([Buffer.from('not-actually-a-pdf-payload')], 'fake.pdf', {
        type: 'application/pdf',
      }),
    );
    const spoofRes = await app.request('/v1/batches/staging/evidence', {
      method: 'POST',
      headers: { Authorization: `Bearer ${generatorToken}` },
      body: spoofedForm,
    });
    expect(spoofRes.status).toBe(415);
    const spoofProblem = (await spoofRes.json()) as { code: string };
    expect(spoofProblem.code).toBe('EVIDENCE_TYPE_NOT_ALLOWED');

    // Reject oversized PDF (> 50 KB configured in test)
    const oversizedBuf = Buffer.concat([VALID_PDF_BYTES, Buffer.alloc(65_000, 0x20)]);
    const bigForm = new FormData();
    bigForm.append(
      'file',
      new File([oversizedBuf], 'huge.pdf', { type: 'application/pdf' }),
    );
    const bigRes = await app.request('/v1/batches/staging/evidence', {
      method: 'POST',
      headers: { Authorization: `Bearer ${generatorToken}` },
      body: bigForm,
    });
    expect(bigRes.status).toBe(413);
    expect(((await bigRes.json()) as { code: string }).code).toBe(
      'EVIDENCE_TOO_LARGE',
    );

    // Upload valid PNG with wrong MIME header (must detect image/png from magic bytes!)
    const validForm = new FormData();
    validForm.append(
      'file',
      new File([VALID_PNG_BYTES], 'scale.png', { type: 'application/octet-stream' }),
    );
    validForm.append('label', 'Weighbridge photo');
    const uploadRes = await app.request('/v1/batches/staging/evidence', {
      method: 'POST',
      headers: { Authorization: `Bearer ${generatorToken}` },
      body: validForm,
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = (await uploadRes.json()) as {
      id: string;
      mimeType: string;
      sha256: string;
      sizeBytes: number;
    };
    expect(uploaded.mimeType).toBe('image/png');
    expect(uploaded.sizeBytes).toBe(VALID_PNG_BYTES.byteLength);
    expect(uploaded.sha256).toBe(
      createHash('sha256').update(VALID_PNG_BYTES).digest('hex'),
    );

    // Unrelated org cannot download staging file belonging to genOrg (if different org)
    const crossOrgDl = await app.request(`/v1/evidence/${uploaded.id}/download`, {
      headers: { Authorization: `Bearer ${transporterToken}` },
    });
    expect(crossOrgDl.status).toBe(403);

    // Auditor can request signed URL and stream exact bytes
    const audDl = await app.request(`/v1/evidence/${uploaded.id}/download`, {
      headers: { Authorization: `Bearer ${auditorToken}` },
    });
    expect(audDl.status).toBe(200);
    const dlBody = (await audDl.json()) as { url: string };
    const signedPath = new URL(dlBody.url).pathname;
    const blobRes = await app.request(signedPath);
    expect(blobRes.status).toBe(200);
    const downloadedBytes = Buffer.from(await blobRes.arrayBuffer());
    expect(downloadedBytes.equals(VALID_PNG_BYTES)).toBe(true);
  });

  it('executes full custody lifecycle, enforces Idempotency-Key & 409 BATCH_BUSY, anchors on-chain, flags 850->620 critical discrepancy, and handles revision', async () => {
    // 1. Stage PDF evidence as Generator
    const pdfForm = new FormData();
    pdfForm.append(
      'file',
      new File([VALID_PDF_BYTES], 'festronik-manifest.pdf', {
        type: 'application/pdf',
      }),
    );
    pdfForm.append('label', 'Festronik Manifest');
    const pdfUpload = await app.request('/v1/batches/staging/evidence', {
      method: 'POST',
      headers: { Authorization: `Bearer ${generatorToken}` },
      body: pdfForm,
    });
    expect(pdfUpload.status).toBe(201);
    const pdfMeta = (await pdfUpload.json()) as { id: string };

    // 2. Generator creates CREATED intent (850 kg)
    const createIntentRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${generatorToken}`,
      },
      body: JSON.stringify({
        kind: 'CREATED',
        data: {
          batchRef: 'TB3-2026-INTEG-01',
          wasteCode: 'B105d',
          wasteName: 'Spent Industrial Solvent',
          quantity: { value: '850', unit: 'kg' },
          festronikRef: 'FEST-2026-991',
        },
        evidenceIds: [pdfMeta.id],
      }),
    });
    expect(createIntentRes.status).toBe(201);
    const createdIntent = (await createIntentRes.json()) as {
      intentId: string;
      batchId: string;
      seq: number;
      eventHash: string;
      typedData: CustodyIntentTypedDataJson;
    };

    const genSig = await GENERATOR_ACCOUNT.signTypedData(
      deserializeTypedData(createdIntent.typedData),
    );

    // Missing Idempotency-Key -> 400
    const missingIdemRes = await app.request(
      `/v1/intents/${createdIntent.intentId}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${generatorToken}`,
        },
        body: JSON.stringify({ signature: genSig }),
      },
    );
    expect(missingIdemRes.status).toBe(400);

    // Submit with Idempotency-Key -> 202
    const submit1 = await app.request(
      `/v1/intents/${createdIntent.intentId}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${generatorToken}`,
          'Idempotency-Key': 'idem-create-01',
        },
        body: JSON.stringify({ signature: genSig }),
      },
    );
    expect(submit1.status).toBe(202);
    const submit1Body = (await submit1.json()) as {
      eventId: string;
      batchId: string;
      status: string;
    };

    // Idempotent replay returns exact same 202 payload
    const replaySubmit = await app.request(
      `/v1/intents/${createdIntent.intentId}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${generatorToken}`,
          'Idempotency-Key': 'idem-create-01',
        },
        body: JSON.stringify({ signature: genSig }),
      },
    );
    expect(replaySubmit.status).toBe(202);
    expect(((await replaySubmit.json()) as { eventId: string }).eventId).toBe(
      submit1Body.eventId,
    );

    // Wait for anchor #1
    const status1 = await waitForEventTerminalStatus(
      app,
      generatorToken,
      submit1Body.eventId,
      relayer!,
    );
    expect(status1.chainStatus).toBe('ANCHORED');
    expect(status1.txHash).toBeTruthy();
    expect(status1.blockNumber).toBeGreaterThan(0);
    expect(status1.anchoredAt).toBeTruthy();

    // Verify on-chain state directly
    const onChainBatchId = computeOnChainBatchId(createdIntent.batchId);
    expect(await chain.getEventCount(onChainBatchId)).toBe(1);
    const onChainEv1 = await chain.getAnchoredEvent(onChainBatchId, 1);
    expect(onChainEv1.eventHash.toLowerCase()).toBe(
      createdIntent.eventHash.toLowerCase(),
    );

    // 3. Transporter creates pickup intent (850 kg) and verify 409 BATCH_BUSY while in flight
    const pickupIntentRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${transporterToken}`,
      },
      body: JSON.stringify({
        kind: 'CUSTODY_TRANSFERRED',
        batchId: createdIntent.batchId,
        data: { quantity: { value: '850', unit: 'kg' } },
        evidenceIds: [],
      }),
    });
    expect(pickupIntentRes.status).toBe(201);
    const pickupIntent = (await pickupIntentRes.json()) as {
      intentId: string;
      typedData: CustodyIntentTypedDataJson;
    };
    const transSig = await TRANSPORTER_ACCOUNT.signTypedData(
      deserializeTypedData(pickupIntent.typedData),
    );

    // Hold the relayer mutex briefly so seq=2 remains PENDING while we test 409 BATCH_BUSY
    let releaseMutex!: () => void;
    const mutexGate = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    const heldTask = relayer!.enqueueExclusive(() => mutexGate);

    const submitPickup = await app.request(
      `/v1/intents/${pickupIntent.intentId}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${transporterToken}`,
          'Idempotency-Key': 'idem-pickup-01',
        },
        body: JSON.stringify({ signature: transSig }),
      },
    );
    expect(submitPickup.status).toBe(202);
    const pickupSubmitted = (await submitPickup.json()) as { eventId: string };

    // Concurrent intent request while event #2 is in-flight MUST return 409 BATCH_BUSY
    const busyRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${facilityToken}`,
      },
      body: JSON.stringify({
        kind: 'CUSTODY_TRANSFERRED',
        batchId: createdIntent.batchId,
        data: { quantity: { value: '850', unit: 'kg' } },
      }),
    });
    expect(busyRes.status).toBe(409);
    expect(((await busyRes.json()) as { code: string }).code).toBe('BATCH_BUSY');

    releaseMutex();
    await heldTask;

    const status2 = await waitForEventTerminalStatus(
      app,
      transporterToken,
      pickupSubmitted.eventId,
      relayer!,
    );
    expect(status2.chainStatus).toBe('ANCHORED');

    // 4. Facility delivers with 620 kg -> critical discrepancy flagged
    const delivIntentRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${facilityToken}`,
      },
      body: JSON.stringify({
        kind: 'CUSTODY_TRANSFERRED',
        batchId: createdIntent.batchId,
        data: { quantity: { value: '620', unit: 'kg' } },
      }),
    });
    expect(delivIntentRes.status).toBe(201);
    const delivIntent = (await delivIntentRes.json()) as {
      intentId: string;
      typedData: CustodyIntentTypedDataJson;
    };
    const facSig1 = await FACILITY_ACCOUNT.signTypedData(
      deserializeTypedData(delivIntent.typedData),
    );
    const submitDeliv = await app.request(
      `/v1/intents/${delivIntent.intentId}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facilityToken}`,
          'Idempotency-Key': 'idem-deliv-01',
        },
        body: JSON.stringify({ signature: facSig1 }),
      },
    );
    expect(submitDeliv.status).toBe(202);
    const delivSubmitted = (await submitDeliv.json()) as { eventId: string };
    const status3 = await waitForEventTerminalStatus(
      app,
      facilityToken,
      delivSubmitted.eventId,
      relayer!,
    );
    expect(status3.chainStatus).toBe('ANCHORED');

    const batchAfterDelivery = (
      await db!.db
        .select()
        .from(batches)
        .where(eq(batches.id, createdIntent.batchId))
        .limit(1)
    )[0]!;
    expect(batchAfterDelivery.status).toBe('RECEIVED');
    expect(batchAfterDelivery.hasDiscrepancy).toBe(true);
    expect(batchAfterDelivery.maxDiscrepancySeverity).toBe('critical');
    expect(batchAfterDelivery.currentCustodianOrgId).toBe(facOrgId);

    // 5. Facility submits REVISION for targetSeq=3 correcting weight to 845 kg
    const revIntentRes = await app.request('/v1/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${facilityToken}`,
      },
      body: JSON.stringify({
        kind: 'REVISION',
        batchId: createdIntent.batchId,
        data: {
          targetSeq: 3,
          reasonCode: 'SCALE_RECALIBRATION',
          quantity: { value: '845', unit: 'kg' },
          notes: 'Reweighed after truck scale calibration',
        },
      }),
    });
    expect(revIntentRes.status).toBe(201);
    const revIntent = (await revIntentRes.json()) as {
      intentId: string;
      typedData: CustodyIntentTypedDataJson;
    };
    const facSig2 = await FACILITY_ACCOUNT.signTypedData(
      deserializeTypedData(revIntent.typedData),
    );
    const submitRev = await app.request(
      `/v1/intents/${revIntent.intentId}/submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facilityToken}`,
          'Idempotency-Key': 'idem-rev-01',
        },
        body: JSON.stringify({ signature: facSig2 }),
      },
    );
    expect(submitRev.status).toBe(202);
    const revSubmitted = (await submitRev.json()) as { eventId: string };
    const status4 = await waitForEventTerminalStatus(
      app,
      facilityToken,
      revSubmitted.eventId,
      relayer!,
    );
    expect(status4.chainStatus).toBe('ANCHORED');

    const batchAfterRevision = (
      await db!.db
        .select()
        .from(batches)
        .where(eq(batches.id, createdIntent.batchId))
        .limit(1)
    )[0]!;
    expect(batchAfterRevision.status).toBe('RECEIVED');
    expect(batchAfterRevision.hasDiscrepancy).toBe(false);
    expect(batchAfterRevision.maxDiscrepancySeverity).toBe('info');
    expect(await chain.getEventCount(onChainBatchId)).toBe(4);
    expect(transOrgId).toBeTruthy();
  });

  it('marks custody event and chain_job FAILED without retrying when contract simulation reverts', async () => {
    // Extra Generator prepares TWO CREATED intents while nonce == 0 on-chain
    const makeCreateIntent = async (batchRef: string) => {
      const res = await app.request('/v1/intents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${extraGenToken}`,
        },
        body: JSON.stringify({
          kind: 'CREATED',
          data: {
            batchRef,
            wasteCode: 'B105d',
            wasteName: 'Solvent',
            quantity: { value: '100', unit: 'kg' },
          },
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as {
        intentId: string;
        typedData: CustodyIntentTypedDataJson;
      };
    };

    const intentA = await makeCreateIntent('TB3-2026-NONCE-A');
    const intentB = await makeCreateIntent('TB3-2026-NONCE-B');
    expect(intentA.typedData.message.nonce).toBe('0');
    expect(intentB.typedData.message.nonce).toBe('0');

    const sigA = await EXTRA_GEN_ACCOUNT.signTypedData(
      deserializeTypedData(intentA.typedData),
    );
    const sigB = await EXTRA_GEN_ACCOUNT.signTypedData(
      deserializeTypedData(intentB.typedData),
    );

    const submitA = await app.request(`/v1/intents/${intentA.intentId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${extraGenToken}`,
        'Idempotency-Key': 'idem-nonce-a',
      },
      body: JSON.stringify({ signature: sigA }),
    });
    expect(submitA.status).toBe(202);
    const evA = ((await submitA.json()) as { eventId: string }).eventId;
    const statusA = await waitForEventTerminalStatus(
      app,
      extraGenToken,
      evA,
      relayer!,
    );
    expect(statusA.chainStatus).toBe('ANCHORED');

    // Submit intentB with now-stale nonce=0 -> simulation catches InvalidAccountNonce and marks FAILED with 1 attempt
    const submitB = await app.request(`/v1/intents/${intentB.intentId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${extraGenToken}`,
        'Idempotency-Key': 'idem-nonce-b',
      },
      body: JSON.stringify({ signature: sigB }),
    });
    expect(submitB.status).toBe(202);
    const evB = ((await submitB.json()) as { eventId: string }).eventId;
    const statusB = await waitForEventTerminalStatus(
      app,
      extraGenToken,
      evB,
      relayer!,
    );
    expect(statusB.chainStatus).toBe('FAILED');
    expect(statusB.failureReason).toContain('InvalidAccountNonce');

    const jobB = (
      await db!.db
        .select()
        .from(chainJobs)
        .where(eq(chainJobs.eventId, evB))
        .limit(1)
    )[0]!;
    expect(jobB.status).toBe('FAILED');
    expect(jobB.attempts).toBe(1);
  });
});
