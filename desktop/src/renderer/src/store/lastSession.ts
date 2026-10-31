/**
 * The session this device had open in a workspace, remembered per daemon +
 * workspace so switching hosts (or restarting) lands back where the user left
 * off. Device-local like `lastWorkspace`: two devices may be reading different
 * sessions on the same daemon.
 */
const PREFIX = 'paboot.lastSession.';

/** `serverId` survives address changes; the connection id is the fallback. */
export function lastSessionKey(identity: string | null, workspaceId: string | null): string | null {
  if (!identity || !workspaceId) return null;
  return `${identity}:${workspaceId}`;
}

export function readLastSession(key: string | null): string | null {
  if (!key) return null;
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

/** Passing `null` forgets the entry (deleted session, stale id). */
export function writeLastSession(key: string | null, sessionId: string | null): void {
  if (!key) return;
  try {
    if (sessionId) localStorage.setItem(PREFIX + key, sessionId);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage disabled/full: the in-memory selection still works for this run.
  }
}
