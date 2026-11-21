import { getAddress } from 'viem';
import { EVENT_TYPE_TO_UINT8, type EventType } from './enums.js';

export const EIP712_DOMAIN_NAME = 'TraceB3Ledger' as const;
export const EIP712_DOMAIN_VERSION = '1' as const;
export const CUSTODY_INTENT_PRIMARY_TYPE = 'CustodyIntent' as const;

export const CUSTODY_INTENT_TYPES = {
  CustodyIntent: [
    { name: 'batchId', type: 'bytes32' },
    { name: 'eventType', type: 'uint8' },
    { name: 'eventHash', type: 'bytes32' },
    { name: 'prevHash', type: 'bytes32' },
    { name: 'targetSeq', type: 'uint32' },
    { name: 'actor', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export interface TraceB3Eip712Domain {
  name: typeof EIP712_DOMAIN_NAME;
  version: typeof EIP712_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface CustodyIntentMessage {
  batchId: `0x${string}`;
  eventType: number;
  eventHash: `0x${string}`;
  prevHash: `0x${string}`;
  targetSeq: number;
  actor: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

export interface CustodyIntentTypedData {
  domain: TraceB3Eip712Domain;
  types: typeof CUSTODY_INTENT_TYPES;
  primaryType: typeof CUSTODY_INTENT_PRIMARY_TYPE;
  message: CustodyIntentMessage;
}

export interface CustodyIntentMessageJson {
  batchId: `0x${string}`;
  eventType: number;
  eventHash: `0x${string}`;
  prevHash: `0x${string}`;
  targetSeq: number;
  actor: `0x${string}`;
  nonce: string;
  deadline: string;
}

export interface CustodyIntentTypedDataJson {
  domain: TraceB3Eip712Domain;
  types: typeof CUSTODY_INTENT_TYPES;
  primaryType: typeof CUSTODY_INTENT_PRIMARY_TYPE;
  message: CustodyIntentMessageJson;
}

export interface BuildCustodyIntentParams {
  chainId: number;
  verifyingContract: `0x${string}`;
  batchId: `0x${string}`;
  eventType: EventType;
  eventHash: `0x${string}`;
  prevHash: `0x${string}`;
  targetSeq: number;
  actor: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

/**
 * Builds an EIP-712 typed-data payload for TraceB3Ledger CustodyIntent signing.
 */
export function buildCustodyIntentTypedData(
  params: BuildCustodyIntentParams,
): CustodyIntentTypedData {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: params.chainId,
      verifyingContract: getAddress(params.verifyingContract),
    },
    types: CUSTODY_INTENT_TYPES,
    primaryType: CUSTODY_INTENT_PRIMARY_TYPE,
    message: {
      batchId: params.batchId.toLowerCase() as `0x${string}`,
      eventType: EVENT_TYPE_TO_UINT8[params.eventType],
      eventHash: params.eventHash.toLowerCase() as `0x${string}`,
      prevHash: params.prevHash.toLowerCase() as `0x${string}`,
      targetSeq: params.targetSeq,
      actor: getAddress(params.actor),
      nonce: params.nonce,
      deadline: params.deadline,
    },
  };
}

/**
 * Converts bigint EIP-712 fields to decimal strings for JSON transport/storage.
 */
export function serializeTypedData(
  typedData: CustodyIntentTypedData,
): CustodyIntentTypedDataJson {
  return {
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      ...typedData.message,
      nonce: typedData.message.nonce.toString(10),
      deadline: typedData.message.deadline.toString(10),
    },
  };
}

/**
 * Restores bigint EIP-712 fields from JSON-serialized CustodyIntent typed data.
 */
export function deserializeTypedData(
  json: CustodyIntentTypedDataJson,
): CustodyIntentTypedData {
  return {
    domain: {
      ...json.domain,
      verifyingContract: getAddress(json.domain.verifyingContract),
    },
    types: CUSTODY_INTENT_TYPES,
    primaryType: CUSTODY_INTENT_PRIMARY_TYPE,
    message: {
      ...json.message,
      actor: getAddress(json.message.actor),
      nonce: BigInt(json.message.nonce),
      deadline: BigInt(json.message.deadline),
    },
  };
}
