import { randomUUID } from 'node:crypto';
import type { AppContext } from '../app/context.js';
import type { AgentTaskRow, SessionRow, WorkspaceRow } from '../db/db.js';
import {
  buildRoomProjection,
  buildRoomSystem,
  ensureThread,
  findMentionedAgents,
  getAgent,
  getLeader,
  listSessionAgents,
  resolveSessionAgent,
} from './index.js';
import { backendFor } from './resolve.js';
import type { Agent } from './types.js';
import { startSessionRun, type RunSink } from '../runs/run-service.js';
import { log } from '../platform/log.js';
import type { NormalizedEvent, SseFrame } from '../types/api.js';

/**
 * Runs one `agent_tasks` row to completion.
 *
 * This is where the room's concurrency actually happens: every task owns one
 * run, runs start independently, and nothing waits for a sibling. The turn is
 * not a barrier — the only coordination is the commit step, which is what gives
 * the timeline its order.
 *
 * Three rules this file exists to keep:
 *   1. **The user's message is already committed** before any task runs, so an
 *      agent always sees what was asked.
 *   2. **A task's content is committed, not streamed.** Streaming text lives in
 *      `events`; only the final text becomes a `messages` row. Committing early
 *      would put a half-written answer on the timeline at a position it later
 *      has to move from.
 *   3. **A failure does not cancel siblings.** One agent failing is a fact about
 *      that agent, not a verdict on the turn.
 */

export interface TaskRunnerDeps {
  /** Publish one room-multiplexed frame to every subscriber of the session. */
  publish(sessionId: string, taskId: string | null, agentId: string | null, frame: SseFrame): void;
}

export interface TaskOutcome {
  taskId: string;
  agentId: string;
  status: 'done' | 'failed' | 'cancelled';
  messageId: number | null;
  error: string | null;
}

/** Start every task of a turn; resolves when all of them reach a terminal state. */
export async function runTurn(
  ctx: AppContext,
  deps: TaskRunnerDeps,
  input: { session: SessionRow; workspace: WorkspaceRow; tasks: AgentTaskRow[] },
): Promise<TaskOutcome[]> {
  // Started together on purpose: two agents answering one question should take
  // about as long as the slower one, not the sum of both.
  return Promise.all(
    input.tasks.map((task) => runTask(ctx, deps, { session: input.session, workspace: input.workspace, task })),
  );
}

/**
 * Per-agent run queue.
 *
 * A turn may run several agents at once, but one agent must never have two runs
 * alive: both would resume the same provider conversation and interleave their
 * answers into one transcript. Two turns (double-send, two devices) must queue
 * rather than race. Runs for *different* agents still start together.
 */
const agentQueues = new Map<string, Promise<unknown>>();

function serializeByAgent<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = agentQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  agentQueues.set(key, tail);
  void tail.then(() => {
    if (agentQueues.get(key) === tail) agentQueues.delete(key);
  });
  return run;
}

export function runTask(
  ctx: AppContext,
  deps: TaskRunnerDeps,
  input: { session: SessionRow; workspace: WorkspaceRow; task: AgentTaskRow },
): Promise<TaskOutcome> {
  return serializeByAgent(`${input.session.id}:${input.task.agent_id}`, () =>
    runTaskOnce(ctx, deps, input),
  );
}

async function runTaskOnce(
  ctx: AppContext,
  deps: TaskRunnerDeps,
  input: { session: SessionRow; workspace: WorkspaceRow; task: AgentTaskRow },
): Promise<TaskOutcome> {
  const { session, workspace, task } = input;
  const agent = getAgent(ctx.db, task.agent_id);
  if (!agent) {
    ctx.db.updateTask(task.id, { status: 'failed', error: 'agent not found', endedAt: Date.now() });
    return { taskId: task.id, agentId: task.agent_id, status: 'failed', messageId: null, error: 'agent not found' };
  }

  const resolved = resolveSessionAgent(ctx.db, session, workspace);
  const thread = resolved?.agent.id === agent.id ? resolved.thread : ensureThread(ctx.db, session, agent, workspace);
  const driver = ctx.registry.driver(backendFor(agent));
  if (!driver || driver.internal) {
    const error = `runtime not available: ${backendFor(agent)}`;
    ctx.db.updateTask(task.id, { status: 'failed', error, endedAt: Date.now() });
    return { taskId: task.id, agentId: agent.id, status: 'failed', messageId: null, error };
  }

  ctx.db.updateTask(task.id, { status: 'running', startedAt: Date.now() });

  // One sink per task: the run's frames go out on the room stream tagged with the
  // agent that produced them, so clients can label the card without a lookup.
  const sink: RunSink = {
    frame(frame) {
      deps.publish(session.id, task.id, agent.id, frame);
    },
  };

  // What the rest of the room said before this task's snapshot. Own messages
  // are excluded, so nothing here duplicates this agent's own thread.
  const roomContext = buildRoomProjection(ctx.db, {
    sessionId: session.id,
    sessionTitle: session.title,
    agentId: agent.id,
    snapshotSeq: task.snapshot_seq ?? 0,
    sinceSeq: thread.lastSeenSeq,
  });
  // The stable half (who is here) goes with the other cacheable context.
  const roomSystem = buildRoomSystem(ctx.db, { sessionId: session.id, selfAgentId: agent.id });

  try {
    const handle = startSessionRun(ctx, {
      session,
      workspace,
      prompt: task.prompt,
      driver,
      permissionMode: session.permission_mode as never,
      model: null,
      modelParameters: null,
      trigger: 'user',
      // The turn already committed the user's message before any task started.
      skipUserMessage: true,
      turnId: task.turn_id,
      agentTaskId: task.id,
      roomContext: roomContext ?? undefined,
      roomSystem: roomSystem ?? undefined,
      sink,
      agent,
      thread,
    });
    ctx.db.updateTask(task.id, { runId: handle.runId });
    // The projection is in this run's prompt; the next task for this agent only
    // needs what was committed after this point.
    ctx.db.setAgentThreadSeenSeq(thread.id, task.snapshot_seq ?? 0);
    const outcome = await handle.done;
    const messageId = outcome.messageId ?? null;

    if (outcome.status === 'succeeded') {
      ctx.db.updateTask(task.id, { status: 'done', endedAt: Date.now(), messageId });
      summonSupplements(ctx, deps, {
        session,
        workspace,
        task,
        agent,
        replyText: outcome.replyText ?? '',
      });
      return { taskId: task.id, agentId: agent.id, status: 'done', messageId, error: null };
    }

    const status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    ctx.db.updateTask(task.id, {
      status,
      endedAt: Date.now(),
      messageId,
      error: outcome.error ?? status,
    });
    return {
      taskId: task.id,
      agentId: agent.id,
      status,
      messageId,
      error: outcome.error ?? status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`task ${task.id} (${agent.name}) failed to start: ${message}`);
    ctx.db.updateTask(task.id, { status: 'failed', endedAt: Date.now(), error: message });
    return { taskId: task.id, agentId: agent.id, status: 'failed', messageId: null, error: message };
  }
}

/** One leader turn may summon at most this many supplements (11-router §B4). */
export const MAX_SUMMONS = 3;

/**
 * Turn the leader's `@name`s into supplement tasks.
 *
 * Only the leader may summon, and only when it answered as the default speaker
 * (`leader_default`): a user who explicitly @'d someone chose the responders
 * themselves. A summoned agent's own `@`s never reach this function because its
 * task source is `summon`, which is what bounds the depth at one.
 *
 * The leader does not wait: these tasks start after its run has already
 * committed its answer, and their completion closes the turn.
 */
function summonSupplements(
  ctx: AppContext,
  deps: TaskRunnerDeps,
  input: {
    session: SessionRow;
    workspace: WorkspaceRow;
    task: AgentTaskRow;
    agent: Agent;
    replyText: string;
  },
): void {
  const text = input.replyText.trim();
  if (!text || input.task.source !== 'leader_default') return;
  const leader = getLeader(ctx.db, input.session.id);
  if (!leader || leader.id !== input.agent.id) return;
  if (!ctx.db.getSession(input.session.id)) return;

  // Nobody who is already answering this turn, and nobody who cannot run.
  const already = new Set(
    ctx.db.listTasksByTurn(input.task.turn_id).map((task) => task.agent_id),
  );
  const members = listSessionAgents(ctx.db, input.session.id)
    .map((row) => row.agent)
    .filter(
      (member) =>
        member.id !== input.agent.id && !already.has(member.id) && canRunAgent(ctx, member),
    );
  const chosen = findMentionedAgents(text, members).slice(0, MAX_SUMMONS);
  if (chosen.length === 0) return;

  // Created after the leader's answer is committed, so the supplement's
  // projection includes it (invariant I25).
  const snapshotSeq = ctx.db.maxCommittedSeq(input.session.id);
  const now = Date.now();
  const summons: AgentTaskRow[] = [];
  for (const target of chosen) {
    const id = `task_${randomUUID()}`;
    ctx.db.createTask({
      id,
      sessionId: input.session.id,
      turnId: input.task.turn_id,
      agentId: target.id,
      source: 'summon',
      parentTaskId: input.task.id,
      prompt: text,
      needsWrite: !target.readOnly,
      snapshotSeq,
      now,
    });
    const created = ctx.db.getTask(id);
    if (created) summons.push(created);
  }
  if (summons.length === 0) return;

  log.info(
    `turn ${input.task.turn_id}: ${input.agent.name} summoned ${summons.map((task) => task.agent_id).join(', ')}`,
  );
  for (const summon of summons) {
    void runTask(ctx, deps, { session: input.session, workspace: input.workspace, task: summon })
      .then(() => {
        ctx.db.finishTurnIfSettled(summon.turn_id, Date.now());
      })
      .catch((error) => {
        log.warn(`summon task ${summon.id} crashed`, error);
        ctx.db.finishTurnIfSettled(summon.turn_id, Date.now());
      });
  }
}

/** Whether a member can actually take a run right now (same rule routing uses). */
function canRunAgent(ctx: AppContext, agent: Agent): boolean {
  if (!agent.enabled || agent.kind === 'peer') return false;
  const backend = backendFor(agent);
  const driver = ctx.registry.driver(backend);
  if (!driver || driver.internal) return false;
  const detection = ctx.registry.detection(backend);
  return detection ? detection.available !== false : true;
}

/** Read a frame's payload back into the event the client expects. */
export function roomFrame(sessionId: string, row: { room_seq: number; payload: string }): SseFrame & { roomSeq: number } {
  const event = JSON.parse(row.payload) as NormalizedEvent;
  return { runId: '', seq: row.room_seq, roomSeq: row.room_seq, event } as SseFrame & { roomSeq: number };
}
