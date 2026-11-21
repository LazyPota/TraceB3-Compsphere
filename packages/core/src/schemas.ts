import { z } from 'zod';
import {
  ACTOR_ROLES,
  API_ERROR_CODES,
  BATCH_STATUSES,
  CHAIN_STATUSES,
  DISCREPANCY_CODES,
  DISCREPANCY_SEVERITIES,
  EVENT_TYPES,
  EVENT_VERIFICATION_VERDICTS,
  MEMBER_STATUSES,
  ORG_TYPES,
  OVERALL_VERIFICATION_VERDICTS,
  PUBLIC_VIEW_LEVELS,
  REASON_CODES,
  WEIGHT_UNITS,
} from './enums.js';

export const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid EVM address');

export const Bytes32HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid 32-byte hex string');

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Invalid lowercase 64-char SHA-256 hex digest');

export const SaltHexSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'Invalid 16-byte lowercase hex salt');

export const ActorRoleSchema = z.enum(ACTOR_ROLES);
export const OrgTypeSchema = z.enum(ORG_TYPES);
export const MemberStatusSchema = z.enum(MEMBER_STATUSES);
export const BatchStatusSchema = z.enum(BATCH_STATUSES);
export const EventTypeSchema = z.enum(EVENT_TYPES);
export const ChainStatusSchema = z.enum(CHAIN_STATUSES);
export const WeightUnitSchema = z.enum(WEIGHT_UNITS);
export const ReasonCodeSchema = z.enum(REASON_CODES);
export const DiscrepancyCodeSchema = z.enum(DISCREPANCY_CODES);
export const DiscrepancySeveritySchema = z.enum(DISCREPANCY_SEVERITIES);
export const EventVerificationVerdictSchema = z.enum(
  EVENT_VERIFICATION_VERDICTS,
);
export const OverallVerificationVerdictSchema = z.enum(
  OVERALL_VERIFICATION_VERDICTS,
);
export const PublicViewLevelSchema = z.enum(PUBLIC_VIEW_LEVELS);
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const QuantityInputSchema = z.object({
  value: z.union([
    z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+)?$/, 'Weight must be a non-negative decimal string'),
    z.number().finite().nonnegative(),
  ]),
  unit: WeightUnitSchema,
});

export const NormalizedQuantitySchema = z.object({
  grams: z.string().regex(/^\d+$/),
  originalValue: z.string().regex(/^\d+(?:\.\d+)?$/),
  originalUnit: WeightUnitSchema,
});

export const CanonicalEvidenceItemSchema = z.object({
  sha256: Sha256HexSchema,
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  label: z.string(),
});

export const CanonicalEventRecordV1Schema = z.object({
  v: z.literal(1),
  batchId: z.string().min(1),
  seq: z.number().int().positive(),
  type: EventTypeSchema,
  actorWallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  actorOrgId: z.string().min(1),
  fromOrgId: z.string().nullable(),
  toOrgId: z.string().nullable(),
  wasteCode: z.string().min(1),
  quantity: NormalizedQuantitySchema.nullable(),
  evidence: z.array(CanonicalEvidenceItemSchema),
  targetSeq: z.number().int().positive().nullable(),
  reasonCode: ReasonCodeSchema.nullable(),
  notes: z.string().nullable(),
  prevEventHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  salt: SaltHexSchema,
});

export const Eip712FieldDefSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
});

export const CustodyIntentTypedDataJsonSchema = z.object({
  domain: z.object({
    name: z.literal('TraceB3Ledger'),
    version: z.literal('1'),
    chainId: z.number().int().positive(),
    verifyingContract: EvmAddressSchema,
  }),
  types: z.object({
    CustodyIntent: z.array(Eip712FieldDefSchema),
  }),
  primaryType: z.literal('CustodyIntent'),
  message: z.object({
    batchId: Bytes32HexSchema,
    eventType: z.number().int().min(0).max(3),
    eventHash: Bytes32HexSchema,
    prevHash: Bytes32HexSchema,
    targetSeq: z.number().int().nonnegative(),
    actor: EvmAddressSchema,
    nonce: z.string().regex(/^\d+$/),
    deadline: z.string().regex(/^\d+$/),
  }),
});

export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  code: ApiErrorCodeSchema,
  requestId: z.string().optional(),
  errors: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const DiscrepancyFlagSchema = z.object({
  code: DiscrepancyCodeSchema,
  severity: DiscrepancySeveritySchema,
  expected: z.string().nullable(),
  observed: z.string().nullable(),
  deltaGrams: z.string().nullable(),
  deltaKg: z.string().nullable(),
  percent: z.number().nullable(),
  eventIds: z.array(z.string()),
  hint: z.string().optional(),
});

export const DiscrepancyReportSchema = z.object({
  flags: z.array(DiscrepancyFlagSchema),
  hasDiscrepancy: z.boolean(),
  maxSeverity: DiscrepancySeveritySchema,
  effectiveWeights: z.object({
    declaredGrams: z.string().nullable(),
    pickupGrams: z.string().nullable(),
    deliveryGrams: z.string().nullable(),
  }),
});

export const ProofBundleEventSchema = z.object({
  eventId: z.string().min(1),
  seq: z.number().int().positive(),
  eventHash: Bytes32HexSchema,
  prevEventHash: Bytes32HexSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  nonce: z.string().regex(/^\d+$/),
  deadline: z.string().regex(/^\d+$/),
  txHash: Bytes32HexSchema,
  blockNumber: z.number().int().nonnegative(),
  anchoredAt: z.string(),
  record: CanonicalEventRecordV1Schema,
});

export const ProofBundleSchema = z.object({
  bundleVersion: z.literal(1),
  exportedAt: z.string(),
  chainId: z.number().int().positive(),
  verifyingContract: EvmAddressSchema,
  batch: z.object({
    id: z.string().min(1),
    publicId: z.string().min(1),
    batchRef: z.string().min(1),
    onChainBatchId: Bytes32HexSchema,
    wasteCode: z.string().min(1),
    wasteName: z.string().min(1),
    status: BatchStatusSchema,
  }),
  events: z.array(ProofBundleEventSchema),
});

export type ProofBundle = z.infer<typeof ProofBundleSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
