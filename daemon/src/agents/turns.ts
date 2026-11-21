import { randomUUID } from 'node:crypto';
import type { AgentTaskRow, Db, SessionRow, TurnRow, WorkspaceRow } from '../db/db.js';
import { addToSession, AgentValidationError } from './service.js';
import { getAgent, getLeader, listSessionAgents } from './store.js';
import { parseMentionNames, mentionsAll, routeMentions, type MentionTarget } from './mentions.js';
import type { Agent } from './types.js';

/**
 * Turn orchestration: one user input becomes a turn plus one task per agent it
 * addresses.
 *
 * A turn is **not a barrier** (03-room.md §4.2). Creating it does not wait for
 * anything; the tasks under it start as soon as the scheduler can run them. The
 * turn exists only to group them for budget accounting.
 *
 * Deliberate ordering: the user's own message is written first, then the tasks.
 * If task creation fails halfway, the user still sees their message rather than
 * losing it into a rollback.
 */

export interface CreateTurnInput {
  session: SessionRow;
  workspace: WorkspaceRow;
  prompt: string;
  /** Agent ids the client resolved from its own mention chips. */
  mentionIds: readonly string[];
  /** Per-turn input-token ceiling; 0 = unlimited. */
  tokenLimit?: number;
}

export interface CreatedTurn {
  turn: TurnRow;
  tasks: AgentTaskRow[];
  /** The agents that will answer, in start order. */
  addressed: { agentId: string; name: string; source: string }[];
  /** Addressed agents that could not be used, with the reason. */
  dropped: { id: string; reason: string }[];
}

/**
 * Create a turn and its tasks.
 *
 * Throws `AgentValidationError` with `no_available_agent` when the message
 * addresses nobody usable — the caller turns that into a 4xx instead of
 * pretending the message was accepted.
 */
export function createTurn(db: Db, input: CreateTurnInput): CreatedTurn {
  const leader = getLeader(db, input.session.id);
  if (!leader) {
    throw new AgentValidationError('no_leader', 'this session has no agent to answer it');
  }
  let members = listSessionAgents(db, input.session.id).map((row) => row.agent);

  // Structured mentions win; free-text `@name` is the fallback for clients that
  // send plain text (or for someone typing in a raw field).
  const all = mentionsAll(input.prompt);
  const mentionIds =
    input.mentionIds.length > 0
      ? input.mentionIds
      : parseMentionNames(input.prompt, members).map(
          (name) => members.find((member) => member.name === name)?.id ?? name,
        );

  // `@` is a workspace-level picker: addressing an agent that is not in this
  // room yet is how a single-assistant session becomes a group. Admit it first,
  // under the same rules the roster endpoint enforces (same workspace, enabled,
  // and at most one writable member).
  const admission: { id: string; reason: string }[] = [];
  if (input.mentionIds.length > 0) {
    for (const id of input.mentionIds) {
      if (members.some((member) => member.id === id)) continue;
      const candidate = getAgent(db, id);
      if (!candidate) continue; // routeMentions reports it as unknown
      if (candidate.workspaceId !== input.session.workspace_id) {
        admission.push({ id, reason: 'cross_workspace' });
        continue;
      }
      if (!candidate.enabled) {
        admission.push({ id, reason: 'disabled' });
        continue;
      }
      if (candidate.kind === 'peer') {
        admission.push({ id, reason: 'unavailable' });
        continue;
      }
      try {
        assertWritableSlotFree(db, input.session.id, candidate);
        addToSession(
          db,
          { id: input.session.id, workspaceId: input.session.workspace_id },
          candidate.id,
        );
        members = listSessionAgents(db, input.session.id).map((row) => row.agent);
      } catch (error) {
        if (error instanceof AgentValidationError) admission.push({ id, reason: error.code });
        else throw error;
      }
    }
  }

  const routed = routeMentions({ mentionIds, all, leader, members });
  if (routed.targets.length === 0) {
    if (admission.some((entry) => entry.reason === 'writable_agent_exists')) {
      throw new AgentValidationError(
        'writable_agent_exists',
        'the addressed agent is writable and this room already has a writer',
      );
    }
    throw new AgentValidationError(
      'no_available_agent',
      routed.dropped.length > 0 ? 'the addressed agent is not available' : 'there is nobody to answer',
    );
  }
  const dropped = [
    ...admission,
    ...routed.dropped.filter((entry) => !admission.some((admitted) => admitted.id === entry.id)),
  ];

  // Messages committed *before* this turn are what a task may see. The snapshot
  // is taken before the user's message gets its position on purpose: that
  // message travels as the task's prompt, so putting it in the room projection
  // too would show every agent the question twice.
  //
  // Freezing it per turn (here, at creation) is what makes a run reproducible:
  // same snapshot + same prompt = same context, which prompt caching depends on.
  const snapshotSeq = db.maxCommittedSeq(input.session.id);

  // Raw text keeps the `@name` the user typed: replay shows what they wrote, and
  // mentions are request metadata, not part of the prompt (03-room.md B §9).
  //
  // Committed immediately (a task that cannot see the question it is answering
  // is worse than useless; it sees it as `prompt`) and given a timeline position.
  db.addCommittedMessage({
    sessionId: input.session.id,
    role: 'user',
    content: input.prompt,
    agentId: null,
    turnId: null,
    taskId: null,
  });
  db.touchSession(input.session.id);

  const now = Date.now();
  const turnId = `turn_${randomUUID()}`;
  db.createTurn({
    id: turnId,
    sessionId: input.session.id,
    prompt: input.prompt,
    tokenLimit: input.tokenLimit ?? 0,
    now,
  });

  const tasks: AgentTaskRow[] = [];
  for (const target of routed.targets) {
    const id = `task_${randomUUID()}`;
    db.createTask({
      id,
      sessionId: input.session.id,
      turnId,
      agentId: target.agent.id,
      source: target.source,
      prompt: input.prompt,
      needsWrite: !target.agent.readOnly,
      snapshotSeq,
      now,
    });
    const created = db.getTask(id);
    if (created) tasks.push(created);
  }

  return {
    turn: db.getTurn(turnId)!,
    tasks,
    addressed: tasks.map((task, index) => ({
      agentId: task.agent_id,
      name: routed.targets[index]?.agent.name ?? '',
      source: task.source,
    })),
    dropped,
  };
}

/**
 * The single-writable rule (03-room.md §5.2).
 *
 * Enforced when membership changes, not when a run starts: telling someone
 * "this room already has a writer" while they are editing is a save-time
 * answer, whereas failing a run they just triggered is a surprise.
 */
export function assertWritableSlotFree(db: Db, sessionId: string, agent: Agent): void {
  if (agent.readOnly) return;
  const members = listSessionAgents(db, sessionId).map((row) => row.agent);
  const otherWriter = members.find((member) => member.id !== agent.id && !member.readOnly);
  if (otherWriter) {
    throw new AgentValidationError(
      'writable_agent_exists',
      `this session already has a writable agent: ${otherWriter.name}`,
    );
  }
}

export type { MentionTarget };
