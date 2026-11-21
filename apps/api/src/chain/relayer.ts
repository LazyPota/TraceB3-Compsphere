import { EventEmitter } from 'node:events';
import { TRACEB3_LEDGER_ABI } from '@traceb3/contracts';
import {
  EVENT_TYPE_TO_UINT8,
  evaluateDiscrepancies,
  type BatchStatus,
  type ChainStatus,
  type DiscrepancyEventInput,
  type EventType,
} from '@traceb3/core';
import { asc, eq, inArray, lte, and } from 'drizzle-orm';
import { getAddress, type Hex } from 'viem';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { batches, chainJobs, custodyEvents } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { ChainClient, decodeContractRevert } from './client.js';

export interface EventStatusUpdate {
  eventId: string;
  batchId: string;
  seq: number;
  chainStatus: ChainStatus;
  txHash: string | null;
  blockNumber: number | null;
  anchoredAt: string | null;
  failureReason: string | null;
}

export interface ChainRelayWorkerDeps {
  config: AppConfig;
  logger: Logger;
  db: DatabaseClient;
  chain: ChainClient;
}

/**
 * Single-concurrency FIFO chain relay worker and relayer mutex.
 * Guarantees sequential relayer wallet nonces across custody anchors and actor registry mutations.
 */
export class ChainRelayWorker {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly db: DatabaseClient;
  private readonly chain: ChainClient;
  private readonly bus = new EventEmitter();
  private tail: Promise<void> = Promise.resolve();
  private activeTasks = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: ChainRelayWorkerDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.db = deps.db;
    this.chain = deps.chain;
    this.bus.setMaxListeners(100);
  }

  onEventUpdate(
    eventId: string,
    listener: (update: EventStatusUpdate) => void,
  ): () => void {
    const channel = `event:${eventId}`;
    this.bus.on(channel, listener);
    return () => {
      this.bus.off(channel, listener);
    };
  }

  private emitUpdate(update: EventStatusUpdate): void {
    this.bus.emit(`event:${update.eventId}`, update);
    this.bus.emit('event:*', update);
  }

  /**
   * Executes a relayer-wallet operation strictly one at a time to avoid nonce collisions.
   */
  enqueueExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.activeTasks += 1;
    const run = this.tail.then(task, task);
    const finalized = run.finally(() => {
      this.activeTasks -= 1;
    });
    this.tail = finalized.then(
      () => undefined,
      () => undefined,
    );
    return finalized;
  }

  async waitForIdle(): Promise<void> {
    while (this.activeTasks > 0) {
      await this.tail;
    }
  }

  start(pollIntervalMs = 1500): void {
    if (this.pollTimer) {
      return;
    }
    this.stopped = false;
    this.pollTimer = setInterval(() => {
      if (!this.stopped) {
        void this.triggerDrain();
      }
    }, pollIntervalMs);
    this.pollTimer.unref();
    void this.triggerDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.waitForIdle();
  }

  triggerDrain(): Promise<void> {
    return this.enqueueExclusive(async () => {
      await this.drainAvailableJobs();
    });
  }

  async registerActorOnChain(
    wallet: `0x${string}`,
    onChainRole: number,
    onChainOrgId: `0x${string}`,
  ): Promise<{ txHash: `0x${string}` }> {
    return this.enqueueExclusive(async () => {
      const ledgerAddress = this.chain.ledgerAddress;
      const walletClient = this.chain.walletClient;
      const relayerAccount = this.chain.relayerAccount;
      if (!ledgerAddress || !walletClient || !relayerAccount) {
        throw AppError.chainUnavailable(
          'LEDGER_ADDRESS and RELAYER_PRIVATE_KEY are required for on-chain actor registration',
        );
      }

      const checksummed = getAddress(wallet);
      try {
        const sim = await this.chain.publicClient.simulateContract({
          address: ledgerAddress,
          abi: TRACEB3_LEDGER_ABI,
          functionName: 'registerActor',
          args: [checksummed, onChainRole, onChainOrgId],
          account: relayerAccount,
        });
        const txHash = await walletClient.writeContract(sim.request);
        const receipt = await this.chain.publicClient.waitForTransactionReceipt({
          hash: txHash,
        });
        if (receipt.status !== 'success') {
          throw AppError.chainRevert('registerActor transaction reverted on-chain');
        }
        return { txHash };
      } catch (err) {
        if (err instanceof AppError) {
          throw err;
        }
        const decoded = decodeContractRevert(err);
        if (decoded.isRevert) {
          throw new AppError({
            status: 422,
            code: decoded.code ?? 'CHAIN_REVERT',
            title: 'Contract Revert',
            detail: `${decoded.errorName}: ${decoded.message}`,
            cause: err,
          });
        }
        throw AppError.chainUnavailable(decoded.message, err);
      }
    });
  }

  async revokeActorOnChain(wallet: `0x${string}`): Promise<{ txHash: `0x${string}` }> {
    return this.enqueueExclusive(async () => {
      const ledgerAddress = this.chain.ledgerAddress;
      const walletClient = this.chain.walletClient;
      const relayerAccount = this.chain.relayerAccount;
      if (!ledgerAddress || !walletClient || !relayerAccount) {
        throw AppError.chainUnavailable(
          'LEDGER_ADDRESS and RELAYER_PRIVATE_KEY are required for on-chain actor revocation',
        );
      }

      const checksummed = getAddress(wallet);
      try {
        const sim = await this.chain.publicClient.simulateContract({
          address: ledgerAddress,
          abi: TRACEB3_LEDGER_ABI,
          functionName: 'revokeActor',
          args: [checksummed],
          account: relayerAccount,
        });
        const txHash = await walletClient.writeContract(sim.request);
        const receipt = await this.chain.publicClient.waitForTransactionReceipt({
          hash: txHash,
        });
        if (receipt.status !== 'success') {
          throw AppError.chainRevert('revokeActor transaction reverted on-chain');
        }
        return { txHash };
      } catch (err) {
        if (err instanceof AppError) {
          throw err;
        }
        const decoded = decodeContractRevert(err);
        if (decoded.isRevert) {
          throw new AppError({
            status: 422,
            code: decoded.code ?? 'CHAIN_REVERT',
            title: 'Contract Revert',
            detail: `${decoded.errorName}: ${decoded.message}`,
            cause: err,
          });
        }
        throw AppError.chainUnavailable(decoded.message, err);
      }
    });
  }

  private async drainAvailableJobs(): Promise<void> {
    while (!this.stopped) {
      const dueJobs = await this.db.db
        .select()
        .from(chainJobs)
        .where(
          and(
            eq(chainJobs.jobType, 'ANCHOR_EVENT'),
            inArray(chainJobs.status, ['PENDING', 'PROCESSING']),
            lte(chainJobs.nextRunAt, new Date()),
          ),
        )
        .orderBy(asc(chainJobs.createdAt))
        .limit(1);

      const job = dueJobs[0];
      if (!job) {
        return;
      }

      await this.processAnchorJob(job);
    }
  }

  private async processAnchorJob(
    job: typeof chainJobs.$inferSelect,
  ): Promise<void> {
    if (!job.eventId) {
      await this.db.db
        .update(chainJobs)
        .set({
          status: 'FAILED',
          lastError: 'Job missing eventId',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chainJobs.id, job.id));
      return;
    }

    const nextAttempts = job.attempts + 1;
    await this.db.db
      .update(chainJobs)
      .set({
        status: 'PROCESSING',
        attempts: nextAttempts,
        lockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(chainJobs.id, job.id));

    const eventRows = await this.db.db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.id, job.eventId))
      .limit(1);
    const event = eventRows[0];
    if (!event) {
      await this.markJobOnlyFailed(job.id, `Missing custody event ${job.eventId}`);
      return;
    }

    const batchRows = await this.db.db
      .select()
      .from(batches)
      .where(eq(batches.id, event.batchId))
      .limit(1);
    const batch = batchRows[0];
    if (!batch) {
      await this.markEventAndJobFailed(
        job.id,
        event,
        `Missing batch ${event.batchId}`,
      );
      return;
    }

    // Crash recovery: if a txHash was already submitted prior to a restart, resolve receipt first.
    const existingTxHash = (job.txHash ?? event.txHash) as `0x${string}` | null;
    if (existingTxHash) {
      const recovered = await this.tryRecoverSubmittedTx(
        job.id,
        event,
        batch,
        existingTxHash,
      );
      if (recovered) {
        return;
      }
    }

    const ledgerAddress = this.chain.ledgerAddress;
    const walletClient = this.chain.walletClient;
    const relayerAccount = this.chain.relayerAccount;
    if (!ledgerAddress || !walletClient || !relayerAccount) {
      await this.rescheduleOrFailTransient(
        job.id,
        job.maxAttempts,
        nextAttempts,
        event,
        'LEDGER_ADDRESS or RELAYER_PRIVATE_KEY is not configured',
      );
      return;
    }

    const intentArg = {
      batchId: batch.onChainBatchId as `0x${string}`,
      eventType: EVENT_TYPE_TO_UINT8[event.eventType],
      eventHash: event.eventHash as `0x${string}`,
      prevHash: event.prevEventHash as `0x${string}`,
      targetSeq: event.targetSeq ?? 0,
      actor: getAddress(event.actorWallet),
      nonce: BigInt(event.nonce),
      deadline: BigInt(event.deadline),
    };
    const signature = event.signature as Hex;

    let txHash: `0x${string}`;
    try {
      txHash = await this.simulateAndWriteEvent(
        ledgerAddress,
        walletClient,
        relayerAccount,
        event.eventType,
        intentArg,
        signature,
      );
    } catch (err) {
      const decoded = decodeContractRevert(err);
      if (decoded.isRevert) {
        const reason = `${decoded.errorName ?? 'Revert'}: ${decoded.message}`;
        this.logger.warn(
          { eventId: event.id, batchId: event.batchId, reason },
          'Custody event reverted during contract simulation; marking FAILED',
        );
        await this.markEventAndJobFailed(job.id, event, reason);
        return;
      }

      this.logger.warn(
        { err, eventId: event.id, attempt: nextAttempts },
        'Transient chain error while submitting custody event',
      );
      await this.rescheduleOrFailTransient(
        job.id,
        job.maxAttempts,
        nextAttempts,
        event,
        decoded.message,
      );
      return;
    }

    await this.db.db
      .update(custodyEvents)
      .set({
        chainStatus: 'SUBMITTED',
        txHash,
      })
      .where(eq(custodyEvents.id, event.id));

    await this.db.db
      .update(chainJobs)
      .set({
        txHash,
        updatedAt: new Date(),
      })
      .where(eq(chainJobs.id, job.id));

    this.emitUpdate({
      eventId: event.id,
      batchId: event.batchId,
      seq: event.seq,
      chainStatus: 'SUBMITTED',
      txHash,
      blockNumber: null,
      anchoredAt: null,
      failureReason: null,
    });

    try {
      const receipt = await this.chain.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status !== 'success') {
        await this.markEventAndJobFailed(
          job.id,
          event,
          `Transaction reverted on-chain (${txHash})`,
        );
        return;
      }

      const block = await this.chain.publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      const anchoredAt = new Date(Number(block.timestamp) * 1000);
      await this.finalizeAnchoredEvent(
        job.id,
        event,
        batch,
        txHash,
        Number(receipt.blockNumber),
        anchoredAt,
      );
    } catch (err) {
      const decoded = decodeContractRevert(err);
      if (decoded.isRevert) {
        await this.markEventAndJobFailed(
          job.id,
          event,
          `${decoded.errorName ?? 'Revert'}: ${decoded.message}`,
        );
        return;
      }
      await this.rescheduleOrFailTransient(
        job.id,
        job.maxAttempts,
        nextAttempts,
        event,
        decoded.message,
      );
    }
  }

  private async tryRecoverSubmittedTx(
    jobId: string,
    event: typeof custodyEvents.$inferSelect,
    batch: typeof batches.$inferSelect,
    txHash: `0x${string}`,
  ): Promise<boolean> {
    try {
      const receipt = await this.chain.publicClient.getTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status !== 'success') {
        await this.markEventAndJobFailed(
          jobId,
          event,
          `Recovered transaction reverted on-chain (${txHash})`,
        );
        return true;
      }
      const block = await this.chain.publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      const anchoredAt = new Date(Number(block.timestamp) * 1000);
      await this.finalizeAnchoredEvent(
        jobId,
        event,
        batch,
        txHash,
        Number(receipt.blockNumber),
        anchoredAt,
      );
      return true;
    } catch {
      try {
        const pendingTx = await this.chain.publicClient.getTransaction({
          hash: txHash,
        });
        if (pendingTx) {
          const receipt = await this.chain.publicClient.waitForTransactionReceipt({
            hash: txHash,
          });
          if (receipt.status !== 'success') {
            await this.markEventAndJobFailed(
              jobId,
              event,
              `Recovered pending transaction reverted (${txHash})`,
            );
            return true;
          }
          const block = await this.chain.publicClient.getBlock({
            blockNumber: receipt.blockNumber,
          });
          const anchoredAt = new Date(Number(block.timestamp) * 1000);
          await this.finalizeAnchoredEvent(
            jobId,
            event,
            batch,
            txHash,
            Number(receipt.blockNumber),
            anchoredAt,
          );
          return true;
        }
      } catch {
        // Transaction no longer exists on chain/mempool; allow normal re-simulation.
      }
      return false;
    }
  }

  private async simulateAndWriteEvent(
    ledgerAddress: `0x${string}`,
    walletClient: NonNullable<ChainClient['walletClient']>,
    account: NonNullable<ChainClient['relayerAccount']>,
    eventType: EventType,
    intentArg: {
      batchId: `0x${string}`;
      eventType: number;
      eventHash: `0x${string}`;
      prevHash: `0x${string}`;
      targetSeq: number;
      actor: `0x${string}`;
      nonce: bigint;
      deadline: bigint;
    },
    signature: Hex,
  ): Promise<`0x${string}`> {
    switch (eventType) {
      case 'CREATED': {
        const sim = await this.chain.publicClient.simulateContract({
          address: ledgerAddress,
          abi: TRACEB3_LEDGER_ABI,
          functionName: 'createBatch',
          args: [intentArg, signature],
          account,
        });
        return walletClient.writeContract(sim.request);
      }
      case 'CUSTODY_TRANSFERRED': {
        const sim = await this.chain.publicClient.simulateContract({
          address: ledgerAddress,
          abi: TRACEB3_LEDGER_ABI,
          functionName: 'transferCustody',
          args: [intentArg, signature],
          account,
        });
        return walletClient.writeContract(sim.request);
      }
      case 'REVISION': {
        const sim = await this.chain.publicClient.simulateContract({
          address: ledgerAddress,
          abi: TRACEB3_LEDGER_ABI,
          functionName: 'createRevision',
          args: [intentArg, signature],
          account,
        });
        return walletClient.writeContract(sim.request);
      }
      case 'TREATMENT': {
        const sim = await this.chain.publicClient.simulateContract({
          address: ledgerAddress,
          abi: TRACEB3_LEDGER_ABI,
          functionName: 'recordTreatment',
          args: [intentArg, signature],
          account,
        });
        return walletClient.writeContract(sim.request);
      }
    }
  }

  private async finalizeAnchoredEvent(
    jobId: string,
    event: typeof custodyEvents.$inferSelect,
    batch: typeof batches.$inferSelect,
    txHash: `0x${string}`,
    blockNumber: number,
    anchoredAt: Date,
  ): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      await tx
        .update(custodyEvents)
        .set({
          chainStatus: 'ANCHORED',
          txHash,
          blockNumber,
          anchoredAt,
          failureReason: null,
        })
        .where(eq(custodyEvents.id, event.id));

      const allEvents = await tx
        .select()
        .from(custodyEvents)
        .where(eq(custodyEvents.batchId, batch.id))
        .orderBy(asc(custodyEvents.seq));

      const discrepancyInputs: DiscrepancyEventInput[] = allEvents.map((row) => ({
        id: row.id,
        seq: row.seq,
        type: row.eventType,
        quantity: row.record.quantity,
        targetSeq: row.targetSeq,
        reasonCode: row.reasonCode,
        anchoredAt: row.id === event.id ? anchoredAt : row.anchoredAt,
        chainStatus: row.id === event.id ? 'ANCHORED' : row.chainStatus,
      }));

      const report = evaluateDiscrepancies(discrepancyInputs, {
        weightTolerancePct: this.config.WEIGHT_TOLERANCE_PCT,
        custodyGapHours: this.config.CUSTODY_GAP_HOURS,
      });

      let nextStatus: BatchStatus = batch.status;
      let nextCustodianOrgId = batch.currentCustodianOrgId;
      if (event.eventType === 'CREATED') {
        nextStatus = 'REGISTERED';
        nextCustodianOrgId = event.toOrgId ?? event.actorOrgId;
      } else if (event.eventType === 'CUSTODY_TRANSFERRED') {
        nextStatus = batch.status === 'REGISTERED' ? 'IN_TRANSIT' : 'RECEIVED';
        nextCustodianOrgId = event.toOrgId ?? event.actorOrgId;
      } else if (event.eventType === 'TREATMENT') {
        nextStatus = 'TREATED';
      }

      await tx
        .update(batches)
        .set({
          status: nextStatus,
          currentCustodianOrgId: nextCustodianOrgId,
          latestEventSeq: event.seq,
          latestEventHash: event.eventHash,
          hasDiscrepancy: report.hasDiscrepancy,
          maxDiscrepancySeverity: report.maxSeverity,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batch.id));

      await tx
        .update(chainJobs)
        .set({
          status: 'CONFIRMED',
          txHash,
          lastError: null,
          lockedAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chainJobs.id, jobId));
    });

    this.logger.info(
      {
        eventId: event.id,
        batchId: event.batchId,
        seq: event.seq,
        txHash,
        blockNumber,
      },
      'Custody event anchored on-chain',
    );

    this.emitUpdate({
      eventId: event.id,
      batchId: event.batchId,
      seq: event.seq,
      chainStatus: 'ANCHORED',
      txHash,
      blockNumber,
      anchoredAt: anchoredAt.toISOString(),
      failureReason: null,
    });
  }

  private async markJobOnlyFailed(jobId: string, reason: string): Promise<void> {
    await this.db.db
      .update(chainJobs)
      .set({
        status: 'FAILED',
        lastError: reason,
        lockedAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(chainJobs.id, jobId));
  }

  private async markEventAndJobFailed(
    jobId: string,
    event: typeof custodyEvents.$inferSelect,
    reason: string,
  ): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      await tx
        .update(custodyEvents)
        .set({
          chainStatus: 'FAILED',
          failureReason: reason,
        })
        .where(eq(custodyEvents.id, event.id));

      await tx
        .update(chainJobs)
        .set({
          status: 'FAILED',
          lastError: reason,
          lockedAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chainJobs.id, jobId));
    });

    this.emitUpdate({
      eventId: event.id,
      batchId: event.batchId,
      seq: event.seq,
      chainStatus: 'FAILED',
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      anchoredAt: null,
      failureReason: reason,
    });
  }

  private async rescheduleOrFailTransient(
    jobId: string,
    maxAttempts: number,
    attempts: number,
    event: typeof custodyEvents.$inferSelect,
    reason: string,
  ): Promise<void> {
    if (attempts >= maxAttempts) {
      await this.markEventAndJobFailed(
        jobId,
        event,
        `Exhausted ${maxAttempts} relay attempts: ${reason}`,
      );
      return;
    }

    const backoffMs = Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1));
    await this.db.db
      .update(chainJobs)
      .set({
        status: 'PENDING',
        lastError: reason,
        lockedAt: null,
        nextRunAt: new Date(Date.now() + backoffMs),
        updatedAt: new Date(),
      })
      .where(eq(chainJobs.id, jobId));
  }
}
