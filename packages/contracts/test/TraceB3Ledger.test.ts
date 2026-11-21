import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCanonicalEventRecord,
  buildCustodyIntentTypedData,
  computeEventHash,
  computeOnChainBatchId,
  computeOnChainOrgId,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EVENT_TYPE_TO_UINT8,
  normalizeWeightToGrams,
  ONCHAIN_ACTOR_ROLE_MAP,
  ONCHAIN_BATCH_STATUS_MAP,
  ZERO_BYTES32,
  type EventType,
  type ReasonCode,
} from '@traceb3/core';
import { network } from 'hardhat';
import type { NetworkConnection } from 'hardhat/types/network';
import {
  getAddress,
  hashDomain,
  keccak256,
  stringToBytes,
  zeroAddress,
} from 'viem';
import {
  CHAIN_EXPLORER_BASE_URLS,
  CONTRACTS_VERSION,
  getExplorerTxUrl,
  getLedgerAddress,
  TRACEB3_LEDGER_ABI,
} from '../exports/index.js';

const GEN_ORG_UUID = '11111111-1111-4111-8111-111111111111';
const TRANS_ORG_UUID = '22222222-2222-4222-8222-222222222222';
const FAC_ORG_UUID = '33333333-3333-4333-8333-333333333333';
const FAC2_ORG_UUID = '44444444-4444-4444-8444-444444444444';

const GEN_ORG_ID = computeOnChainOrgId(GEN_ORG_UUID);
const TRANS_ORG_ID = computeOnChainOrgId(TRANS_ORG_UUID);
const FAC_ORG_ID = computeOnChainOrgId(FAC_ORG_UUID);
const FAC2_ORG_ID = computeOnChainOrgId(FAC2_ORG_UUID);

const BATCH_UUID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_UUID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const EXPECTED_TYPEHASH = keccak256(
  stringToBytes(
    'CustodyIntent(bytes32 batchId,uint8 eventType,bytes32 eventHash,bytes32 prevHash,uint32 targetSeq,address actor,uint256 nonce,uint64 deadline)',
  ),
);

function mustGet<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing test fixture item: ${label} at index ${index}`);
  }
  return item;
}

async function deployLedgerFixture(connection: NetworkConnection) {
  const { viem, networkHelpers } = connection;
  const publicClient = await viem.getPublicClient();
  const walletClients = await viem.getWalletClients();

  const admin = mustGet(walletClients, 0, 'admin');
  const registrar = mustGet(walletClients, 1, 'registrar');
  const generator = mustGet(walletClients, 2, 'generator');
  const generator2 = mustGet(walletClients, 3, 'generator2');
  const transporter = mustGet(walletClients, 4, 'transporter');
  const sameOrgTransporter = mustGet(walletClients, 5, 'sameOrgTransporter');
  const facility = mustGet(walletClients, 6, 'facility');
  const facility2 = mustGet(walletClients, 7, 'facility2');
  const relayer = mustGet(walletClients, 8, 'relayer');
  const outsider = mustGet(walletClients, 9, 'outsider');

  const ledger = await viem.deployContract('TraceB3Ledger', [
    admin.account.address,
    registrar.account.address,
  ]);

  await ledger.write.registerActor(
    [generator.account.address, ONCHAIN_ACTOR_ROLE_MAP.GENERATOR, GEN_ORG_ID],
    { account: registrar.account },
  );
  await ledger.write.registerActor(
    [generator2.account.address, ONCHAIN_ACTOR_ROLE_MAP.GENERATOR, GEN_ORG_ID],
    { account: registrar.account },
  );
  await ledger.write.registerActor(
    [
      transporter.account.address,
      ONCHAIN_ACTOR_ROLE_MAP.TRANSPORTER,
      TRANS_ORG_ID,
    ],
    { account: registrar.account },
  );
  await ledger.write.registerActor(
    [
      sameOrgTransporter.account.address,
      ONCHAIN_ACTOR_ROLE_MAP.TRANSPORTER,
      GEN_ORG_ID,
    ],
    { account: registrar.account },
  );
  await ledger.write.registerActor(
    [facility.account.address, ONCHAIN_ACTOR_ROLE_MAP.FACILITY, FAC_ORG_ID],
    { account: registrar.account },
  );
  await ledger.write.registerActor(
    [facility2.account.address, ONCHAIN_ACTOR_ROLE_MAP.FACILITY, FAC2_ORG_ID],
    { account: registrar.account },
  );

  type Wallet = typeof generator;

  async function signIntent(params: {
    signer: Wallet;
    signingWalletOverride?: Wallet;
    batchUuid?: string;
    batchIdOverride?: `0x${string}`;
    eventType: EventType;
    intentEventTypeOverride?: number;
    seq: number;
    prevHash: `0x${string}`;
    eventHashOverride?: `0x${string}`;
    targetSeq?: number;
    actorOrgUuid: string;
    fromOrgUuid?: string | null;
    toOrgUuid?: string | null;
    weightKg?: string;
    reasonCode?: ReasonCode | null;
    notes?: string | null;
    nonceOverride?: bigint;
    deadlineOffsetSeconds?: number;
  }) {
    const batchUuid = params.batchUuid ?? BATCH_UUID_1;
    const batchId = params.batchIdOverride ?? computeOnChainBatchId(batchUuid);
    const chainId = await publicClient.getChainId();
    const latestTimestamp = BigInt(await networkHelpers.time.latest());
    const deadline =
      latestTimestamp + BigInt(params.deadlineOffsetSeconds ?? 3600);
    const nonce =
      params.nonceOverride ??
      (await ledger.read.nonces([params.signer.account.address]));

    const record = buildCanonicalEventRecord({
      batchId: batchUuid,
      seq: params.seq,
      type: params.eventType,
      actorWallet: params.signer.account.address,
      actorOrgId: params.actorOrgUuid,
      fromOrgId: params.fromOrgUuid ?? null,
      toOrgId: params.toOrgUuid ?? null,
      wasteCode: 'B105d',
      quantity: params.weightKg
        ? normalizeWeightToGrams(params.weightKg, 'kg')
        : null,
      evidence: [],
      targetSeq: params.targetSeq && params.targetSeq > 0 ? params.targetSeq : null,
      reasonCode: params.reasonCode ?? null,
      notes: params.notes ?? null,
      prevEventHash: params.prevHash,
      salt: `000000000000000000000000000000${params.seq.toString(16).padStart(2, '0')}`,
    });

    const eventHash = params.eventHashOverride ?? computeEventHash(record);
    const typedData = buildCustodyIntentTypedData({
      chainId,
      verifyingContract: ledger.address,
      batchId,
      eventType: params.eventType,
      eventHash,
      prevHash: params.prevHash,
      targetSeq: params.targetSeq ?? 0,
      actor: params.signer.account.address,
      nonce,
      deadline,
    });

    if (params.intentEventTypeOverride !== undefined) {
      typedData.message.eventType = params.intentEventTypeOverride;
    }

    const signingClient = params.signingWalletOverride ?? params.signer;
    const signature = await signingClient.signTypedData(typedData);

    return {
      batchId,
      eventHash,
      intent: typedData.message,
      signature,
      typedData,
    };
  }

  return {
    viem,
    networkHelpers,
    publicClient,
    ledger,
    accounts: {
      admin,
      registrar,
      generator,
      generator2,
      transporter,
      sameOrgTransporter,
      facility,
      facility2,
      relayer,
      outsider,
    },
    signIntent,
  };
}

describe('TraceB3Ledger', async function () {
  const connection = await network.create();
  const { viem, networkHelpers } = connection;

  it('aligns EIP-712 domain separator and CustodyIntent typehash with @traceb3/core', async function () {
    const { ledger, publicClient } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    const chainId = await publicClient.getChainId();
    const expectedDomainSeparator = hashDomain({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: BigInt(chainId),
        verifyingContract: ledger.address,
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      },
    });

    assert.equal(await ledger.read.domainSeparator(), expectedDomainSeparator);
    assert.equal(
      await ledger.read.CUSTODY_INTENT_TYPEHASH(),
      EXPECTED_TYPEHASH,
    );
  });

  it('enforces constructor zero-address checks and admin/registrar role access control', async function () {
    const { ledger, accounts } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    await viem.assertions.revertWithCustomError(
      viem.deployContract('TraceB3Ledger', [
        zeroAddress,
        accounts.registrar.account.address,
      ]),
      ledger,
      'ZeroAddress',
    );
    await viem.assertions.revertWithCustomError(
      viem.deployContract('TraceB3Ledger', [
        accounts.admin.account.address,
        zeroAddress,
      ]),
      ledger,
      'ZeroAddress',
    );

    const defaultAdminRole = await ledger.read.DEFAULT_ADMIN_ROLE();
    const registrarRole = await ledger.read.REGISTRAR_ROLE();
    assert.equal(
      await ledger.read.hasRole([
        defaultAdminRole,
        accounts.admin.account.address,
      ]),
      true,
    );
    assert.equal(
      await ledger.read.hasRole([
        registrarRole,
        accounts.registrar.account.address,
      ]),
      true,
    );
    assert.equal(
      await ledger.read.hasRole([
        defaultAdminRole,
        accounts.registrar.account.address,
      ]),
      false,
    );

    // Outsider cannot register or revoke actors
    await viem.assertions.revertWithCustomError(
      ledger.write.registerActor(
        [
          accounts.outsider.account.address,
          ONCHAIN_ACTOR_ROLE_MAP.GENERATOR,
          GEN_ORG_ID,
        ],
        { account: accounts.outsider.account },
      ),
      ledger,
      'UnauthorizedRegistrar',
    );
    await viem.assertions.revertWithCustomError(
      ledger.write.revokeActor([accounts.generator.account.address], {
        account: accounts.outsider.account,
      }),
      ledger,
      'UnauthorizedRegistrar',
    );

    // Admin can register and emit ActorRegistered
    await viem.assertions.emitWithArgs(
      ledger.write.registerActor(
        [
          accounts.outsider.account.address,
          ONCHAIN_ACTOR_ROLE_MAP.TRANSPORTER,
          TRANS_ORG_ID,
        ],
        { account: accounts.admin.account },
      ),
      ledger,
      'ActorRegistered',
      [
        accounts.outsider.account.address,
        ONCHAIN_ACTOR_ROLE_MAP.TRANSPORTER,
        TRANS_ORG_ID,
      ],
    );

    // Invalid registration arguments revert cleanly
    await viem.assertions.revertWithCustomError(
      ledger.write.registerActor(
        [zeroAddress, ONCHAIN_ACTOR_ROLE_MAP.GENERATOR, GEN_ORG_ID],
        { account: accounts.registrar.account },
      ),
      ledger,
      'ZeroAddress',
    );
    await viem.assertions.revertWithCustomError(
      ledger.write.registerActor(
        [
          accounts.outsider.account.address,
          ONCHAIN_ACTOR_ROLE_MAP.NONE,
          GEN_ORG_ID,
        ],
        { account: accounts.registrar.account },
      ),
      ledger,
      'InvalidActorRole',
    );
    await viem.assertions.revertWithCustomError(
      ledger.write.registerActor(
        [
          accounts.outsider.account.address,
          ONCHAIN_ACTOR_ROLE_MAP.GENERATOR,
          ZERO_BYTES32,
        ],
        { account: accounts.registrar.account },
      ),
      ledger,
      'InvalidOrgId',
    );
  });

  it('executes full lifecycle (create -> pickup -> delivery -> treatment) via permissionless 3rd-party relay', async function () {
    const { ledger, publicClient, accounts, signIntent } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    // 1. CREATED by generator, relayed by unrelated 3rd-party relayer
    const createSigned = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      toOrgUuid: GEN_ORG_UUID,
      weightKg: '1250',
    });

    const createTx = await ledger.write.createBatch(
      [createSigned.intent, createSigned.signature],
      { account: accounts.relayer.account },
    );
    const createReceipt = await publicClient.waitForTransactionReceipt({
      hash: createTx,
    });
    const createBlock = await publicClient.getBlock({
      blockNumber: createReceipt.blockNumber,
    });

    let batch = await ledger.read.getBatch([createSigned.batchId]);
    assert.equal(batch.exists, true);
    assert.equal(batch.status, ONCHAIN_BATCH_STATUS_MAP.REGISTERED);
    assert.equal(batch.headHash, createSigned.eventHash);
    assert.equal(batch.currentCustodianOrgId, GEN_ORG_ID);
    assert.equal(batch.eventCount, 1);
    assert.equal(
      await ledger.read.eventCount([createSigned.batchId]),
      1,
    );

    const ev1 = await ledger.read.getEvent([createSigned.batchId, 1]);
    assert.equal(ev1.seq, 1);
    assert.equal(ev1.eventType, EVENT_TYPE_TO_UINT8.CREATED);
    assert.equal(ev1.eventHash, createSigned.eventHash);
    assert.equal(ev1.prevHash, ZERO_BYTES32);
    assert.equal(ev1.targetSeq, 0);
    assert.equal(ev1.actor, getAddress(accounts.generator.account.address));
    assert.equal(ev1.orgId, GEN_ORG_ID);
    assert.equal(ev1.timestamp, createBlock.timestamp);

    // 2. Pickup (CUSTODY_TRANSFERRED) by transporter, relayed by relayer
    const pickupSigned = await signIntent({
      signer: accounts.transporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 2,
      prevHash: createSigned.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
      fromOrgUuid: GEN_ORG_UUID,
      toOrgUuid: TRANS_ORG_UUID,
      weightKg: '1245',
    });

    await viem.assertions.emit(
      ledger.write.transferCustody(
        [pickupSigned.intent, pickupSigned.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'CustodyTransferred',
    );

    batch = await ledger.read.getBatch([createSigned.batchId]);
    assert.equal(batch.status, ONCHAIN_BATCH_STATUS_MAP.IN_TRANSIT);
    assert.equal(batch.headHash, pickupSigned.eventHash);
    assert.equal(batch.currentCustodianOrgId, TRANS_ORG_ID);
    assert.equal(batch.eventCount, 2);

    // 3. Delivery (CUSTODY_TRANSFERRED) by facility, relayed by relayer
    const deliverySigned = await signIntent({
      signer: accounts.facility,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 3,
      prevHash: pickupSigned.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
      fromOrgUuid: TRANS_ORG_UUID,
      toOrgUuid: FAC_ORG_UUID,
      weightKg: '1245',
    });

    await ledger.write.transferCustody(
      [deliverySigned.intent, deliverySigned.signature],
      { account: accounts.relayer.account },
    );

    batch = await ledger.read.getBatch([createSigned.batchId]);
    assert.equal(batch.status, ONCHAIN_BATCH_STATUS_MAP.RECEIVED);
    assert.equal(batch.headHash, deliverySigned.eventHash);
    assert.equal(batch.currentCustodianOrgId, FAC_ORG_ID);
    assert.equal(batch.eventCount, 3);

    // 4. Treatment (TREATMENT) by receiving facility, relayed by relayer
    const treatSigned = await signIntent({
      signer: accounts.facility,
      eventType: 'TREATMENT',
      seq: 4,
      prevHash: deliverySigned.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
      notes: 'Thermal incineration complete',
    });

    await viem.assertions.emit(
      ledger.write.recordTreatment(
        [treatSigned.intent, treatSigned.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'TreatmentRecorded',
    );

    batch = await ledger.read.getBatch([createSigned.batchId]);
    assert.equal(batch.status, ONCHAIN_BATCH_STATUS_MAP.TREATED);
    assert.equal(batch.headHash, treatSigned.eventHash);
    assert.equal(batch.currentCustodianOrgId, FAC_ORG_ID);
    assert.equal(batch.eventCount, 4);

    const ev4 = await ledger.read.getEvent([createSigned.batchId, 4]);
    assert.equal(ev4.seq, 4);
    assert.equal(ev4.eventType, EVENT_TYPE_TO_UINT8.TREATMENT);
    assert.equal(ev4.prevHash, deliverySigned.eventHash);
    assert.equal(ev4.actor, getAddress(accounts.facility.account.address));

    assert.equal(
      await ledger.read.nonces([accounts.generator.account.address]),
      1n,
    );
    assert.equal(
      await ledger.read.nonces([accounts.transporter.account.address]),
      1n,
    );
    assert.equal(
      await ledger.read.nonces([accounts.facility.account.address]),
      2n,
    );
  });

  it('rejects wrong signer, tampered payload, replayed nonce, wrong nonce, expired deadline, and wrong prevHash', async function () {
    const { ledger, accounts, signIntent } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    // Wrong signer (signed by outsider when intent.actor == generator)
    const wrongSigner = await signIntent({
      signer: accounts.generator,
      signingWalletOverride: accounts.outsider,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch([wrongSigner.intent, wrongSigner.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'InvalidSignature',
    );

    // Tampered intent field after signing
    const validForTamper = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [
          {
            ...validForTamper.intent,
            eventHash: computeOnChainBatchId('tampered-hash'),
          },
          validForTamper.signature,
        ],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidSignature',
    );

    // Wrong non-zero prevHash on createBatch
    const badPrevCreate = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: computeOnChainBatchId('non-zero'),
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [badPrevCreate.intent, badPrevCreate.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidPrevHash',
    );

    // Wrong nonce
    const wrongNonce = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
      nonceOverride: 5n,
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch([wrongNonce.intent, wrongNonce.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'InvalidAccountNonce',
    );

    // Expired deadline
    const expired = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
      deadlineOffsetSeconds: 10,
    });
    await networkHelpers.time.increase(20);
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch([expired.intent, expired.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'IntentExpired',
    );

    // Execute valid batch creation, then test replayed nonce & wrong prevHash on transfer
    const createOk = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
    });
    await ledger.write.createBatch([createOk.intent, createOk.signature], {
      account: accounts.relayer.account,
    });

    // Replayed nonce (re-submitting same signed intent on a fresh batchId)
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch([createOk.intent, createOk.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'InvalidAccountNonce',
    );

    // Wrong prevHash on transferCustody
    const badPrevTransfer = await signIntent({
      signer: accounts.transporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 2,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: TRANS_ORG_UUID,
      fromOrgUuid: GEN_ORG_UUID,
      toOrgUuid: TRANS_ORG_UUID,
      weightKg: '500',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.transferCustody(
        [badPrevTransfer.intent, badPrevTransfer.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidPrevHash',
    );

    // Duplicate batchId rejected (using new nonce from generator2)
    const duplicateBatch = await signIntent({
      signer: accounts.generator2,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '500',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [duplicateBatch.intent, duplicateBatch.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'BatchAlreadyExists',
    );
  });

  it('rejects invalid state transitions, wrong roles, same-org transfers, and wrong-facility treatment', async function () {
    const { ledger, accounts, signIntent } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    // Non-GENERATOR cannot createBatch
    const transporterCreate = await signIntent({
      signer: accounts.transporter,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: TRANS_ORG_UUID,
      weightKg: '100',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [transporterCreate.intent, transporterCreate.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidActorRole',
    );

    // Transfer on nonexistent batch fails
    const ghostTransfer = await signIntent({
      signer: accounts.transporter,
      batchUuid: BATCH_UUID_2,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 2,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: TRANS_ORG_UUID,
      weightKg: '100',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.transferCustody(
        [ghostTransfer.intent, ghostTransfer.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'BatchNotFound',
    );

    // Create valid batch
    const createOk = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '800',
    });
    await ledger.write.createBatch([createOk.intent, createOk.signature], {
      account: accounts.relayer.account,
    });

    // Facility cannot skip transporter pickup from REGISTERED
    const facilitySkip = await signIntent({
      signer: accounts.facility,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 2,
      prevHash: createOk.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
      fromOrgUuid: GEN_ORG_UUID,
      toOrgUuid: FAC_ORG_UUID,
      weightKg: '800',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.transferCustody(
        [facilitySkip.intent, facilitySkip.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidActorRole',
    );

    // Transporter in the SAME org as generator cannot take custody
    const sameOrgPickup = await signIntent({
      signer: accounts.sameOrgTransporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 2,
      prevHash: createOk.eventHash,
      actorOrgUuid: GEN_ORG_UUID,
      fromOrgUuid: GEN_ORG_UUID,
      toOrgUuid: GEN_ORG_UUID,
      weightKg: '800',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.transferCustody(
        [sameOrgPickup.intent, sameOrgPickup.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'SameOrganizationTransfer',
    );

    // Cannot recordTreatment while REGISTERED
    const earlyTreat = await signIntent({
      signer: accounts.facility,
      eventType: 'TREATMENT',
      seq: 2,
      prevHash: createOk.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.recordTreatment(
        [earlyTreat.intent, earlyTreat.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidBatchStatus',
    );

    // Valid pickup -> IN_TRANSIT
    const pickupOk = await signIntent({
      signer: accounts.transporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 2,
      prevHash: createOk.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
      fromOrgUuid: GEN_ORG_UUID,
      toOrgUuid: TRANS_ORG_UUID,
      weightKg: '800',
    });
    await ledger.write.transferCustody(
      [pickupOk.intent, pickupOk.signature],
      { account: accounts.relayer.account },
    );

    // Another transporter cannot transfer when IN_TRANSIT
    const transporterAgain = await signIntent({
      signer: accounts.transporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 3,
      prevHash: pickupOk.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
      fromOrgUuid: TRANS_ORG_UUID,
      toOrgUuid: TRANS_ORG_UUID,
      weightKg: '800',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.transferCustody(
        [transporterAgain.intent, transporterAgain.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidActorRole',
    );

    // Valid delivery to facility1 -> RECEIVED
    const deliveryOk = await signIntent({
      signer: accounts.facility,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 3,
      prevHash: pickupOk.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
      fromOrgUuid: TRANS_ORG_UUID,
      toOrgUuid: FAC_ORG_UUID,
      weightKg: '800',
    });
    await ledger.write.transferCustody(
      [deliveryOk.intent, deliveryOk.signature],
      { account: accounts.relayer.account },
    );

    // Transfer after RECEIVED is disallowed
    const extraTransfer = await signIntent({
      signer: accounts.transporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 4,
      prevHash: deliveryOk.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
      fromOrgUuid: FAC_ORG_UUID,
      toOrgUuid: TRANS_ORG_UUID,
      weightKg: '800',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.transferCustody(
        [extraTransfer.intent, extraTransfer.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidBatchStatus',
    );

    // Different facility organization cannot recordTreatment
    const wrongFacilityTreat = await signIntent({
      signer: accounts.facility2,
      eventType: 'TREATMENT',
      seq: 4,
      prevHash: deliveryOk.eventHash,
      actorOrgUuid: FAC2_ORG_UUID,
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.recordTreatment(
        [wrongFacilityTreat.intent, wrongFacilityTreat.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'OrganizationMismatch',
    );

    // Non-FACILITY cannot recordTreatment
    const transporterTreat = await signIntent({
      signer: accounts.transporter,
      eventType: 'TREATMENT',
      seq: 4,
      prevHash: deliveryOk.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.recordTreatment(
        [transporterTreat.intent, transporterTreat.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidActorRole',
    );

    // Correct facility treats -> TREATED
    const treatOk = await signIntent({
      signer: accounts.facility,
      eventType: 'TREATMENT',
      seq: 4,
      prevHash: deliveryOk.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
    });
    await ledger.write.recordTreatment([treatOk.intent, treatOk.signature], {
      account: accounts.relayer.account,
    });

    // Cannot treat twice
    const secondTreat = await signIntent({
      signer: accounts.facility,
      eventType: 'TREATMENT',
      seq: 5,
      prevHash: treatOk.eventHash,
      actorOrgUuid: FAC_ORG_UUID,
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.recordTreatment(
        [secondTreat.intent, secondTreat.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidBatchStatus',
    );
  });

  it('handles append-only revisions properly and enforces org, targetSeq, and non-revision target invariants', async function () {
    const { ledger, accounts, signIntent } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    const createOk = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      toOrgUuid: GEN_ORG_UUID,
      weightKg: '1000',
    });
    await ledger.write.createBatch([createOk.intent, createOk.signature], {
      account: accounts.relayer.account,
    });

    const originalEvent1Before = await ledger.read.getEvent([
      createOk.batchId,
      1,
    ]);

    // Reject targetSeq == 0
    const revZero = await signIntent({
      signer: accounts.generator,
      eventType: 'REVISION',
      seq: 2,
      targetSeq: 0,
      prevHash: createOk.eventHash,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '1050',
      reasonCode: 'SCALE_RECALIBRATION',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createRevision([revZero.intent, revZero.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'InvalidTargetSeq',
    );

    // Reject targetSeq > eventCount
    const revOutOfRange = await signIntent({
      signer: accounts.generator,
      eventType: 'REVISION',
      seq: 2,
      targetSeq: 2,
      prevHash: createOk.eventHash,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '1050',
      reasonCode: 'SCALE_RECALIBRATION',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createRevision(
        [revOutOfRange.intent, revOutOfRange.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidTargetSeq',
    );

    // Reject cross-org revision
    const crossOrgRev = await signIntent({
      signer: accounts.transporter,
      eventType: 'REVISION',
      seq: 2,
      targetSeq: 1,
      prevHash: createOk.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
      weightKg: '1050',
      reasonCode: 'SCALE_RECALIBRATION',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createRevision([crossOrgRev.intent, crossOrgRev.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'OrganizationMismatch',
    );

    // Valid revision by a second member of the SAME generator organization
    const validRev = await signIntent({
      signer: accounts.generator2,
      eventType: 'REVISION',
      seq: 2,
      targetSeq: 1,
      prevHash: createOk.eventHash,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '1050',
      reasonCode: 'SCALE_RECALIBRATION',
      notes: 'Scale re-weighed after calibration',
    });
    await viem.assertions.emit(
      ledger.write.createRevision([validRev.intent, validRev.signature], {
        account: accounts.relayer.account,
      }),
      ledger,
      'RevisionCreated',
    );

    // Original event 1 and batch status/custodian remain unchanged, while headHash & eventCount advance
    const originalEvent1After = await ledger.read.getEvent([
      createOk.batchId,
      1,
    ]);
    assert.deepEqual(originalEvent1After, originalEvent1Before);

    const revEvent2 = await ledger.read.getEvent([createOk.batchId, 2]);
    assert.equal(revEvent2.seq, 2);
    assert.equal(revEvent2.eventType, EVENT_TYPE_TO_UINT8.REVISION);
    assert.equal(revEvent2.targetSeq, 1);
    assert.equal(revEvent2.prevHash, createOk.eventHash);
    assert.equal(revEvent2.eventHash, validRev.eventHash);
    assert.equal(revEvent2.orgId, GEN_ORG_ID);

    const batchAfterRev = await ledger.read.getBatch([createOk.batchId]);
    assert.equal(batchAfterRev.status, ONCHAIN_BATCH_STATUS_MAP.REGISTERED);
    assert.equal(batchAfterRev.currentCustodianOrgId, GEN_ORG_ID);
    assert.equal(batchAfterRev.headHash, validRev.eventHash);
    assert.equal(batchAfterRev.eventCount, 2);

    // Cannot target a REVISION event itself
    const revTargetingRev = await signIntent({
      signer: accounts.generator,
      eventType: 'REVISION',
      seq: 3,
      targetSeq: 2,
      prevHash: validRev.eventHash,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '1060',
      reasonCode: 'DATA_ENTRY_ERROR',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createRevision(
        [revTargetingRev.intent, revTargetingRev.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'CannotReviseRevision',
    );

    // Subsequent pickup must chain off revision's headHash
    const pickupAfterRev = await signIntent({
      signer: accounts.transporter,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 3,
      prevHash: validRev.eventHash,
      actorOrgUuid: TRANS_ORG_UUID,
      fromOrgUuid: GEN_ORG_UUID,
      toOrgUuid: TRANS_ORG_UUID,
      weightKg: '1050',
    });
    await ledger.write.transferCustody(
      [pickupAfterRev.intent, pickupAfterRev.signature],
      { account: accounts.relayer.account },
    );
    assert.equal(
      (await ledger.read.getBatch([createOk.batchId])).status,
      ONCHAIN_BATCH_STATUS_MAP.IN_TRANSIT,
    );

    // 1-based getEvent bounds checks
    await viem.assertions.revertWithCustomError(
      ledger.read.getEvent([createOk.batchId, 0]),
      ledger,
      'InvalidTargetSeq',
    );
    await viem.assertions.revertWithCustomError(
      ledger.read.getEvent([createOk.batchId, 4]),
      ledger,
      'InvalidTargetSeq',
    );
    await viem.assertions.revertWithCustomError(
      ledger.read.getEvent([computeOnChainBatchId(BATCH_UUID_2), 1]),
      ledger,
      'InvalidTargetSeq',
    );
  });

  it('rejects revoked actors and enforces emergency pause / unpause controls', async function () {
    const { ledger, accounts, signIntent } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    // Revoke generator -> cannot createBatch
    await viem.assertions.emitWithArgs(
      ledger.write.revokeActor([accounts.generator.account.address], {
        account: accounts.registrar.account,
      }),
      ledger,
      'ActorRevoked',
      [accounts.generator.account.address, GEN_ORG_ID],
    );

    const actorInfo = await ledger.read.getActor([
      accounts.generator.account.address,
    ]);
    assert.equal(actorInfo.active, false);

    const revokedIntent = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '300',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [revokedIntent.intent, revokedIntent.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'ActorNotActive',
    );

    // Revoking already inactive actor reverts
    await viem.assertions.revertWithCustomError(
      ledger.write.revokeActor([accounts.generator.account.address], {
        account: accounts.registrar.account,
      }),
      ledger,
      'ActorNotActive',
    );

    // Re-register generator -> succeeds
    await ledger.write.registerActor(
      [
        accounts.generator.account.address,
        ONCHAIN_ACTOR_ROLE_MAP.GENERATOR,
        GEN_ORG_ID,
      ],
      { account: accounts.registrar.account },
    );

    // Only DEFAULT_ADMIN_ROLE can pause / unpause
    await viem.assertions.revertWithCustomError(
      ledger.write.pause({ account: accounts.registrar.account }),
      ledger,
      'AccessControlUnauthorizedAccount',
    );
    await viem.assertions.revertWithCustomError(
      ledger.write.pause({ account: accounts.outsider.account }),
      ledger,
      'AccessControlUnauthorizedAccount',
    );

    await ledger.write.pause({ account: accounts.admin.account });
    assert.equal(await ledger.read.paused(), true);

    const pausedCreate = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '300',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [pausedCreate.intent, pausedCreate.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'EnforcedPause',
    );

    await viem.assertions.revertWithCustomError(
      ledger.write.unpause({ account: accounts.registrar.account }),
      ledger,
      'AccessControlUnauthorizedAccount',
    );

    await ledger.write.unpause({ account: accounts.admin.account });
    assert.equal(await ledger.read.paused(), false);

    // Succeeds after unpause
    await ledger.write.createBatch(
      [pausedCreate.intent, pausedCreate.signature],
      { account: accounts.relayer.account },
    );
    assert.equal(
      (await ledger.read.getBatch([pausedCreate.batchId])).status,
      ONCHAIN_BATCH_STATUS_MAP.REGISTERED,
    );
  });

  it('enforces zero-value guards, eventType matching, non-revision targetSeq == 0, and exports metadata', async function () {
    const { ledger, accounts, signIntent } =
      await networkHelpers.loadFixture(deployLedgerFixture);

    // Zero batchId
    const zeroBatchIntent = await signIntent({
      signer: accounts.generator,
      batchIdOverride: ZERO_BYTES32,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '100',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [zeroBatchIntent.intent, zeroBatchIntent.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'ZeroBatchId',
    );

    // Zero eventHash
    const zeroHashIntent = await signIntent({
      signer: accounts.generator,
      eventHashOverride: ZERO_BYTES32,
      eventType: 'CREATED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '100',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [zeroHashIntent.intent, zeroHashIntent.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'ZeroEventHash',
    );

    // Invalid eventType mismatch
    const wrongEventType = await signIntent({
      signer: accounts.generator,
      eventType: 'CUSTODY_TRANSFERRED',
      seq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '100',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [wrongEventType.intent, wrongEventType.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidEventType',
    );

    // Non-zero targetSeq on createBatch
    const nonZeroTargetOnCreate = await signIntent({
      signer: accounts.generator,
      eventType: 'CREATED',
      seq: 1,
      targetSeq: 1,
      prevHash: ZERO_BYTES32,
      actorOrgUuid: GEN_ORG_UUID,
      weightKg: '100',
    });
    await viem.assertions.revertWithCustomError(
      ledger.write.createBatch(
        [nonZeroTargetOnCreate.intent, nonZeroTargetOnCreate.signature],
        { account: accounts.relayer.account },
      ),
      ledger,
      'InvalidTargetSeq',
    );

    // Exports surface sanity checks
    assert.equal(CONTRACTS_VERSION, '0.1.0');
    assert.ok(Array.isArray(TRACEB3_LEDGER_ABI) && TRACEB3_LEDGER_ABI.length > 0);
    assert.equal(getLedgerAddress(999999), undefined);
    assert.equal(CHAIN_EXPLORER_BASE_URLS[84532], 'https://sepolia.basescan.org');
    assert.equal(
      getExplorerTxUrl(84532, ZERO_BYTES32),
      `https://sepolia.basescan.org/tx/${ZERO_BYTES32}`,
    );
    assert.equal(getExplorerTxUrl(31337, ZERO_BYTES32), null);
  });
});
