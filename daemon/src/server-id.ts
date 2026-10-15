import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

/**
 * This daemon's stable identity, minted once and kept in the DB (the fixed
 * `~/.paboot` root) so it survives restarts.
 *
 * It answers "is this the same daemon?" — which an address cannot: `~/.paboot`
 * reached by `127.0.0.1` and by a LAN IP is one identity behind two addresses.
 * Published as `serverId` in `GET /api/health` and in
 * `<data-dir>/daemon_runtime.json`.
 */
export function resolveServerId(db: Db): string {
  const existing = db.getSetting('server_id');
  if (existing) return existing;
  const id = randomUUID();
  db.setSetting('server_id', id);
  return id;
}
