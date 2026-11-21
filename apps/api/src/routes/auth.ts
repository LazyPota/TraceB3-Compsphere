import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { ActorRoleSchema, OrgTypeSchema, ProblemDetailsSchema } from '@traceb3/core';
import type { ChainClient } from '../chain/client.js';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import { createRequireAuth, getAuthContext, type AuthEnv } from '../middleware/auth.js';
import { issueSiweNonce, verifySiweAndMintJwt } from '../services/auth.js';

const NonceResponseSchema = z.object({
  nonce: z.string(),
  domain: z.string(),
  chainId: z.number().int().positive(),
  expiresAt: z.string(),
});

const VerifyRequestSchema = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'Invalid hex signature'),
});

const MemberProfileSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  orgName: z.string(),
  orgType: OrgTypeSchema,
  onChainOrgId: z.string(),
  walletAddress: z.string(),
  displayName: z.string(),
  role: ActorRoleSchema,
});

const VerifyResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  member: MemberProfileSchema,
});

const MeResponseSchema = z.object({
  member: MemberProfileSchema,
});

const nonceRoute = createRoute({
  method: 'get',
  path: '/v1/auth/nonce',
  tags: ['Auth'],
  summary: 'Generate single-use SIWE nonce',
  responses: {
    200: {
      description: 'Fresh SIWE nonce bound to configured domain and chainId',
      content: { 'application/json': { schema: NonceResponseSchema } },
    },
  },
});

const verifyRoute = createRoute({
  method: 'post',
  path: '/v1/auth/verify',
  tags: ['Auth'],
  summary: 'Verify SIWE signature and issue JWT access token',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: VerifyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Authenticated member session with HS256 JWT',
      content: { 'application/json': { schema: VerifyResponseSchema } },
    },
    400: {
      description: 'Invalid SIWE payload or signature',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    401: {
      description: 'Expired or consumed nonce',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Unregistered or revoked member',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/v1/auth/me',
  tags: ['Auth'],
  summary: 'Get authenticated member profile',
  responses: {
    200: {
      description: 'Current authenticated member and organization',
      content: { 'application/json': { schema: MeResponseSchema } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

export function createAuthRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  chain: ChainClient;
}) {
  const router = new OpenAPIHono<AuthEnv & { Variables: { requestId?: string } }>();
  const requireAuth = createRequireAuth(deps.config, deps.db);

  router.openapi(nonceRoute, async (c) => {
    const result = await issueSiweNonce(deps.db, deps.config);
    return c.json(result, 200);
  });

  router.openapi(verifyRoute, async (c) => {
    const body = c.req.valid('json');
    const requestId =
      typeof c.get('requestId') === 'string' ? c.get('requestId') : undefined;
    const session = await verifySiweAndMintJwt(deps.db, deps.chain, deps.config, {
      message: body.message,
      signature: body.signature,
      requestId,
    });
    return c.json(session, 200);
  });

  router.use('/v1/auth/me', requireAuth);
  router.openapi(meRoute, async (c) => {
    const auth = getAuthContext(c);
    return c.json(
      {
        member: {
          id: auth.memberId,
          orgId: auth.orgId,
          orgName: auth.orgName,
          orgType: auth.orgType,
          onChainOrgId: auth.onChainOrgId,
          walletAddress: auth.address,
          displayName: auth.displayName,
          role: auth.role,
        },
      },
      200,
    );
  });

  return router;
}
