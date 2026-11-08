import type { Express, Request } from 'express';

/**
 * Process-level controls. `POST /api/system/shutdown` exists because Windows
 * has no SIGTERM: a desktop client that owns a local daemon cannot ask it to
 * run its shutdown path with a signal, so it makes an authenticated loopback
 * request instead.
 *
 * The route sits under `/api/system`, not `/api/internal`: the server token
 * (MCP servers) may call anything under `/internal`, and an agent-adjacent
 * process must never be able to stop the daemon. The role policy makes
 * non-GET routes operator-only.
 */
export interface SystemRouteHooks {
  requestShutdown?: (reason: string) => void;
}

function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function registerSystemRoutes(app: Express, hooks: SystemRouteHooks): void {
  app.post('/api/system/shutdown', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'shutdown is only available over loopback', code: 'loopback_only' });
      return;
    }
    if (!hooks.requestShutdown) {
      res.status(501).json({ error: 'shutdown is not wired in this process', code: 'unsupported' });
      return;
    }
    // Respond first: the daemon exits right after this, and the caller uses the
    // status (not a lost connection) to decide whether to fall back to a kill.
    res.status(202).json({ ok: true });
    setImmediate(() => hooks.requestShutdown?.('shutdown requested over HTTP'));
  });
}
