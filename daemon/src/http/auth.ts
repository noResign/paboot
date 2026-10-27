import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer-token gate for all `/api/*` routes except the health probe. The token
 * is a single shared secret (env `PABOOT_TOKEN` or the persisted file under
 * the data dir). This is the minimum viable remote-auth layer; a multi-user
 * deployment should replace it with OIDC/SSO + per-user tokens.
 */
export function requireAuth(token: string): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const provided = header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!provided || !safeEqual(provided, token)) {
      res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
      return;
    }
    next();
  };
}
