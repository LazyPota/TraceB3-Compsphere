import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { ChainClient } from '../chain/client.js';
import type { DatabaseClient } from '../db/index.js';
import type { StorageAdapter } from '../storage/adapter.js';

const ChainInfoResponseSchema = z.object({
  chainId: z.number().int().positive(),
  networkName: z.string(),
  ledgerAddress: z.string().nullable(),
  explorerBaseUrl: z.string().nullable(),
});

const ReadyCheckResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  timestamp: z.string(),
  checks: z.object({
    database: z.object({
      ok: z.boolean(),
      driver: z.string(),
      detail: z.string().optional(),
    }),
    storage: z.object({
      ok: z.boolean(),
      driver: z.string(),
      detail: z.string().optional(),
    }),
    chain: z.object({
      ok: z.boolean(),
      rpc: z.object({
        ok: z.boolean(),
        chainId: z.number().optional(),
        detail: z.string().optional(),
      }),
      contract: z.object({
        ok: z.boolean(),
        address: z.string().optional(),
        detail: z.string().optional(),
      }),
      relayer: z.object({
        ok: z.boolean(),
        address: z.string().optional(),
        balanceWei: z.string().optional(),
        balanceEth: z.string().optional(),
        detail: z.string().optional(),
      }),
    }),
  }),
});

const chainInfoRoute = createRoute({
  method: 'get',
  path: '/v1/chain/info',
  tags: ['System'],
  summary: 'Get active EVM chain configuration and deployed TraceB3Ledger address',
  responses: {
    200: {
      description: 'Active EVM network metadata',
      content: { 'application/json': { schema: ChainInfoResponseSchema } },
    },
  },
});

const readyzRoute = createRoute({
  method: 'get',
  path: '/readyz',
  tags: ['System'],
  summary: 'Full readiness check across DB, storage, RPC, contract bytecode, and relayer balance',
  responses: {
    200: {
      description: 'All dependencies are ready',
      content: { 'application/json': { schema: ReadyCheckResponseSchema } },
    },
    503: {
      description: 'One or more dependencies are not ready',
      content: { 'application/json': { schema: ReadyCheckResponseSchema } },
    },
  },
});

export function createSystemRouter(deps: {
  db: DatabaseClient;
  storage: StorageAdapter;
  chain: ChainClient;
}) {
  const router = new OpenAPIHono();

  return router
    .openapi(chainInfoRoute, (c) => {
      return c.json(
        {
          chainId: deps.chain.chainId,
          networkName: deps.chain.networkName,
          ledgerAddress: deps.chain.ledgerAddress ?? null,
          explorerBaseUrl: deps.chain.explorerBaseUrl,
        },
        200,
      );
    })
    .openapi(readyzRoute, async (c) => {
      const [database, storage, chain] = await Promise.all([
        deps.db.healthCheck(),
        deps.storage.healthCheck(),
        deps.chain.readinessCheck(),
      ]);

      const ready = database.ok && storage.ok && chain.ok;
      const payload = {
        status: ready ? ('ready' as const) : ('not_ready' as const),
        timestamp: new Date().toISOString(),
        checks: {
          database,
          storage,
          chain,
        },
      };

      return ready ? c.json(payload, 200) : c.json(payload, 503);
    });
}
