export const ACTOR_ROLES = [
  'GENERATOR',
  'TRANSPORTER',
  'FACILITY',
  'AUDITOR',
  'ADMIN',
] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

export const ONCHAIN_ACTOR_ROLE_MAP = {
  NONE: 0,
  GENERATOR: 1,
  TRANSPORTER: 2,
  FACILITY: 3,
} as const;
export type OnChainActorRole =
  (typeof ONCHAIN_ACTOR_ROLE_MAP)[keyof typeof ONCHAIN_ACTOR_ROLE_MAP];

export const ORG_TYPES = [
  'generator',
  'transporter',
  'facility',
  'regulator',
] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const MEMBER_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const BATCH_STATUSES = [
  'PENDING_CHAIN',
  'REGISTERED',
  'IN_TRANSIT',
  'RECEIVED',
  'TREATED',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ONCHAIN_BATCH_STATUS_MAP = {
  NONE: 0,
  REGISTERED: 1,
  IN_TRANSIT: 2,
  RECEIVED: 3,
  TREATED: 4,
} as const;
export type OnChainBatchStatus =
  (typeof ONCHAIN_BATCH_STATUS_MAP)[keyof typeof ONCHAIN_BATCH_STATUS_MAP];

export const EVENT_TYPES = [
  'CREATED',
  'CUSTODY_TRANSFERRED',
  'REVISION',
  'TREATMENT',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_TO_UINT8 = {
  CREATED: 0,
  CUSTODY_TRANSFERRED: 1,
  REVISION: 2,
  TREATMENT: 3,
} as const satisfies Record<EventType, number>;

export const UINT8_TO_EVENT_TYPE = {
  0: 'CREATED',
  1: 'CUSTODY_TRANSFERRED',
  2: 'REVISION',
  3: 'TREATMENT',
} as const satisfies Record<number, EventType>;

export const CHAIN_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'ANCHORED',
  'FAILED',
] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

export const WEIGHT_UNITS = ['kg', 'g', 'ton'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

export const REASON_CODES = [
  'SCALE_RECALIBRATION',
  'UNIT_CORRECTION',
  'DATA_ENTRY_ERROR',
  'MANIFEST_AMENDMENT',
  'OTHER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const DISCREPANCY_CODES = [
  'WEIGHT_MISMATCH_PICKUP',
  'WEIGHT_MISMATCH_DELIVERY',
  'WEIGHT_MISMATCH_TOTAL',
  'LIKELY_UNIT_ERROR',
  'CUSTODY_GAP',
  'VALUE_REVISED',
] as const;
export type DiscrepancyCode = (typeof DISCREPANCY_CODES)[number];

export const DISCREPANCY_SEVERITIES = [
  'none',
  'info',
  'warning',
  'critical',
] as const;
export type DiscrepancySeverity = (typeof DISCREPANCY_SEVERITIES)[number];

export const EVENT_VERIFICATION_VERDICTS = [
  'MATCH',
  'HASH_MISMATCH',
  'FILE_MISMATCH',
  'FILE_MISSING',
  'NOT_YET_ANCHORED',
  'CHAIN_LINK_BROKEN',
  'SIGNATURE_INVALID',
] as const;
export type EventVerificationVerdict =
  (typeof EVENT_VERIFICATION_VERDICTS)[number];

export const OVERALL_VERIFICATION_VERDICTS = [
  'VERIFIED',
  'TAMPERED',
  'PENDING',
  'INCOMPLETE',
] as const;
export type OverallVerificationVerdict =
  (typeof OVERALL_VERIFICATION_VERDICTS)[number];

export const PUBLIC_VIEW_LEVELS = ['redacted', 'full'] as const;
export type PublicViewLevel = (typeof PUBLIC_VIEW_LEVELS)[number];

export const API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN_ROLE',
  'VALIDATION_ERROR',
  'INVALID_TRANSITION',
  'BATCH_BUSY',
  'INTENT_EXPIRED',
  'BAD_SIGNATURE',
  'EVIDENCE_TOO_LARGE',
  'EVIDENCE_TYPE_NOT_ALLOWED',
  'CHAIN_REVERT',
  'CHAIN_UNAVAILABLE',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
