import {
  CHAIN_EXPLORER_BASE_URLS,
  getExplorerTxUrl,
  getLedgerAddress,
  TRACEB3_LEDGER_ABI,
} from '@traceb3/contracts';
import type { ApiErrorCode } from '@traceb3/core';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  formatEther,
  getAddress,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { AppConfig } from '../config.js';

export interface DecodedContractRevert {
  isRevert: boolean;
  errorName?: string;
  args?: readonly unknown[];
  code?: ApiErrorCode;
  message: string;
}

export interface ChainReadinessCheck {
  ok: boolean;
  rpc: { ok: boolean; chainId?: number; detail?: string };
  contract: { ok: boolean; address?: `0x${string}`; detail?: string };
  relayer: {
    ok: boolean;
    address?: `0x${string}`;
    balanceWei?: string;
    balanceEth?: string;
    detail?: string;
  };
}

export interface OnChainBatchHeader {
  exists: boolean;
  status: number;
  headHash: `0x${string}`;
  currentCustodianOrgId: `0x${string}`;
  eventCount: number;
}

export interface OnChainAnchoredEvent {
  seq: number;
  eventType: number;
  eventHash: `0x${string}`;
  prevHash: `0x${string}`;
  targetSeq: number;
  actor: `0x${string}`;
  orgId: `0x${string}`;
  timestamp: bigint;
}

export interface OnChainActorInfo {
  role: number;
  orgId: `0x${string}`;
  active: boolean;
}

const REVERT_ERROR_CODE_MAP: Record<string, ApiErrorCode> = {
  InvalidSignature: 'BAD_SIGNATURE',
  ECDSAInvalidSignature: 'BAD_SIGNATURE',
  IntentExpired: 'INTENT_EXPIRED',
  ActorNotActive: 'FORBIDDEN_ROLE',
  InvalidActorRole: 'FORBIDDEN_ROLE',
  OrganizationMismatch: 'FORBIDDEN_ROLE',
  UnauthorizedRegistrar: 'FORBIDDEN_ROLE',
  AccessControlUnauthorizedAccount: 'FORBIDDEN_ROLE',
  BatchNotFound: 'NOT_FOUND',
  InvalidBatchStatus: 'INVALID_TRANSITION',
  InvalidPrevHash: 'INVALID_TRANSITION',
  BatchAlreadyExists: 'INVALID_TRANSITION',
  SameOrganizationTransfer: 'INVALID_TRANSITION',
  CannotReviseRevision: 'INVALID_TRANSITION',
  InvalidTargetSeq: 'INVALID_TRANSITION',
  InvalidEventType: 'INVALID_TRANSITION',
};

function resolveChainName(chainId: number): string {
  if (chainId === 31337) return 'Hardhat Local';
  if (chainId === 84532) return 'Base Sepolia';
  if (chainId === 8453) return 'Base Mainnet';
  return `EVM Chain ${chainId}`;
}

function normalizePrivateKey(raw: string): `0x${string}` {
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
}

/**
 * Decodes viem/Solidity custom errors into stable TRACEB3 API error codes.
 */
export function decodeContractRevert(err: unknown): DecodedContractRevert {
  if (err instanceof BaseError) {
    const revertError = err.walk(
      (inner) => inner instanceof ContractFunctionRevertedError,
    );
    if (revertError instanceof ContractFunctionRevertedError) {
      const errorName = revertError.data?.errorName ?? 'ContractRevert';
      const args = revertError.data?.args;
      return {
        isRevert: true,
        errorName,
        args,
        code: REVERT_ERROR_CODE_MAP[errorName] ?? 'CHAIN_REVERT',
        message: revertError.shortMessage || revertError.message,
      };
    }

    const rawDataHolder = err.walk((inner) => {
      const candidate = inner as { data?: unknown };
      return typeof candidate?.data === 'string' && candidate.data.startsWith('0x');
    }) as { data?: string } | null;

    if (rawDataHolder?.data && rawDataHolder.data.length >= 10) {
      try {
        const decoded = decodeErrorResult({
          abi: TRACEB3_LEDGER_ABI,
          data: rawDataHolder.data as Hex,
        });
        return {
          isRevert: true,
          errorName: decoded.errorName,
          args: decoded.args,
          code: REVERT_ERROR_CODE_MAP[decoded.errorName] ?? 'CHAIN_REVERT',
          message: err.shortMessage || `Contract reverted with ${decoded.errorName}`,
        };
      } catch {
        // Not a known custom error selector
      }
    }

    return {
      isRevert: false,
      message: err.shortMessage || err.message,
    };
  }

  return {
    isRevert: false,
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Encapsulates viem PublicClient, optional relayer WalletClient, and TraceB3Ledger contract reads.
 */
export class ChainClient {
  readonly chainId: number;
  readonly networkName: string;
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly ledgerAddress?: `0x${string}`;
  readonly explorerBaseUrl: string | null;
  readonly relayerAccount?: PrivateKeyAccount;
  readonly relayerAddress?: `0x${string}`;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient?: WalletClient<Transport, Chain, PrivateKeyAccount>;

  constructor(config: Pick<AppConfig, 'CHAIN_ID' | 'CHAIN_RPC_URL' | 'LEDGER_ADDRESS' | 'RELAYER_PRIVATE_KEY'>) {
    this.chainId = config.CHAIN_ID;
    this.networkName = resolveChainName(config.CHAIN_ID);
    this.rpcUrl = config.CHAIN_RPC_URL;
    this.explorerBaseUrl = CHAIN_EXPLORER_BASE_URLS[config.CHAIN_ID] ?? null;

    this.chain = defineChain({
      id: config.CHAIN_ID,
      name: this.networkName,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: {
        default: { http: [config.CHAIN_RPC_URL] },
      },
    });

    const configuredOrExported =
      config.LEDGER_ADDRESS ?? getLedgerAddress(config.CHAIN_ID);
    this.ledgerAddress = configuredOrExported
      ? getAddress(configuredOrExported)
      : undefined;

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.CHAIN_RPC_URL, { timeout: 15_000 }),
    });

    if (config.RELAYER_PRIVATE_KEY) {
      const account = privateKeyToAccount(
        normalizePrivateKey(config.RELAYER_PRIVATE_KEY),
      );
      this.relayerAccount = account;
      this.relayerAddress = account.address;
      this.walletClient = createWalletClient({
        account,
        chain: this.chain,
        transport: http(config.CHAIN_RPC_URL, { timeout: 20_000 }),
      });
    }
  }

  getExplorerTxUrl(txHash: string): string | null {
    return getExplorerTxUrl(this.chainId, txHash);
  }

  requireLedgerAddress(): `0x${string}` {
    if (!this.ledgerAddress) {
      throw new Error(
        `LEDGER_ADDRESS is not configured for chainId ${this.chainId}`,
      );
    }
    return this.ledgerAddress;
  }

  async getActorNonce(wallet: `0x${string}`): Promise<bigint> {
    const address = this.requireLedgerAddress();
    return this.publicClient.readContract({
      address,
      abi: TRACEB3_LEDGER_ABI,
      functionName: 'nonces',
      args: [getAddress(wallet)],
    });
  }

  async getBatchHeader(onChainBatchId: `0x${string}`): Promise<OnChainBatchHeader> {
    const address = this.requireLedgerAddress();
    const res = await this.publicClient.readContract({
      address,
      abi: TRACEB3_LEDGER_ABI,
      functionName: 'getBatch',
      args: [onChainBatchId],
    });
    return {
      exists: res.exists,
      status: Number(res.status),
      headHash: res.headHash,
      currentCustodianOrgId: res.currentCustodianOrgId,
      eventCount: Number(res.eventCount),
    };
  }

  async getAnchoredEvent(
    onChainBatchId: `0x${string}`,
    seq: number,
  ): Promise<OnChainAnchoredEvent> {
    const address = this.requireLedgerAddress();
    const res = await this.publicClient.readContract({
      address,
      abi: TRACEB3_LEDGER_ABI,
      functionName: 'getEvent',
      args: [onChainBatchId, seq],
    });
    return {
      seq: Number(res.seq),
      eventType: Number(res.eventType),
      eventHash: res.eventHash,
      prevHash: res.prevHash,
      targetSeq: Number(res.targetSeq),
      actor: res.actor,
      orgId: res.orgId,
      timestamp: res.timestamp,
    };
  }

  async getEventCount(onChainBatchId: `0x${string}`): Promise<number> {
    const address = this.requireLedgerAddress();
    const count = await this.publicClient.readContract({
      address,
      abi: TRACEB3_LEDGER_ABI,
      functionName: 'eventCount',
      args: [onChainBatchId],
    });
    return Number(count);
  }

  async getActorInfo(wallet: `0x${string}`): Promise<OnChainActorInfo> {
    const address = this.requireLedgerAddress();
    const info = await this.publicClient.readContract({
      address,
      abi: TRACEB3_LEDGER_ABI,
      functionName: 'getActor',
      args: [getAddress(wallet)],
    });
    return {
      role: Number(info.role),
      orgId: info.orgId,
      active: info.active,
    };
  }

  async readinessCheck(): Promise<ChainReadinessCheck> {
    let rpc: ChainReadinessCheck['rpc'] = { ok: false };
    let contract: ChainReadinessCheck['contract'] = {
      ok: false,
      address: this.ledgerAddress,
    };
    let relayer: ChainReadinessCheck['relayer'] = {
      ok: false,
      address: this.relayerAddress,
    };

    try {
      const remoteChainId = await this.publicClient.getChainId();
      if (remoteChainId === this.chainId) {
        rpc = { ok: true, chainId: remoteChainId };
      } else {
        rpc = {
          ok: false,
          chainId: remoteChainId,
          detail: `RPC chainId ${remoteChainId} does not match configured CHAIN_ID ${this.chainId}`,
        };
      }
    } catch (err) {
      rpc = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (!this.ledgerAddress) {
      contract = {
        ok: false,
        detail: 'LEDGER_ADDRESS is not configured',
      };
    } else if (rpc.ok) {
      try {
        const bytecode = await this.publicClient.getCode({
          address: this.ledgerAddress,
        });
        if (bytecode && bytecode !== '0x') {
          contract = { ok: true, address: this.ledgerAddress };
        } else {
          contract = {
            ok: false,
            address: this.ledgerAddress,
            detail: 'No contract bytecode found at LEDGER_ADDRESS',
          };
        }
      } catch (err) {
        contract = {
          ok: false,
          address: this.ledgerAddress,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      contract = {
        ok: false,
        address: this.ledgerAddress,
        detail: 'Skipped contract bytecode check because RPC is unavailable',
      };
    }

    if (!this.relayerAddress) {
      relayer = {
        ok: false,
        detail: 'RELAYER_PRIVATE_KEY is not configured',
      };
    } else if (rpc.ok) {
      try {
        const balance = await this.publicClient.getBalance({
          address: this.relayerAddress,
        });
        relayer = {
          ok: balance > 0n,
          address: this.relayerAddress,
          balanceWei: balance.toString(10),
          balanceEth: formatEther(balance),
          ...(balance === 0n ? { detail: 'Relayer wallet has zero native gas balance' } : {}),
        };
      } catch (err) {
        relayer = {
          ok: false,
          address: this.relayerAddress,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      relayer = {
        ok: false,
        address: this.relayerAddress,
        detail: 'Skipped relayer balance check because RPC is unavailable',
      };
    }

    return {
      ok: rpc.ok && contract.ok && relayer.ok,
      rpc,
      contract,
      relayer,
    };
  }
}
