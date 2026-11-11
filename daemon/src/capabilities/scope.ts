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

/**
 * Resolve the session's effective (main) end from server-side state only.
 * A session's explicit `end_id` is honored only while that end is active —
 * archiving must stop injection immediately, without falling back to another
 * end. Otherwise the longest matching `end_roots` prefix picks the main end,
 * and a workspace with an active end always resolves one, so a client-supplied
 * id is never trusted.
 */
export function resolveSessionEnd(db: Db, session: SessionRow): EndRow | null {
  if (session.end_id) {
    const explicit = db.getEnd(session.end_id);
    return explicit?.status === 'active' ? explicit : null;
  }
  const workspace = session.workspace_id ? db.getWorkspace(session.workspace_id) ?? null : null;
  if (!workspace) return null;
  let best: { end: EndRow; length: number } | null = null;
  let firstActive: EndRow | null = null;
  for (const candidate of db.listEnds(workspace.id)) {
    if (candidate.status !== 'active') continue;
    firstActive ??= candidate;
    for (const root of db.listEndRoots(candidate.id)) {
      if (!workspaceContains(root, session.cwd)) continue;
      if (!best || root.length > best.length) best = { end: candidate, length: root.length };
    }
  }
  // A workspace-level mount applies to every session in it; the cwd only
  // disambiguates which end is the main one when several are mounted.
  return best?.end ?? firstActive;
}

/** Workspace + effective end for a session. */
export function resolveCapabilityScope(db: Db, session: SessionRow): CapabilityScope {
  const workspace = session.workspace_id ? db.getWorkspace(session.workspace_id) ?? null : null;
  return { workspace, end: resolveSessionEnd(db, session), session };
}

/** Nearest scope wins per provider: session > end > workspace. */
export function resolveCapabilityBindings(
  db: Db,
  session: SessionRow,
): ResolvedCapabilityBinding[] {
  const { workspace, end } = resolveCapabilityScope(db, session);
  const layers: Array<{ type: CapabilityBindingRow['scope_type']; id: string }> = [
    { type: 'session', id: session.id },
  ];
  if (end) layers.push({ type: 'end', id: end.id });
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

/** MCP servers a run should mount based on enabled, family-compatible bindings. */
export function enabledCapabilityServers(db: Db, session: SessionRow): Set<string> {
  const { workspace, end } = resolveCapabilityScope(db, session);
  if (!workspace) return new Set();
  const family = workspace.family === 'life' ? 'life' : 'dev';
  const servers = new Set<string>();
  for (const binding of resolveCapabilityBindings(db, session)) {
    if (!binding.enabled) continue;
    if (!binding.descriptor.families.includes(family)) continue;
    if (binding.descriptor.scope === 'end' && !end) continue;
    servers.add(binding.descriptor.server);
  }
  return servers;
}
