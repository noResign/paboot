import type { Db, EndRow, SessionRow, WorkspaceRow } from '../db/db.js';
import { workspaceContains } from '../workspaces/workspace-service.js';

export interface SessionEndsScope {
  workspace: WorkspaceRow | null;
  /** Active ends available to this session (workspace mount narrowed by session_ends). */
  ends: EndRow[];
  /** Main end for detailed context; always one of `ends` (or null). */
  primary: EndRow | null;
  session: SessionRow;
}

function workspaceOf(db: Db, session: SessionRow): WorkspaceRow | null {
  return session.workspace_id ? db.getWorkspace(session.workspace_id) ?? null : null;
}

/**
 * Ends a session may use. A workspace mount applies to every session; a
 * `session_ends` row narrows it (explicitly none = default, see replace endpoint).
 * Archived ends never enter the set.
 */
export function resolveSessionEnds(db: Db, session: SessionRow): EndRow[] {
  const workspace = workspaceOf(db, session);
  if (!workspace) return [];
  const active = db.listEnds(workspace.id).filter((end) => end.status === 'active');
  const narrowed = db
    .listSessionEnds(session.id)
    .filter((row) => row.role === 'active')
    .map((row) => row.end_id);
  if (narrowed.length === 0) return active;
  const allowed = new Set(narrowed);
  return active.filter((end) => allowed.has(end.id));
}

/**
 * Main end for detailed context. An explicit `session.end_id` is honored only
 * while it is still in the session's set — archiving stops it without falling
 * back to another end. Otherwise the longest matching end root picks it, then
 * the earliest active end.
 */
export function resolvePrimaryEnd(
  db: Db,
  session: SessionRow,
  ends: readonly EndRow[] = resolveSessionEnds(db, session),
): EndRow | null {
  if (session.end_id) {
    return ends.find((end) => end.id === session.end_id) ?? null;
  }
  let best: { end: EndRow; length: number } | null = null;
  for (const candidate of ends) {
    for (const root of db.listEndRoots(candidate.id)) {
      if (!workspaceContains(root, session.cwd)) continue;
      if (!best || root.length > best.length) best = { end: candidate, length: root.length };
    }
  }
  return best?.end ?? ends[0] ?? null;
}

/** Backwards-compatible name: the session's main end. */
export function resolveSessionEnd(db: Db, session: SessionRow): EndRow | null {
  return resolvePrimaryEnd(db, session);
}

/** Workspace + active ends + primary end for a session. */
export function resolveSessionEndsScope(db: Db, session: SessionRow): SessionEndsScope {
  const workspace = workspaceOf(db, session);
  const ends = resolveSessionEnds(db, session);
  return { workspace, ends, primary: resolvePrimaryEnd(db, session, ends), session };
}
