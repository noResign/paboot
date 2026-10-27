import type { RequestHandler } from 'express';

/**
 * Minimal CORS middleware. The daemon's real security boundary is the bearer
 * token, not the browser origin — this just lets a `file://`-served or
 * cross-origin test client reach `/api/*`. Any request carrying `Authorization`
 * triggers an OPTIONS preflight, which we answer directly with `204`.
 */
export function corsMiddleware(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
