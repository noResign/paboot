import type { Db } from '../db/db.js';
import { getAgent, listSessionAgents } from './store.js';
import type { Agent } from './types.js';

/**
 * Room projection: what one agent is told about the rest of the room.
 *
 * Each agent keeps its own provider conversation, so nobody else's turns are in
 * it. This block is the counterweight: the committed room timeline up to the
 * task's snapshot, minus the agent's own messages, as a single user-role block
 * rebuilt for every run.
 *
 * Rules that matter (04-context-memory §3):
 *   - only committed messages, so an in-flight answer can never leak in;
 *   - never the agent's own words — those are already in its thread;
 *   - order is timeline order, so "上面那条" always means the same thing;
 *   - bounded: the newest few verbatim plus an explicit "N omitted" note, so
 *     the agent knows what it is missing instead of silently misremembering.
 */

/**
 * Room context budget. This is deliberately much larger than a single chat
 * message: a reviewer answer can be several thousand characters, and clipping
 * it in the middle makes the leader act on an incomplete review. The cap is a
 * safety bound, not a target.
 */
export const ROOM_CONTEXT_MAX_CHARS = 24_000;
/** Newest committed entries kept verbatim. */
export const ROOM_CONTEXT_RECENT = 6;
const REMOTE_SUFFIX = '（远端）';
const CLOSE = '</room-context>';

export interface RoomProjectionInput {
  sessionId: string;
  sessionTitle: string | null;
  agentId: string;
  /** Timeline position frozen when the task was created. */
  snapshotSeq: number;
  /** Timeline position this thread has already been shown. */
  sinceSeq: number;
}

export function buildRoomProjection(db: Db, input: RoomProjectionInput): string | null {
  if (input.snapshotSeq <= input.sinceSeq) return null;
  const rows = db.messagesForProjection(
    input.sessionId,
    input.sinceSeq,
    input.snapshotSeq,
    input.agentId,
  );
  if (rows.length === 0) return null;

  const names = speakerLabels(db, input.sessionId, input.agentId, rows);
  const entries = rows.map((row) => formatEntry(row, names)).filter((entry) => entry !== '');
  if (entries.length === 0) return null;

  // Keep whole recent messages whenever they fit. A long review must not be
  // clipped just because it is the newest, so the per-entry half-budget rule is
  // gone; only the total envelope is bounded.
  let chosen = entries.slice(-ROOM_CONTEXT_RECENT);
  let omitted = entries.length - chosen.length;

  const render = (): string =>
    [
      `<room-context session="${escapeAttr(sessionLabel(input.sessionTitle))}" since="${input.snapshotSeq}" omitted="${omitted}">`,
      ...chosen,
      ...(omitted > 0 ? [`（更早的 ${omitted} 条已省略，未逐条列出）`] : []),
      CLOSE,
    ].join('\n');

  // Prefer the newest entries: drop older ones until the envelope fits.
  while (chosen.length > 1 && render().length > ROOM_CONTEXT_MAX_CHARS) {
    chosen.shift();
    omitted += 1;
  }

  // A single message larger than the whole budget still has to be clipped, but
  // it keeps the maximum useful prefix instead of an arbitrary half budget.
  if (chosen.length === 1 && render().length > ROOM_CONTEXT_MAX_CHARS) {
    const measuredEnvelope = render().length - chosen[0]!.length;
    chosen[0] = clip(chosen[0]!, Math.max(1, ROOM_CONTEXT_MAX_CHARS - measuredEnvelope));
  }

  return render();
}

function speakerLabels(
  db: Db,
  sessionId: string,
  selfId: string,
  rows: readonly { agent_id: string | null }[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const row of listSessionAgents(db, sessionId)) {
    if (row.agent.id === selfId) continue;
    labels.set(row.agent.id, labelFor(row.agent));
  }
  // A speaker who left the room still said what they said; look them up so the
  // projection does not turn into `[已移除的助手]`.
  for (const row of rows) {
    if (!row.agent_id || labels.has(row.agent_id) || row.agent_id === selfId) continue;
    const agent = getAgent(db, row.agent_id);
    labels.set(row.agent_id, agent ? labelFor(agent) : '已移除的助手');
  }
  return labels;
}

/** `审阅` / `审阅（远端）`; `]` in a name would break the `[name]` prefix. */
function labelFor(agent: Agent): string {
  const name = agent.name.replace(/[[\]]/g, '）');
  return agent.kind === 'peer' ? `${name}${REMOTE_SUFFIX}` : name;
}

function formatEntry(
  row: { role: string; content: string; agent_id: string | null },
  labels: Map<string, string>,
): string {
  const content = row.content.trim();
  if (!content) return '';
  const label = row.agent_id ? (labels.get(row.agent_id) ?? '助手') : '用户';
  return `[${label}] ${content}`;
}

const CLIPPED_SUFFIX = '…（已截断）';

function clip(entry: string, limit: number): string {
  if (entry.length <= limit) return entry;
  return `${entry.slice(0, limit - CLIPPED_SUFFIX.length)}${CLIPPED_SUFFIX}`;
}

function sessionLabel(title: string | null): string {
  const trimmed = title?.trim();
  return trimmed ? `群聊：${trimmed}` : '群聊';
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '”');
}
