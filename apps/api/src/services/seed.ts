import {
  computeOnChainOrgId,
  type ActorRole,
  type MemberStatus,
  type OrgType,
} from '@traceb3/core';
import { and, eq } from 'drizzle-orm';
import { getAddress } from 'viem';
import type { DbExecutor } from '../db/index.js';
import { members, newId, organizations } from '../db/schema.js';

export interface SeedDemoDataOptions {
  wallets?: Partial<Record<ActorRole, string>>;
}

export interface SeededOrganization {
  id: string;
  code: string;
  name: string;
  orgType: OrgType;
  onChainOrgId: string;
}

export interface SeededMember {
  id: string;
  orgId: string;
  orgCode: string;
  onChainOrgId: string;
  walletAddress: string;
  displayName: string;
  role: ActorRole;
  status: MemberStatus;
}

export interface SeedDemoDataResult {
  organizations: SeededOrganization[];
  members: SeededMember[];
  createdOrganizations: number;
  createdMembers: number;
}

interface DemoOrgSeed {
  code: string;
  name: string;
  orgType: OrgType;
  estate: string;
  klhkPermitNo: string;
  address: string;
}

interface DemoMemberSeed {
  orgCode: string;
  role: ActorRole;
  displayName: string;
  fallbackWallet: `0x${string}`;
}

const DEMO_ORGS: readonly DemoOrgSeed[] = [
  {
    code: 'JAB-GEN-01',
    name: 'PT Jababeka Precision Manufacturing',
    orgType: 'generator',
    estate: 'Jababeka Cikarang Industrial Estate',
    klhkPermitNo: 'SK-KLHK-B3-GEN-2026-001',
    address: 'Jl. Jababeka Raya Blok A-12, Cikarang, Bekasi',
  },
  {
    code: 'JAB-TRN-01',
    name: 'PT Cikarang Hazmat Logistics',
    orgType: 'transporter',
    estate: 'Jababeka Cikarang Industrial Estate',
    klhkPermitNo: 'SK-KLHK-B3-TRN-2026-042',
    address: 'Jl. Industri Selatan Blok K-04, Jababeka II, Cikarang',
  },
  {
    code: 'JAB-FAC-01',
    name: 'PT Nusantara B3 Recovery Facility',
    orgType: 'facility',
    estate: 'Jababeka Cikarang Industrial Estate',
    klhkPermitNo: 'SK-KLHK-B3-FAC-2026-018',
    address: 'Jl. Jababeka XVI Kav. V-09, Cikarang, Bekasi',
  },
  {
    code: 'JAB-REG-01',
    name: 'Jababeka Estate Compliance & KLHK Audit Desk',
    orgType: 'regulator',
    estate: 'Jababeka Cikarang Industrial Estate',
    klhkPermitNo: 'MONIJA-ESTATE-DESK-01',
    address: 'Hollywood Plaza Jababeka, Cikarang, Bekasi',
  },
];

const DEMO_MEMBERS: readonly DemoMemberSeed[] = [
  {
    orgCode: 'JAB-REG-01',
    role: 'ADMIN',
    displayName: 'System Admin — Jababeka Estate',
    fallbackWallet: '0x1000000000000000000000000000000000000001',
  },
  {
    orgCode: 'JAB-GEN-01',
    role: 'GENERATOR',
    displayName: 'Operator — PT Jababeka Precision Manufacturing',
    fallbackWallet: '0x1000000000000000000000000000000000000002',
  },
  {
    orgCode: 'JAB-TRN-01',
    role: 'TRANSPORTER',
    displayName: 'Driver — PT Cikarang Hazmat Logistics',
    fallbackWallet: '0x1000000000000000000000000000000000000003',
  },
  {
    orgCode: 'JAB-FAC-01',
    role: 'FACILITY',
    displayName: 'Receiving Officer — PT Nusantara B3 Recovery Facility',
    fallbackWallet: '0x1000000000000000000000000000000000000004',
  },
  {
    orgCode: 'JAB-REG-01',
    role: 'AUDITOR',
    displayName: 'Inspector — KLHK / MONIJA Compliance',
    fallbackWallet: '0x1000000000000000000000000000000000000005',
  },
];

/**
 * Idempotently seeds the Jababeka Cikarang Industrial Estate demo organizations
 * and 5 role-scoped members into PostgreSQL.
 */
export async function seedDemoData(
  db: DbExecutor,
  options?: SeedDemoDataOptions,
): Promise<SeedDemoDataResult> {
  return db.transaction(async (tx) => {
    const orgMap = new Map<string, SeededOrganization>();
    const seededOrgs: SeededOrganization[] = [];
    let createdOrganizations = 0;

    for (const def of DEMO_ORGS) {
      const existing = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.code, def.code))
        .limit(1);

      const found = existing[0];
      if (found) {
        const entry: SeededOrganization = {
          id: found.id,
          code: found.code,
          name: found.name,
          orgType: found.orgType,
          onChainOrgId: found.onChainOrgId,
        };
        orgMap.set(def.code, entry);
        seededOrgs.push(entry);
        continue;
      }

      const id = newId();
      const onChainOrgId = computeOnChainOrgId(id);
      const inserted = await tx
        .insert(organizations)
        .values({
          id,
          code: def.code,
          name: def.name,
          orgType: def.orgType,
          onChainOrgId,
          estate: def.estate,
          klhkPermitNo: def.klhkPermitNo,
          address: def.address,
        })
        .returning();

      const row = inserted[0]!;
      createdOrganizations += 1;
      const entry: SeededOrganization = {
        id: row.id,
        code: row.code,
        name: row.name,
        orgType: row.orgType,
        onChainOrgId: row.onChainOrgId,
      };
      orgMap.set(def.code, entry);
      seededOrgs.push(entry);
    }

    const memberByRole = new Map<ActorRole, SeededMember>();
    let createdMembers = 0;

    const toSeededMember = (
      memberRow: typeof members.$inferSelect,
      org: SeededOrganization,
    ): SeededMember => ({
      id: memberRow.id,
      orgId: memberRow.orgId,
      orgCode: org.code,
      onChainOrgId: org.onChainOrgId,
      walletAddress: memberRow.walletAddress,
      displayName: memberRow.displayName,
      role: memberRow.role,
      status: memberRow.status,
    });

    // Pass 1: apply explicitly provided wallets first so single-wallet role switching
    // moves an existing wallet row before Pass 2 populates remaining fallback roles.
    for (const def of DEMO_MEMBERS) {
      const explicitWallet = options?.wallets?.[def.role];
      if (!explicitWallet) {
        continue;
      }

      const org = orgMap.get(def.orgCode);
      if (!org) {
        throw new Error(`Seed organization missing for code "${def.orgCode}"`);
      }

      const normalizedWallet = getAddress(explicitWallet).toLowerCase();

      const byWallet = await tx
        .select()
        .from(members)
        .where(eq(members.walletAddress, normalizedWallet))
        .limit(1);

      let memberRow = byWallet[0];

      if (memberRow) {
        const updated = await tx
          .update(members)
          .set({
            orgId: org.id,
            role: def.role,
            displayName: def.displayName,
            status: 'ACTIVE',
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(members.id, memberRow.id))
          .returning();
        memberRow = updated[0]!;
      } else {
        const byRoleAndOrg = await tx
          .select()
          .from(members)
          .where(
            and(
              eq(members.orgId, org.id),
              eq(members.role, def.role),
              eq(members.displayName, def.displayName),
            ),
          )
          .limit(1);

        const existingDemo = byRoleAndOrg[0];
        if (existingDemo) {
          const updated = await tx
            .update(members)
            .set({
              walletAddress: normalizedWallet,
              status: 'ACTIVE',
              revokedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(members.id, existingDemo.id))
            .returning();
          memberRow = updated[0]!;
        } else {
          const inserted = await tx
            .insert(members)
            .values({
              id: newId(),
              orgId: org.id,
              walletAddress: normalizedWallet,
              displayName: def.displayName,
              role: def.role,
              status: 'ACTIVE',
            })
            .returning();
          memberRow = inserted[0]!;
          createdMembers += 1;
        }
      }

      memberByRole.set(def.role, toSeededMember(memberRow, org));
    }

    // Pass 2: preserve or populate fallback members for roles not explicitly specified.
    for (const def of DEMO_MEMBERS) {
      if (memberByRole.has(def.role)) {
        continue;
      }

      const org = orgMap.get(def.orgCode);
      if (!org) {
        throw new Error(`Seed organization missing for code "${def.orgCode}"`);
      }

      const byRoleAndOrg = await tx
        .select()
        .from(members)
        .where(
          and(
            eq(members.orgId, org.id),
            eq(members.role, def.role),
            eq(members.displayName, def.displayName),
          ),
        )
        .limit(1);

      let memberRow = byRoleAndOrg[0];

      if (!memberRow) {
        const normalizedFallback = getAddress(def.fallbackWallet).toLowerCase();
        const byWallet = await tx
          .select()
          .from(members)
          .where(eq(members.walletAddress, normalizedFallback))
          .limit(1);
        memberRow = byWallet[0];

        if (!memberRow) {
          const inserted = await tx
            .insert(members)
            .values({
              id: newId(),
              orgId: org.id,
              walletAddress: normalizedFallback,
              displayName: def.displayName,
              role: def.role,
              status: 'ACTIVE',
            })
            .returning();
          memberRow = inserted[0]!;
          createdMembers += 1;
        }
      }

      memberByRole.set(def.role, toSeededMember(memberRow, org));
    }

    const seededMembers = DEMO_MEMBERS.map((def) => memberByRole.get(def.role)!);

    return {
      organizations: seededOrgs,
      members: seededMembers,
      createdOrganizations,
      createdMembers,
    };
  });
}

/**
 * Records an on-chain actor registration transaction hash for a seeded member.
 */
export async function markMemberOnChainRegistered(
  db: DbExecutor,
  memberId: string,
  txHash: string,
): Promise<void> {
  await db
    .update(members)
    .set({
      onChainTxHash: txHash,
      onChainRegisteredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(members.id, memberId));
}
