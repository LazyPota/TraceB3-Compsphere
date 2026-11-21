import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '@traceb3/core';
import { ERROR_MESSAGES, parseProblemResponse } from '@/lib/api';

describe('RFC 9457 error handling & API_ERROR_CODES coverage', () => {
  it('provides user-friendly messages for all 14 backend error codes', () => {
    for (const code of API_ERROR_CODES) {
      expect(ERROR_MESSAGES[code]).toBeTruthy();
      expect(typeof ERROR_MESSAGES[code]).toBe('string');
    }
  });

  it('parses problem+json responses into typed ApiProblemError instances', async () => {
    const res = new Response(
      JSON.stringify({
        type: 'https://traceb3.example/errors/BATCH_BUSY',
        title: 'Batch Busy',
        status: 409,
        code: 'BATCH_BUSY',
        detail: 'Batch already has a PENDING anchor transaction.',
        requestId: 'req-123',
      }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/problem+json' },
      },
    );

    const parsed = await parseProblemResponse(res);
    expect(parsed.status).toBe(409);
    expect(parsed.code).toBe('BATCH_BUSY');
    expect(parsed.requestId).toBe('req-123');
    expect(parsed.userMessage).toMatch(/already anchoring|retry/i);
  });

  it('falls back cleanly when response is non-JSON', async () => {
    const res = new Response('Bad Gateway', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    const parsed = await parseProblemResponse(res);
    expect(parsed.code).toBe('CHAIN_UNAVAILABLE');
    expect(parsed.status).toBe(503);
  });

  it('preserves specific FORBIDDEN_ROLE detail for unregistered wallets', async () => {
    const res = new Response(
      JSON.stringify({
        type: 'https://traceb3.example/errors/FORBIDDEN_ROLE',
        title: 'Forbidden',
        status: 403,
        code: 'FORBIDDEN_ROLE',
        detail: 'Wallet address is not registered in the TRACEB3 B2B directory',
      }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/problem+json' },
      },
    );

    const parsed = await parseProblemResponse(res);
    expect(parsed.code).toBe('FORBIDDEN_ROLE');
    expect(parsed.userMessage).toBe(
      'Wallet address is not registered in the TRACEB3 B2B directory',
    );
  });
});
