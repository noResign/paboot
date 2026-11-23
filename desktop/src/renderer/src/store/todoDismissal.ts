/**
 * Which todo list the user put away, remembered across restarts.
 *
 * Device-local like `lastWorkspace` and `lastSession`: a phone and a desktop
 * reading the same session have different screen space, so "I hid that strip"
 * is a statement about this device, not about the session.
 *
 * Keyed by session id (the daemon's uuid) rather than by connection: the
 * connection id is `host:port`, and reaching the same daemon over a tunnel or a
 * different port must not resurrect a strip the user already dismissed.
 */
const PREFIX = 'paboot.todoDismissed.';

export function readTodoDismissal(sessionId: string | null): string | null {
  if (!sessionId) return null;
  try {
    return localStorage.getItem(PREFIX + sessionId);
  } catch {
    return null;
  }
}

/**
 * Remember (or forget, with `null`) the list the user put away.
 *
 * The value is the list's signature — its items, not their statuses — so a
 * later render can answer "is this still the list they hid?" without keeping a
 * second copy of the rules here.
 */
export function writeTodoDismissal(sessionId: string | null, signature: string | null): void {
  if (!sessionId) return;
  try {
    if (signature === null) localStorage.removeItem(PREFIX + sessionId);
    else localStorage.setItem(PREFIX + sessionId, signature);
  } catch {
    // Storage disabled/full: the in-memory dismissal still works for this run.
  }
}
