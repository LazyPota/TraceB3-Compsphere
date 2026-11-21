import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  buildCanonicalEventRecord,
  computeEventHash,
  computeOnChainBatchId,
  computeOnChainOrgId,
  ZERO_BYTES32,
} from '@traceb3/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, type DatabaseClient } from '../src/db/index.js';
import {
  batches,
  custodyEvents,
  evidenceFiles,
  members,
  newId,
  organizations,
} from '../src/db/schema.js';
import { createLogger } from '../src/logger.js';
import { seedDemoData } from '../src/services/seed.js';

const ALL_TABLES = [
  'organizations',
  'members',
  'siwe_nonces',
  'batches',
  'custody_events',
  'evidence_files',
  'intents',
  'chain_jobs',
  'idempotency_records',
  'audit_log',
] as const;

async function setupMigratedDb(): Promise<DatabaseClient> {
  const client = await createDatabase('pglite://memory');
  await client.migrate();
  return client;
}

describe('Database Hardening, Migrations, RLS & Seed', () => {
  const openClients: DatabaseClient[] = [];

  afterEach(async () => {
    while (openClients.length > 0) {
      const client = openClients.pop();
      if (client) {
        await client.close();
      }
    }
  });

  async function createTestDb(): Promise<DatabaseClient> {
    const client = await setupMigratedDb();
    openClients.push(client);
    return client;
  }

  it('enforces append-only custody_events trigger (blocks DELETE and immutable UPDATE, allows anchor updates)', async () => {
    const { db } = await createTestDb();
    const seeded = await seedDemoData(db);
    const generator = seeded.members.find((m) => m.role === 'GENERATOR')!;

    const batchId = newId();
    await db.insert(batches).values({
      id: batchId,
      publicId: 'tb3-test-001',
      batchRef: 'B3-2026-0001',
      onChainBatchId: computeOnChainBatchId(batchId),
      wasteCode: 'B105d',
      wasteName: 'Used Lubricating Oil',
      status: 'PENDING_CHAIN',
      generatorOrgId: generator.orgId,
      currentCustodianOrgId: generator.orgId,
      declaredWeightGrams: '250000',
      latestEventSeq: 0,
      latestEventHash: ZERO_BYTES32,
    });

    const record = buildCanonicalEventRecord({
      batchId,
      seq: 1,
      type: 'CREATED',
      actorWallet: generator.walletAddress,
      actorOrgId: generator.orgId,
      fromOrgId: null,
      toOrgId: generator.orgId,
      wasteCode: 'B105d',
      quantity: {
        grams: '250000',
        originalValue: '250',
        originalUnit: 'kg',
      },
      prevEventHash: ZERO_BYTES32,
    });
    const eventHash = computeEventHash(record);
    const eventId = newId();

    await db.insert(custodyEvents).values({
      id: eventId,
      batchId,
      seq: 1,
      eventType: 'CREATED',
      actorMemberId: generator.id,
      actorWallet: generator.walletAddress,
      actorOrgId: generator.orgId,
      fromOrgId: null,
      toOrgId: generator.orgId,
      quantityGrams: '250000',
      quantityUnit: 'kg',
      record,
      eventHash,
      prevEventHash: ZERO_BYTES32,
      signature: `0x${'ab'.repeat(65)}`,
      nonce: '0',
      deadline: '1900000000',
      chainStatus: 'PENDING',
    });

    // Updating mutable anchor columns is allowed
    const anchoredAt = new Date('2026-11-21T05:00:00.000Z');
    const txHash = `0x${'11'.repeat(32)}`;
    await db
      .update(custodyEvents)
      .set({
        chainStatus: 'ANCHORED',
        txHash,
        blockNumber: 123,
        anchoredAt,
        failureReason: null,
      })
      .where(eq(custodyEvents.id, eventId));

    const [updated] = await db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.id, eventId));
    expect(updated?.chainStatus).toBe('ANCHORED');
    expect(updated?.txHash).toBe(txHash);
    expect(updated?.blockNumber).toBe(123);

    // Updating any immutable column must fail
    await expect(
      db
        .update(custodyEvents)
        .set({
          quantityGrams: '999999',
        })
        .where(eq(custodyEvents.id, eventId)),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db
        .update(custodyEvents)
        .set({
          record: {
            ...record,
            notes: 'tampered',
          },
        })
        .where(eq(custodyEvents.id, eventId)),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db
        .update(custodyEvents)
        .set({
          eventHash: `0x${'ff'.repeat(32)}`,
        })
        .where(eq(custodyEvents.id, eventId)),
    ).rejects.toThrow(/append-only/i);

    // Deleting custody_events row must fail
    await expect(
      db.delete(custodyEvents).where(eq(custodyEvents.id, eventId)),
    ).rejects.toThrow(/append-only/i);
  });

  it('enforces partial unique index on (batch_id, seq) while allowing retry after FAILED', async () => {
    const { db } = await createTestDb();
    const seeded = await seedDemoData(db);
    const generator = seeded.members.find((m) => m.role === 'GENERATOR')!;

    const batchId = newId();
    await db.insert(batches).values({
      id: batchId,
      publicId: 'tb3-test-002',
      batchRef: 'B3-2026-0002',
      onChainBatchId: computeOnChainBatchId(batchId),
      wasteCode: 'B105d',
      wasteName: 'Spent Solvent',
      status: 'PENDING_CHAIN',
      generatorOrgId: generator.orgId,
      currentCustodianOrgId: generator.orgId,
      declaredWeightGrams: '100000',
      latestEventSeq: 0,
      latestEventHash: ZERO_BYTES32,
    });

    const record = buildCanonicalEventRecord({
      batchId,
      seq: 1,
      type: 'CREATED',
      actorWallet: generator.walletAddress,
      actorOrgId: generator.orgId,
      fromOrgId: null,
      toOrgId: generator.orgId,
      wasteCode: 'B105d',
      quantity: {
        grams: '100000',
        originalValue: '100',
        originalUnit: 'kg',
      },
      prevEventHash: ZERO_BYTES32,
    });
    const eventHash = computeEventHash(record);
    const firstId = newId();

    await db.insert(custodyEvents).values({
      id: firstId,
      batchId,
      seq: 1,
      eventType: 'CREATED',
      actorMemberId: generator.id,
      actorWallet: generator.walletAddress,
      actorOrgId: generator.orgId,
      fromOrgId: null,
      toOrgId: generator.orgId,
      quantityGrams: '100000',
      quantityUnit: 'kg',
      record,
      eventHash,
      prevEventHash: ZERO_BYTES32,
      signature: `0x${'cd'.repeat(65)}`,
      nonce: '0',
      deadline: '1900000000',
      chainStatus: 'PENDING',
    });

    // Second active row at (batchId, seq=1) must violate partial unique index
    await expect(
      db.insert(custodyEvents).values({
        id: newId(),
        batchId,
        seq: 1,
        eventType: 'CREATED',
        actorMemberId: generator.id,
        actorWallet: generator.walletAddress,
        actorOrgId: generator.orgId,
        fromOrgId: null,
        toOrgId: generator.orgId,
        quantityGrams: '100000',
        quantityUnit: 'kg',
        record,
        eventHash,
        prevEventHash: ZERO_BYTES32,
        signature: `0x${'cd'.repeat(65)}`,
        nonce: '0',
        deadline: '1900000000',
        chainStatus: 'PENDING',
      }),
    ).rejects.toThrow(/custody_events_batch_seq_active_uniq|unique/i);

    // Transition original row to FAILED -> retry at same (batchId, seq=1) succeeds
    await db
      .update(custodyEvents)
      .set({
        chainStatus: 'FAILED',
        failureReason: 'Simulated chain revert',
      })
      .where(eq(custodyEvents.id, firstId));

    const retryId = newId();
    await db.insert(custodyEvents).values({
      id: retryId,
      batchId,
      seq: 1,
      eventType: 'CREATED',
      actorMemberId: generator.id,
      actorWallet: generator.walletAddress,
      actorOrgId: generator.orgId,
      fromOrgId: null,
      toOrgId: generator.orgId,
      quantityGrams: '100000',
      quantityUnit: 'kg',
      record,
      eventHash,
      prevEventHash: ZERO_BYTES32,
      signature: `0x${'ef'.repeat(65)}`,
      nonce: '1',
      deadline: '1900000000',
      chainStatus: 'PENDING',
    });

    const rows = await db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.batchId, batchId));
    expect(rows).toHaveLength(2);
  });

  it('enables RLS and deny_all policies on all 10 tables and supports nullable evidence staging', async () => {
    const { db } = await createTestDb();

    const tableRows = await db.execute<{
      relname: string;
      relrowsecurity: boolean;
    }>(sql`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `);
    const rlsMap = new Map(
      (tableRows as unknown as { rows: Array<{ relname: string; relrowsecurity: boolean }> }).rows.map(
        (r) => [r.relname, r.relrowsecurity],
      ),
    );

    const policyRows = await db.execute<{
      tablename: string;
      policyname: string;
    }>(sql`
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public'
    `);
    const policies = (
      policyRows as unknown as {
        rows: Array<{ tablename: string; policyname: string }>;
      }
    ).rows;

    for (const table of ALL_TABLES) {
      expect(rlsMap.get(table)).toBe(true);
      expect(
        policies.some(
          (p) => p.tablename === table && p.policyname === `deny_all_${table}`,
        ),
      ).toBe(true);
    }

    // Verify non-superuser role is denied by RLS policy
    const seeded = await seedDemoData(db);
    const generator = seeded.members.find((m) => m.role === 'GENERATOR')!;

    await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE ROLE anon_probe NOLOGIN`);
      await tx.execute(sql`GRANT SELECT, INSERT ON organizations TO anon_probe`);
      await tx.execute(sql`SET LOCAL ROLE anon_probe`);

      const visibleOrgs = await tx.select().from(organizations);
      expect(visibleOrgs).toHaveLength(0);

      const newOrgId = newId();
      await expect(
        tx.insert(organizations).values({
          id: newOrgId,
          code: 'ROGUE-ORG',
          name: 'Rogue',
          orgType: 'generator',
          onChainOrgId: computeOnChainOrgId(newOrgId),
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    // Evidence staging prior to batch creation allows batch_id = null and event_id = null
    const stagedId = newId();
    await db.insert(evidenceFiles).values({
      id: stagedId,
      batchId: null,
      eventId: null,
      uploadedByMemberId: generator.id,
      uploadedByOrgId: generator.orgId,
      storageDriver: 'local',
      storageKey: `staging/${stagedId}/weighbridge.pdf`,
      originalFilename: 'weighbridge.pdf',
      label: 'weighbridge_slip',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
    });

    const [staged] = await db
      .select()
      .from(evidenceFiles)
      .where(eq(evidenceFiles.id, stagedId));
    expect(staged?.batchId).toBeNull();
    expect(staged?.eventId).toBeNull();
  });

  it('seeds Jababeka demo orgs and 5 members idempotently', async () => {
    const { db } = await createTestDb();

    const first = await seedDemoData(db);
    expect(first.organizations).toHaveLength(4);
    expect(first.members).toHaveLength(5);
    expect(first.createdOrganizations).toBe(4);
    expect(first.createdMembers).toBe(5);
    expect(first.organizations.map((o) => o.orgType).sort()).toEqual([
      'facility',
      'generator',
      'regulator',
      'transporter',
    ]);
    expect(first.members.map((m) => m.role).sort()).toEqual([
      'ADMIN',
      'AUDITOR',
      'FACILITY',
      'GENERATOR',
      'TRANSPORTER',
    ]);

    const second = await seedDemoData(db);
    expect(second.createdOrganizations).toBe(0);
    expect(second.createdMembers).toBe(0);
    expect(second.organizations).toEqual(first.organizations);
    expect(second.members).toEqual(first.members);

    const orgRows = await db.select().from(organizations);
    const memberRows = await db.select().from(members);
    expect(orgRows).toHaveLength(4);
    expect(memberRows).toHaveLength(5);
  });

  it('supports partial single-wallet registration and role switching in seedDemoData', async () => {
    const { db } = await createTestDb();
    const demoWallet = '0xAA638C96AEBf82220aE8a3378fb0bE1072554304';
    const normalizedWallet = demoWallet.toLowerCase();

    const first = await seedDemoData(db, {
      wallets: { GENERATOR: demoWallet },
    });
    const genMember = first.members.find((m) => m.role === 'GENERATOR');
    expect(genMember?.walletAddress).toBe(normalizedWallet);
    expect(genMember?.orgCode).toBe('JAB-GEN-01');

    const switched = await seedDemoData(db, {
      wallets: { TRANSPORTER: demoWallet },
    });
    const trnMember = switched.members.find((m) => m.role === 'TRANSPORTER');
    expect(trnMember?.walletAddress).toBe(normalizedWallet);
    expect(trnMember?.orgCode).toBe('JAB-TRN-01');

    const activeRowsForWallet = await db
      .select()
      .from(members)
      .where(eq(members.walletAddress, normalizedWallet));
    expect(activeRowsForWallet).toHaveLength(1);
    expect(activeRowsForWallet[0]?.role).toBe('TRANSPORTER');
  });

  it('parses config defaults cleanly and redacts secrets in pino logger', async () => {
    const cfg = loadConfig({
      FRONTEND_ORIGINS: ' http://localhost:3000 , https://app.traceb3.local ',
      DEMO_MODE: 'false',
    });

    expect(cfg.PORT).toBe(3001);
    expect(cfg.DATABASE_URL).toBe('pglite://.data/pglite');
    expect(cfg.STORAGE_DRIVER).toBe('local');
    expect(cfg.WEIGHT_TOLERANCE_PCT).toBe(2);
    expect(cfg.CUSTODY_GAP_HOURS).toBe(24);
    expect(cfg.PUBLIC_VIEW_LEVEL).toBe('redacted');
    expect(cfg.DEMO_MODE).toBe(false);
    expect(cfg.MAX_UPLOAD_MB).toBe(10);
    expect(cfg.FRONTEND_ORIGINS).toEqual([
      'http://localhost:3000',
      'https://app.traceb3.local',
    ]);
    expect(cfg.JWT_SECRET.length).toBeGreaterThanOrEqual(16);

    expect(() =>
      loadConfig({ NODE_ENV: 'production' }),
    ).toThrow(/JWT_SECRET/);

    const chunks: string[] = [];
    const dest = new PassThrough();
    dest.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'));
    });

    const logger = createLogger({ level: 'info', destination: dest });
    logger.info(
      {
        RELAYER_PRIVATE_KEY: '0xsupersecretrelayerkey',
        JWT_SECRET: 'supersecretjwtsecretvalue',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
        req: { headers: { authorization: 'Bearer topsecret' } },
        nested: { privateKey: '0xdeadbeef', secret: 'abc', token: 'xyz' },
      },
      'secret redaction test',
    );

    const output = chunks.join('');
    expect(output).not.toContain('0xsupersecretrelayerkey');
    expect(output).not.toContain('supersecretjwtsecretvalue');
    expect(output).not.toContain('service-role-secret');
    expect(output).not.toContain('Bearer topsecret');
    expect(output).not.toContain('0xdeadbeef');
    expect(output).toContain('[REDACTED]');
  });

  it(
    'supports disk-backed pglite://<path> and resolves migrations from any CWD',
    async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'traceb3-pglite-'));
      const dataDir = path.join(tmpRoot, 'pgdata');
      const prevCwd = process.cwd();
      try {
        process.chdir(tmpRoot);
        const client = await createDatabase(`pglite://${dataDir}`);
        openClients.push(client);
        await client.migrate();
        const health = await client.healthCheck();
        expect(health).toEqual({ ok: true, driver: 'pglite' });

        const seeded = await seedDemoData(client.db);
        expect(seeded.organizations).toHaveLength(4);
        expect(seeded.members).toHaveLength(5);
        await client.close();
      } finally {
        process.chdir(prevCwd);
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
