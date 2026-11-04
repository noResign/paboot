import { protocol } from 'electron';
import type { ConnectionManager } from './connection/manager';
import { MEDIA_SCHEME } from '../shared/media';
import { ROUTES } from '../shared/routes';

/**
 * Serve image/video bytes from the daemon under `paboot-media://`.
 *
 * The renderer only knows connection/workspace/root/path; main resolves the
 * client and injects the bearer token, so credentials never enter a URL the
 * renderer can read. `Range` is forwarded as-is, which is what lets `<video>`
 * seek (`206 Partial Content` from `/api/files/raw` passes straight through).
 */
export function installMediaProtocol(manager: ConnectionManager): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }
    const url = new URL(request.url);
    const connectionId = url.searchParams.get('connectionId');
    const workspaceId = url.searchParams.get('workspaceId');
    const path = url.searchParams.get('path');
    const root = url.searchParams.get('root');
    if (!connectionId || !workspaceId || !path) {
      return new Response('bad request', { status: 400 });
    }
    const client = manager.clientFor(connectionId);
    if (!client) return new Response('not connected', { status: 404 });

    const range = request.headers.get('Range');
    try {
      return await client.fetchRaw(
        ROUTES.fileRaw,
        { workspaceId, path, root: root ?? undefined },
        range ? { Range: range } : {},
        method,
      );
    } catch (err) {
      return new Response(err instanceof Error ? err.message : 'upstream error', { status: 502 });
    }
  });
}
