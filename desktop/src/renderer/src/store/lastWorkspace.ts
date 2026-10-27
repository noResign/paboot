/**
 * The workspace this *device* selected last, remembered per daemon identity so
 * reopening lands where the user left off. Device-local on purpose: two devices
 * may be working on different projects, and a daemon-global "last used" would
 * make them fight over it. `isDefault` stays the daemon-side fallback for
 * sessions created without a workspace; this is only an opening preference.
 */
const PREFIX = 'paboot.lastWorkspace.';

/** `serverId` survives address changes; the connection id is the fallback. */
export function lastWorkspaceIdentity(connectionId: string | null, serverId: string | null): string | null {
  return serverId ?? connectionId;
}

export function readLastWorkspace(identity: string | null): string | null {
  if (!identity) return null;
  try {
    return localStorage.getItem(PREFIX + identity);
  } catch {
    return null;
  }
}

export function writeLastWorkspace(identity: string | null, workspaceId: string): void {
  if (!identity) return;
  try {
    localStorage.setItem(PREFIX + identity, workspaceId);
  } catch {
    // Storage disabled/full: the in-memory choice still works for this run.
  }
}
