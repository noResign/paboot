import type { AppContext } from '../app/context.js';
import type { AgentTaskRow, SessionRow, WorkspaceRow } from '../db/db.js';
import { buildRoomProjection, ensureThread, getAgent, resolveSessionAgent } from './index.js';
import { backendFor } from './resolve.js';
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

/** Read a frame's payload back into the event the client expects. */
export function roomFrame(sessionId: string, row: { room_seq: number; payload: string }): SseFrame & { roomSeq: number } {
  const event = JSON.parse(row.payload) as NormalizedEvent;
  return { runId: '', seq: row.room_seq, roomSeq: row.room_seq, event } as SseFrame & { roomSeq: number };
}
