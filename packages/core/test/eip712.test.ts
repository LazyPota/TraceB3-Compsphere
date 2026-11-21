import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ZERO_BYTES32 } from '../src/canonical.js';
import {
  buildCustodyIntentTypedData,
  CUSTODY_INTENT_PRIMARY_TYPE,
  deserializeTypedData,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  serializeTypedData,
} from '../src/eip712.js';
import { computeOnChainBatchId } from '../src/hash.js';

describe('EIP-712 CustodyIntent typed data', () => {
  it('builds, serializes, signs, and cryptographically verifies typed data', async () => {
    const account = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const verifyingContract = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    const batchId = computeOnChainBatchId('batch-001');
    const eventHash =
      '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

    const typedData = buildCustodyIntentTypedData({
      chainId: 31337,
      verifyingContract,
      batchId,
      eventType: 'CREATED',
      eventHash,
      prevHash: ZERO_BYTES32,
      targetSeq: 0,
      actor: account.address,
      nonce: 0n,
      deadline: 1900000000n,
    });

    expect(typedData.domain.name).toBe(EIP712_DOMAIN_NAME);
    expect(typedData.domain.version).toBe(EIP712_DOMAIN_VERSION);
    expect(typedData.primaryType).toBe(CUSTODY_INTENT_PRIMARY_TYPE);

    const json = serializeTypedData(typedData);
    expect(json.message.nonce).toBe('0');
    expect(json.message.deadline).toBe('1900000000');
    expect(() => JSON.stringify(json)).not.toThrow();

    const restored = deserializeTypedData(json);
    const signature = await account.signTypedData(restored);

    const isValid = await verifyTypedData({
      address: account.address,
      domain: restored.domain,
      types: restored.types,
      primaryType: restored.primaryType,
      message: restored.message,
      signature,
    });

    expect(isValid).toBe(true);
  });
});
