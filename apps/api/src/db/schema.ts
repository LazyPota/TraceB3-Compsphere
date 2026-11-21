import type {
  ActorRole,
  BatchStatus,
  CanonicalEventRecordV1,
  ChainStatus,
  CustodyIntentTypedDataJson,
  DiscrepancySeverity,
  EventType,
  MemberStatus,
  OrgType,
  ReasonCode,
  WeightUnit,
} from '@traceb3/core';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

/**
 * Generates a time-ordered UUIDv7 identifier for database primary keys.
 */
export function newId(): string {
  return uuidv7();
}

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  orgType: text('org_type').$type<OrgType>().notNull(),
  code: text('code').notNull().unique(),
  onChainOrgId: text('on_chain_org_id').notNull().unique(),
  estate: text('estate'),
  klhkPermitNo: text('klhk_permit_no'),
  address: text('address'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull(),
});

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    walletAddress: text('wallet_address').notNull().unique(),
    displayName: text('display_name').notNull(),
    role: text('role').$type<ActorRole>().notNull(),
    status: text('status').$type<MemberStatus>().notNull().default('ACTIVE'),
    onChainTxHash: text('on_chain_tx_hash'),
    onChainRegisteredAt: timestamp('on_chain_registered_at', {
      withTimezone: true,
      mode: 'date',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('members_org_id_idx').on(t.orgId),
    index('members_role_idx').on(t.role),
    index('members_status_idx').on(t.status),
  ],
);

export const siweNonces = pgTable(
  'siwe_nonces',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    nonce: text('nonce').notNull().unique(),
    walletAddress: text('wallet_address'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('siwe_nonces_expires_at_idx').on(t.expiresAt)],
);

export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    publicId: text('public_id').notNull().unique(),
    batchRef: text('batch_ref').notNull().unique(),
    onChainBatchId: text('on_chain_batch_id').notNull().unique(),
    wasteCode: text('waste_code').notNull(),
    wasteName: text('waste_name').notNull(),
    wasteCategory: text('waste_category'),
    status: text('status')
      .$type<BatchStatus>()
      .notNull()
      .default('PENDING_CHAIN'),
    generatorOrgId: uuid('generator_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    currentCustodianOrgId: uuid('current_custodian_org_id').references(
      () => organizations.id,
      { onDelete: 'restrict' },
    ),
    declaredWeightGrams: text('declared_weight_grams'),
    latestEventSeq: integer('latest_event_seq').notNull().default(0),
    latestEventHash: text('latest_event_hash').notNull(),
    hasDiscrepancy: boolean('has_discrepancy').notNull().default(false),
    maxDiscrepancySeverity: text('max_discrepancy_severity')
      .$type<DiscrepancySeverity>()
      .notNull()
      .default('none'),
    festronikRef: text('festronik_ref'),
    monijaRef: text('monija_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('batches_generator_org_idx').on(t.generatorOrgId),
    index('batches_custodian_org_idx').on(t.currentCustodianOrgId),
    index('batches_status_idx').on(t.status),
    index('batches_waste_code_idx').on(t.wasteCode),
  ],
);

export const custodyEvents = pgTable(
  'custody_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id'),
    seq: integer('seq').notNull(),
    eventType: text('event_type').$type<EventType>().notNull(),
    actorMemberId: uuid('actor_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'restrict' }),
    actorWallet: text('actor_wallet').notNull(),
    actorOrgId: uuid('actor_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromOrgId: uuid('from_org_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    toOrgId: uuid('to_org_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    targetSeq: integer('target_seq'),
    reasonCode: text('reason_code').$type<ReasonCode>(),
    quantityGrams: text('quantity_grams'),
    quantityUnit: text('quantity_unit').$type<WeightUnit>(),
    record: jsonb('record').$type<CanonicalEventRecordV1>().notNull(),
    eventHash: text('event_hash').notNull(),
    prevEventHash: text('prev_event_hash').notNull(),
    signature: text('signature').notNull(),
    nonce: text('nonce').notNull(),
    deadline: text('deadline').notNull(),
    chainStatus: text('chain_status')
      .$type<ChainStatus>()
      .notNull()
      .default('PENDING'),
    txHash: text('tx_hash'),
    blockNumber: bigint('block_number', { mode: 'number' }),
    anchoredAt: timestamp('anchored_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('custody_events_batch_id_idx').on(t.batchId),
    index('custody_events_chain_status_idx').on(t.chainStatus),
    index('custody_events_event_hash_idx').on(t.eventHash),
  ],
);

export const evidenceFiles = pgTable(
  'evidence_files',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id').references(() => batches.id, {
      onDelete: 'restrict',
    }),
    eventId: uuid('event_id').references(() => custodyEvents.id, {
      onDelete: 'restrict',
    }),
    uploadedByMemberId: uuid('uploaded_by_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'restrict' }),
    uploadedByOrgId: uuid('uploaded_by_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storageDriver: text('storage_driver')
      .$type<'local' | 'supabase'>()
      .notNull(),
    storageKey: text('storage_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    label: text('label').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('evidence_files_batch_id_idx').on(t.batchId),
    index('evidence_files_event_id_idx').on(t.eventId),
    index('evidence_files_sha256_idx').on(t.sha256),
  ],
);

export const intents = pgTable(
  'intents',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id').notNull(),
    seq: integer('seq').notNull(),
    eventType: text('event_type').$type<EventType>().notNull(),
    actorMemberId: uuid('actor_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'restrict' }),
    actorOrgId: uuid('actor_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorWallet: text('actor_wallet').notNull(),
    wasteCode: text('waste_code').notNull(),
    wasteName: text('waste_name'),
    batchRef: text('batch_ref'),
    record: jsonb('record').$type<CanonicalEventRecordV1>().notNull(),
    typedData: jsonb('typed_data')
      .$type<CustodyIntentTypedDataJson>()
      .notNull(),
    eventHash: text('event_hash').notNull(),
    prevEventHash: text('prev_event_hash').notNull(),
    nonce: text('nonce').notNull(),
    deadline: text('deadline').notNull(),
    evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull().default([]),
    status: text('status')
      .$type<'OPEN' | 'SUBMITTED' | 'EXPIRED' | 'CANCELLED'>()
      .notNull()
      .default('OPEN'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    submittedAt: timestamp('submitted_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('intents_batch_id_idx').on(t.batchId),
    index('intents_actor_member_id_idx').on(t.actorMemberId),
    index('intents_status_idx').on(t.status),
    index('intents_expires_at_idx').on(t.expiresAt),
  ],
);

export const chainJobs = pgTable(
  'chain_jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    jobType: text('job_type')
      .$type<'ANCHOR_EVENT' | 'REGISTER_ACTOR' | 'REVOKE_ACTOR'>()
      .notNull()
      .default('ANCHOR_EVENT'),
    batchId: uuid('batch_id').references(() => batches.id, {
      onDelete: 'restrict',
    }),
    eventId: uuid('event_id').references(() => custodyEvents.id, {
      onDelete: 'restrict',
    }),
    memberId: uuid('member_id').references(() => members.id, {
      onDelete: 'restrict',
    }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status')
      .$type<'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'FAILED'>()
      .notNull()
      .default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    txHash: text('tx_hash'),
    lastError: text('last_error'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('chain_jobs_status_next_run_idx').on(t.status, t.nextRunAt),
    index('chain_jobs_batch_id_idx').on(t.batchId),
    index('chain_jobs_event_id_idx').on(t.eventId),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    idempotencyKey: text('idempotency_key').notNull(),
    scope: text('scope').notNull(),
    actorMemberId: uuid('actor_member_id').references(() => members.id, {
      onDelete: 'restrict',
    }),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body')
      .$type<Record<string, unknown>>()
      .notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_records_scope_key_uniq').on(
      t.scope,
      t.idempotencyKey,
    ),
    index('idempotency_records_expires_at_idx').on(t.expiresAt),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorMemberId: uuid('actor_member_id').references(() => members.id, {
      onDelete: 'restrict',
    }),
    actorWallet: text('actor_wallet'),
    actorRole: text('actor_role').$type<ActorRole>(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('audit_log_action_idx').on(t.action),
    index('audit_log_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_log_created_at_idx').on(t.createdAt),
  ],
);
