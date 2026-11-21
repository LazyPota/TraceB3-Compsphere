import { after } from 'next/server';
import { getEmbeddedApiRuntime } from '@/lib/server-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

  const runtimeInstance = await getEmbeddedApiRuntime();

  const forwardedRequest =
    request.method === 'GET' || request.method === 'HEAD'
      ? new Request(url, {
          method: request.method,
          headers: request.headers,
        })
      : await (async () => {
          const bodyBuffer = await request.arrayBuffer();
          return new Request(url, {
            method: request.method,
            headers: request.headers,
            body: bodyBuffer.byteLength > 0 ? bodyBuffer : undefined,
          });
        })();

  let response = await runtimeInstance.app.fetch(forwardedRequest);

  if (
    request.method === 'POST' &&
    /^\/v1\/intents\/[^/]+\/submit$/.test(url.pathname) &&
    response.status === 202
  ) {
    after(async () => {
      await runtimeInstance.relayer.triggerDrain();
      await runtimeInstance.relayer.waitForIdle();
    });
  } else if (
    request.method === 'GET' &&
    /^\/v1\/events\/[^/]+\/status$/.test(url.pathname) &&
    response.ok
  ) {
    const payload = (await response
      .clone()
      .json()
      .catch(() => null)) as { chainStatus?: string } | null;

    if (payload?.chainStatus === 'PENDING') {
      await runtimeInstance.relayer.triggerDrain().catch(() => undefined);
      response = await runtimeInstance.app.fetch(
        new Request(url, { method: 'GET', headers: request.headers }),
      );
    } else if (payload?.chainStatus === 'SUBMITTED') {
      await runtimeInstance.reconciler.reconcileOnce().catch(() => undefined);
      response = await runtimeInstance.app.fetch(
        new Request(url, { method: 'GET', headers: request.headers }),
      );
    }
  }

  return response;
}

export const GET = handleApiRequest;
export const POST = handleApiRequest;
export const PUT = handleApiRequest;
export const PATCH = handleApiRequest;
export const DELETE = handleApiRequest;
export const OPTIONS = handleApiRequest;
export const HEAD = handleApiRequest;
