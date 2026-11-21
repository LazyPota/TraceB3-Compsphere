import { TRACEB3_LEDGER_ABI } from '@traceb3/contracts';
import {
  evaluateDiscrepancies,
  type BatchStatus,
  type DiscrepancyEventInput,
} from '@traceb3/core';
import { asc, eq, inArray } from 'drizzle-orm';
import { decodeEventLog } from 'viem';
import type { ChainClient } from '../chain/client.js';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { batches, chainJobs, custodyEvents } from '../db/schema.js';
import type { Logger } from '../logger.js';

export interface ReconcileResult {
  scannedLogs: number;
  reconciledEvents: number;
  reconciledEventIds: string[];
}

export interface ChainReconcilerDeps {
  config: AppConfig;
  logger: Logger;
  db: DatabaseClient;
  chain: ChainClient;
}

interface MatchedLogInfo {
  batchId: string;
  seq: number;
  eventHash: string;
  txHash: `0x${string}`;
  blockNumber: bigint;
}

const CUSTODY_EVENT_NAMES = new Set([
  'BatchCreated',
  'CustodyTransferred',
  'RevisionCreated',
  'TreatmentRecorded',
]);

/**
 * Periodically scans TraceB3Ledger contract event logs and repairs any PENDING/SUBMITTED
 * database anchor records that have already confirmed on-chain.
 */
export class ChainReconciler {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly db: DatabaseClient;
  private readonly chain: ChainClient;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: ChainReconcilerDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.db = deps.db;
    this.chain = deps.chain;
  }

  start(intervalMs = 15_000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.reconcileOnce().catch((err) => {
        this.logger.warn({ err }, 'Chain reconciler pass failed');
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reconcileOnce(options?: { fromBlock?: bigint }): Promise<ReconcileResult> {
    if (this.running) {
      return { scannedLogs: 0, reconciledEvents: 0, reconciledEventIds: [] };
    }
    this.running = true;

    try {
      const unanchored = await this.db.db
        .select({
          event: custodyEvents,
          onChainBatchId: batches.onChainBatchId,
        })
        .from(custodyEvents)
        .innerJoin(batches, eq(custodyEvents.batchId, batches.id))
        .where(inArray(custodyEvents.chainStatus, ['PENDING', 'SUBMITTED']));

      if (unanchored.length === 0 || !this.chain.ledgerAddress) {
        return { scannedLogs: 0, reconciledEvents: 0, reconciledEventIds: [] };
      }

      const rawLogs = await this.chain.publicClient.getLogs({
        address: this.chain.ledgerAddress,
        fromBlock: options?.fromBlock ?? 0n,
        toBlock: 'latest',
      });

      const decodedLogs: MatchedLogInfo[] = [];
      for (const log of rawLogs) {
        if (!log.transactionHash || log.blockNumber === null) {
          continue;
        }
        try {
          const decoded = decodeEventLog({
            abi: TRACEB3_LEDGER_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (!CUSTODY_EVENT_NAMES.has(decoded.eventName)) {
            continue;
          }
          const args = decoded.args as unknown as {
            batchId?: string;
            seq?: number | bigint;
            eventHash?: string;
          };
          if (args.batchId && args.seq !== undefined && args.eventHash) {
            decodedLogs.push({
              batchId: args.batchId.toLowerCase(),
              seq: Number(args.seq),
              eventHash: args.eventHash.toLowerCase(),
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
            });
          }
        } catch {
          // Ignore unrecognized logs
        }
      }

      const reconciledEventIds: string[] = [];

      for (const row of unanchored) {
        const match = decodedLogs.find(
          (l) =>
            l.batchId === row.onChainBatchId.toLowerCase() &&
            l.seq === row.event.seq &&
            l.eventHash === row.event.eventHash.toLowerCase(),
        );
        if (!match) {
          continue;
        }

        const block = await this.chain.publicClient.getBlock({
          blockNumber: match.blockNumber,
        });
        const anchoredAt = new Date(Number(block.timestamp) * 1000);
        const blockNum = Number(match.blockNumber);

        await this.db.db.transaction(async (tx) => {
          const currentRows = await tx
            .select()
            .from(custodyEvents)
            .where(eq(custodyEvents.id, row.event.id))
            .limit(1);
          const current = currentRows[0];
          if (!current || current.chainStatus === 'ANCHORED') {
            return;
          }

          await tx
            .update(custodyEvents)
            .set({
              chainStatus: 'ANCHORED',
              txHash: match.txHash,
              blockNumber: blockNum,
              anchoredAt,
              failureReason: null,
            })
            .where(eq(custodyEvents.id, current.id));

          const batchRows = await tx
            .select()
            .from(batches)
            .where(eq(batches.id, current.batchId))
            .limit(1);
          const batch = batchRows[0];
          if (batch) {
            const allEvents = await tx
              .select()
              .from(custodyEvents)
              .where(eq(custodyEvents.batchId, batch.id))
              .orderBy(asc(custodyEvents.seq));

            const inputs: DiscrepancyEventInput[] = allEvents.map((ev) => ({
              id: ev.id,
              seq: ev.seq,
              type: ev.eventType,
              quantity: ev.record.quantity,
              targetSeq: ev.targetSeq,
              reasonCode: ev.reasonCode,
              anchoredAt: ev.id === current.id ? anchoredAt : ev.anchoredAt,
              chainStatus: ev.id === current.id ? 'ANCHORED' : ev.chainStatus,
            }));

            const report = evaluateDiscrepancies(inputs, {
              weightTolerancePct: this.config.WEIGHT_TOLERANCE_PCT,
              custodyGapHours: this.config.CUSTODY_GAP_HOURS,
            });

            let nextStatus: BatchStatus = batch.status;
            let nextCustodian = batch.currentCustodianOrgId;
            if (current.eventType === 'CREATED') {
              nextStatus = 'REGISTERED';
              nextCustodian = current.toOrgId ?? current.actorOrgId;
            } else if (current.eventType === 'CUSTODY_TRANSFERRED') {
              nextStatus =
                batch.status === 'REGISTERED' ? 'IN_TRANSIT' : 'RECEIVED';
              nextCustodian = current.toOrgId ?? current.actorOrgId;
            } else if (current.eventType === 'TREATMENT') {
              nextStatus = 'TREATED';
            }

            await tx
              .update(batches)
              .set({
                status: nextStatus,
                currentCustodianOrgId: nextCustodian,
                latestEventSeq: Math.max(batch.latestEventSeq, current.seq),
                latestEventHash:
                  current.seq >= batch.latestEventSeq
                    ? current.eventHash
                    : batch.latestEventHash,
                hasDiscrepancy: report.hasDiscrepancy,
                maxDiscrepancySeverity: report.maxSeverity,
                updatedAt: new Date(),
              })
              .where(eq(batches.id, batch.id));
          }

          await tx
            .update(chainJobs)
            .set({
              status: 'CONFIRMED',
              txHash: match.txHash,
              lastError: null,
              lockedAt: null,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(chainJobs.eventId, current.id));

          reconciledEventIds.push(current.id);
        });
      }

      if (reconciledEventIds.length > 0) {
        this.logger.info(
          { reconciledCount: reconciledEventIds.length, reconciledEventIds },
          'Chain reconciler confirmed unanchored events from contract logs',
        );
      }

      return {
        scannedLogs: rawLogs.length,
        reconciledEvents: reconciledEventIds.length,
        reconciledEventIds,
      };
    } finally {
      this.running = false;
    }
  }
}
