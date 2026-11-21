import type { AppContext } from '../app/context.js';
import type { AgentTaskRow, SessionRow, WorkspaceRow } from '../db/db.js';
import { ensureThread, getAgent, resolveSessionAgent } from './index.js';
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
  publish(sessionId: string, taskId: string, agentId: string, frame: SseFrame): void;
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

export async function runTask(
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
      sink,
      agent,
      thread,
    });
    ctx.db.updateTask(task.id, { runId: handle.runId });
    const outcome = await handle.done;

    if (outcome.status === 'succeeded') {
      // The run already appended the assistant text as a plain message; give it
      // attribution and a timeline position now that it is final.
      const messageId = commitAssistantMessage(ctx, session.id, task, agent.id);
      ctx.db.updateTask(task.id, { status: 'done', endedAt: Date.now(), messageId });
      return { taskId: task.id, agentId: agent.id, status: 'done', messageId, error: null };
    }

    const status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    ctx.db.updateTask(task.id, {
      status,
      endedAt: Date.now(),
      error: outcome.error ?? status,
    });
    return {
      taskId: task.id,
      agentId: agent.id,
      status,
      messageId: null,
      error: outcome.error ?? status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`task ${task.id} (${agent.name}) failed to start: ${message}`);
    ctx.db.updateTask(task.id, { status: 'failed', endedAt: Date.now(), error: message });
    return { taskId: task.id, agentId: agent.id, status: 'failed', messageId: null, error: message };
  }
}

/**
 * Attach the agent's final text to the timeline.
 *
 * `startSessionRun` wrote the assistant text as an unattributed message (it does
 * not know about tasks). Rather than duplicate it, this promotes that row: the
 * transcript stays one visible message per answer, while now carrying who said
 * it and where it sits on the timeline.
 */
function commitAssistantMessage(
  ctx: AppContext,
  sessionId: string,
  task: AgentTaskRow,
  agentId: string,
): number | null {
  const promoted = ctx.db.promoteLastAssistantMessage({
    sessionId,
    agentId,
    turnId: task.turn_id,
    taskId: task.id,
  });
  return promoted;
}

/** Read a frame's payload back into the event the client expects. */
export function roomFrame(sessionId: string, row: { room_seq: number; payload: string }): SseFrame & { roomSeq: number } {
  const event = JSON.parse(row.payload) as NormalizedEvent;
  return { runId: '', seq: row.room_seq, roomSeq: row.room_seq, event } as SseFrame & { roomSeq: number };
}
