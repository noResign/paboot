import type { CapabilityBindingRow, Db, EndRow, SessionRow, WorkspaceRow } from '../db/db.js';
import { workspaceContains } from '../workspaces/workspace-service.js';
import { capabilityById, type CapabilityDescriptor } from './registry.js';

export interface ResolvedCapabilityBinding {
  descriptor: CapabilityDescriptor;
  scopeType: CapabilityBindingRow['scope_type'];
  scopeId: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CapabilityScope {
  workspace: WorkspaceRow | null;
  end: EndRow | null;
  session: SessionRow;
}

export interface SessionEndsScope {
  workspace: WorkspaceRow | null;
  /** Active ends available to this session (workspace mount narrowed by session_ends). */
  ends: EndRow[];
  /** Main end for detailed context; always one of `ends` (or null). */
  primary: EndRow | null;
  session: SessionRow;
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

/** Workspace + primary end for a session. */
export function resolveCapabilityScope(db: Db, session: SessionRow): CapabilityScope {
  return { workspace: workspaceOf(db, session), end: resolvePrimaryEnd(db, session), session };
}

export function resolveSessionEndsScope(db: Db, session: SessionRow): SessionEndsScope {
  const workspace = workspaceOf(db, session);
  const ends = resolveSessionEnds(db, session);
  return { workspace, ends, primary: resolvePrimaryEnd(db, session, ends), session };
}

/** Nearest scope wins per provider for one specific end: session > end > workspace. */
export function resolveCapabilityBindingsForEnd(
  db: Db,
  session: SessionRow,
  end: EndRow,
  workspace: WorkspaceRow | null = workspaceOf(db, session),
): ResolvedCapabilityBinding[] {
  const layers: Array<{ type: CapabilityBindingRow['scope_type']; id: string }> = [
    { type: 'session', id: session.id },
    { type: 'end', id: end.id },
  ];
  if (workspace) layers.push({ type: 'workspace', id: workspace.id });

  const chosen = new Map<string, ResolvedCapabilityBinding>();
  for (const layer of layers) {
    for (const row of db.listCapabilityBindings(layer.type, layer.id)) {
      if (chosen.has(row.provider_id)) continue;
      const descriptor = capabilityById(row.provider_id);
      if (!descriptor) continue;
      chosen.set(row.provider_id, {
        descriptor,
        scopeType: layer.type,
        scopeId: layer.id,
        enabled: row.enabled === 1,
        config: parseConfig(row.config_json),
      });
    }
  }
  return [...chosen.values()];
}

/** Nearest scope wins per provider for the primary end (legacy shape). */
export function resolveCapabilityBindings(
  db: Db,
  session: SessionRow,
): ResolvedCapabilityBinding[] {
  const { workspace, primary } = resolveSessionEndsScope(db, session);
  if (!primary) {
    // Workspace-scope capabilities still apply without an end.
    const layers: Array<{ type: CapabilityBindingRow['scope_type']; id: string }> = [
      { type: 'session', id: session.id },
    ];
    if (workspace) layers.push({ type: 'workspace', id: workspace.id });
    const chosen = new Map<string, ResolvedCapabilityBinding>();
    for (const layer of layers) {
      for (const row of db.listCapabilityBindings(layer.type, layer.id)) {
        if (chosen.has(row.provider_id)) continue;
        const descriptor = capabilityById(row.provider_id);
        if (!descriptor) continue;
        chosen.set(row.provider_id, {
          descriptor,
          scopeType: layer.type,
          scopeId: layer.id,
          enabled: row.enabled === 1,
          config: parseConfig(row.config_json),
        });
      }
    }
    return [...chosen.values()];
  }
  return resolveCapabilityBindingsForEnd(db, session, primary, workspace);
}

/**
 * Pick the end instance a capability tool should target. Candidates are ends
 * in the session's set whose kind the capability supports and on which the
 * capability is enabled (session binding overrides the end binding).
 */
export function resolveCapabilityTargetEnd(
  db: Db,
  session: SessionRow,
  providerId: string,
  requested: unknown,
): { end?: EndRow; code?: 'end_ambiguous' | 'end_not_allowed' | 'end_missing' } {
  const descriptor = capabilityById(providerId);
  if (!descriptor) return { code: 'end_missing' };
  const { ends } = resolveSessionEndsScope(db, session);
  const sessionRow = db
    .listCapabilityBindings('session', session.id)
    .find((row) => row.provider_id === providerId);
  const candidates = ends.filter((end) => {
    if (descriptor.domains && !descriptor.domains.includes(end.kind)) return false;
    if (sessionRow) return sessionRow.enabled === 1;
    const endRow = db
      .listCapabilityBindings('end', end.id)
      .find((row) => row.provider_id === providerId);
    return endRow?.enabled === 1;
  });

  if (typeof requested === 'string' && requested !== '') {
    const end = candidates.find((candidate) => candidate.id === requested);
    return end ? { end } : { code: 'end_not_allowed' };
  }
  if (session.end_id) {
    const explicit = candidates.find((candidate) => candidate.id === session.end_id);
    if (explicit) return { end: explicit };
  }
  let best: { end: EndRow; length: number } | null = null;
  for (const candidate of candidates) {
    for (const root of db.listEndRoots(candidate.id)) {
      if (!workspaceContains(root, session.cwd)) continue;
      if (!best || root.length > best.length) best = { end: candidate, length: root.length };
    }
  }
  if (best) return { end: best.end };
  if (candidates.length === 1) return { end: candidates[0] };
  if (candidates.length === 0) return { code: 'end_missing' };
  return { code: 'end_ambiguous' };
}

/** MCP servers a run should mount: union across every end in the session's set. */
export function enabledCapabilityServers(db: Db, session: SessionRow): Set<string> {
  const { workspace, ends } = resolveSessionEndsScope(db, session);
  if (!workspace) return new Set();
  const family = workspace.family === 'life' ? 'life' : 'dev';
  const sessionRows = new Map(
    db.listCapabilityBindings('session', session.id).map((row) => [row.provider_id, row]),
  );
  const workspaceRows = new Map(
    db.listCapabilityBindings('workspace', workspace.id).map((row) => [row.provider_id, row]),
  );
  const endRows = new Map<string, Map<string, CapabilityBindingRow>>(
    ends.map((end) => [
      end.id,
      new Map(db.listCapabilityBindings('end', end.id).map((row) => [row.provider_id, row])),
    ]),
  );
  const providerIds = new Set<string>([
    ...sessionRows.keys(),
    ...workspaceRows.keys(),
    ...[...endRows.values()].flatMap((rows) => [...rows.keys()]),
  ]);

  const servers = new Set<string>();
  for (const providerId of providerIds) {
    const descriptor = capabilityById(providerId);
    if (!descriptor || !descriptor.families.includes(family)) continue;
    if (descriptor.scope === 'end' && ends.length === 0) continue;

    const override = sessionRows.get(providerId);
    if (override) {
      if (override.enabled === 1) servers.add(descriptor.server);
      continue;
    }
    if (descriptor.scope === 'end') {
      // Nearest scope is per end: an end-level row beats the workspace row.
      const enabledOnAnyEnd = ends.some((end) => {
        const row = endRows.get(end.id)?.get(providerId) ?? workspaceRows.get(providerId);
        return row?.enabled === 1;
      });
      if (enabledOnAnyEnd) servers.add(descriptor.server);
      continue;
    }
    if (workspaceRows.get(providerId)?.enabled === 1) servers.add(descriptor.server);
  }
  return servers;
}
