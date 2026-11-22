import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { SseFrame } from '../types/api.js';
import {
  AgentValidationError,
  createTurn,
  listAgents,
  MAX_MENTIONS,
  runTurn,
  type Agent,
  type TaskRunnerDeps,
} from '../agents/index.js';
import { normalizeAttachmentIds } from '../attachments/request.js';
import { log } from '../platform/log.js';
import { getActiveRun } from '../runtimes/active-runs.js';
import { sseHeaders, writeSseFrame } from '../http/sse.js';

/**
 * Whether each workspace agent can receive images, with a user-facing reason
 * when it cannot. Builtin is accepted here because its model-level check runs
 * in the driver; runtime agents need an explicit `imageInput` capability.
 */
async function imageSupportByAgent(
  ctx: AppContext,
  workspaceId: string,
): Promise<Map<string, string | null>> {
  const agents = listAgents(ctx.db, workspaceId);
  const entries = await Promise.all(
    agents.map(async (agent): Promise<[string, string | null]> => {
      if (agent.kind === 'builtin') return [agent.id, null];
      if (agent.kind === 'peer') return [agent.id, 'peer agents do not receive images yet'];
      const runtime = agent.runtime ?? '';
      if (!runtime) return [agent.id, 'the agent has no runtime'];
      let detection = ctx.registry.detection(runtime);
      if (!detection) {
        try {
          detection = await ctx.registry.detect(runtime, process.env);
        } catch {
          detection = undefined;
        }
      }
      if (!detection?.available) return [agent.id, `runtime ${runtime} is not available`];
      if (detection.capabilities?.imageInput !== true) {
        return [agent.id, `runtime ${runtime} does not support image input`];
      }
      return [agent.id, null];
    }),
  );
  return new Map(entries);
}

/**
 * Room stream: one SSE connection per session, carrying every agent's frames.
 *
 * Why multiplex instead of one stream per run: a room can have several runs
 * alive at once, and a phone that reconnects should not have to rediscover which
 * ones to attach to. A single `roomSeq` cursor answers "where was I" for all of
 * them, and a frame carries the agent that produced it so the card can be
 * labelled without a lookup.
 *
 * Cursor semantics:
 *   - `after` absent  → live only (a fresh open does not replay history; the
 *     timeline endpoint already gives the committed past)
 *   - `after=N`       → replay frames > N, then go live
 */

interface Subscriber {
  sessionId: string;
  write(frame: RoomFrame): void;
  close(): void;
}

export interface RoomFrame extends SseFrame {
  /** Session-wide frame position; the client's resume cursor. */
  roomSeq: number;
  /** Which task produced this frame (null for session-level notices). */
  taskId: string | null;
  /** Which agent produced it; null for frames that are not an agent's. */
  agentId: string | null;
}

/** In-process fan-out. Nothing here is persisted; `events` already is. */
const subscribers = new Map<string, Set<Subscriber>>();

/** Rows per replay query; the route loops until it catches up. */
const REPLAY_PAGE = 500;

/** Close every room listener for a session that is being deleted. */
export function closeSessionRoomStreams(sessionId: string): void {
  for (const subscriber of subscribers.get(sessionId) ?? []) subscriber.close();
  subscribers.delete(sessionId);
}

function broadcast(ctx: AppContext, sessionId: string, frame: Omit<RoomFrame, 'roomSeq'>): void {
  const roomSeq = ctx.db.nextRoomSeq(sessionId);
  try {
    // The run already persisted this frame for per-run replay; tag that row
    // instead of inserting a second copy (session notices have no row yet).
    ctx.db.appendRoomEvent(
      frame.runId || `room:${sessionId}`,
      frame.seq,
      frame.event.type,
      frame.event,
      sessionId,
      roomSeq,
    );
  } catch (err) {
    // A room frame that cannot be persisted still goes out live: replay is a
    // convenience, losing it must not stall the conversation.
    log.warn('failed to persist room frame', err);
  }
  const full: RoomFrame = { ...frame, roomSeq };
  for (const subscriber of subscribers.get(sessionId) ?? []) subscriber.write(full);
}

/**
 * Publish one run frame onto the room stream.
 *
 * Used by turns (with a task id) and by `/api/chat` (task id `null`): both
 * paths must be visible to a room subscriber, otherwise the same session would
 * have two different live views depending on who sent the message.
 */
export function roomPublisher(ctx: AppContext): TaskRunnerDeps['publish'] {
  return (sessionId, taskId, agentId, frame) => {
    broadcast(ctx, sessionId, { ...frame, taskId, agentId });
  };
}

export function registerRoomRoutes(app: Express, ctx: AppContext): void {
  /** Replay + live tail. `after` resumes; omit it for live-only. */
  app.get('/api/sessions/:id/stream', (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const rawAfter = req.query.after;
    const after = typeof rawAfter === 'string' && rawAfter !== '' ? Number(rawAfter) : null;
    if (after !== null && !Number.isFinite(after)) {
      res.status(400).json({ error: 'after must be a number', code: 'bad_request' });
      return;
    }

    res.writeHead(200, sseHeaders());
    res.write(': connected\n\n');

    const write = (frame: RoomFrame): void => {
      if (res.writableEnded) return;
      // The frame carries roomSeq; SSE's `seq` field is per-run, so it is not
      // reused here.
      writeSseFrame(res, frame as unknown as SseFrame);
    };

    // Replay first, then subscribe: replaying after subscribing could deliver a
    // live frame the client already sees in the backlog. The whole loop is
    // synchronous, so no frame can slip into the gap between the last page and
    // the subscription.
    //
    // Paging matters: a client that was away long enough to miss more than one
    // page would otherwise go live with a silent hole in its transcript.
    if (after !== null) {
      let cursor = after;
      for (;;) {
        const rows = ctx.db.listRoomEvents(session.id, cursor, REPLAY_PAGE);
        for (const row of rows) {
          cursor = row.room_seq;
          write({
            runId: row.run_id,
            seq: row.seq,
            roomSeq: row.room_seq,
            taskId: row.task_id,
            agentId: row.agent_id,
            event: JSON.parse(row.payload),
          });
        }
        if (rows.length < REPLAY_PAGE) break;
      }
    }

    const subscriber: Subscriber = {
      sessionId: session.id,
      write,
      close: () => res.end(),
    };
    const set = subscribers.get(session.id) ?? new Set<Subscriber>();
    subscribers.set(session.id, set);
    set.add(subscriber);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': keepalive\n\n');
    }, 15_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      set.delete(subscriber);
      if (set.size === 0) subscribers.delete(session.id);
      // The room keeps running; only this listener goes away.
      log.info(`room stream closed for ${session.id}; turns keep running`);
    });
  });

  /** Drop every subscriber of a session (tests, and daemon shutdown). */
  app.delete('/api/sessions/:id/stream', (req, res) => {
    for (const subscriber of subscribers.get(req.params.id!) ?? []) subscriber.close();
    subscribers.delete(req.params.id!);
    res.status(204).end();
  });

  /**
   * Stop every piece of work the room currently owns.
   *
   * A turn can have several runs alive at once, so cancelling one stream/run is
   * not the product action. Queued tasks that never acquired a run are marked
   * cancelled synchronously; active runs are cancelled and close their tasks
   * through their normal terminal path.
   */
  app.post('/api/sessions/:id/cancel', (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const now = Date.now();
    const touchedTurns = new Set<string>();
    let cancelled = 0;
    for (const task of ctx.db.listOpenTasks(session.id)) {
      touchedTurns.add(task.turn_id);
      if (task.status === 'queued' && !task.run_id) {
        ctx.db.updateTask(task.id, {
          status: 'cancelled',
          endedAt: now,
          error: 'cancelled by user',
        });
        cancelled += 1;
      }
    }
    for (const run of ctx.db.listRunningRuns()) {
      if (run.session_id !== session.id) continue;
      const active = getActiveRun(run.id);
      if (!active) continue;
      active.cancel('cancelled by user');
      cancelled += 1;
    }
    for (const turnId of touchedTurns) ctx.db.finishTurnIfSettled(turnId, now);
    res.json({ ok: true, cancelled });
  });

  /**
   * One user input, several agents.
   *
   * Returns 202 with the tasks it created: the answer arrives on the room
   * stream, not in this response. That is what makes the turn a batch rather
   * than a barrier — the client is free immediately and watches the room.
   */
  app.post('/api/sessions/:id/turns', async (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const workspace = session.workspace_id ? ctx.db.getWorkspace(session.workspace_id) : undefined;
    if (!workspace) {
      res.status(400).json({ error: 'session has no workspace', code: 'workspace_not_found' });
      return;
    }

    const body = (req.body ?? {}) as {
      prompt?: unknown;
      mentions?: unknown;
      commandId?: unknown;
      attachmentIds?: unknown;
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required', code: 'prompt_required' });
      return;
    }
    const mentionIds = Array.isArray(body.mentions)
      ? body.mentions.filter((id): id is string => typeof id === 'string')
      : [];
    if (mentionIds.length > MAX_MENTIONS) {
      res.status(400).json({
        error: `at most ${MAX_MENTIONS} agents may be addressed in one turn`,
        code: 'too_many_mentions',
      });
      return;
    }
    const commandId =
      typeof body.commandId === 'string' && body.commandId ? body.commandId : null;
    const attachmentIds = normalizeAttachmentIds(body.attachmentIds);
    if (attachmentIds === null) {
      res.status(400).json({
        error: 'attachmentIds must be an array of unique ids',
        code: 'bad_request',
      });
      return;
    }
    for (const id of attachmentIds) {
      const attachment = ctx.attachments.get(id);
      if (!attachment) {
        res.status(404).json({ error: `attachment not found: ${id}`, code: 'attachment_not_found' });
        return;
      }
      if (attachment.sessionId && attachment.sessionId !== session.id) {
        res.status(403).json({
          error: `attachment belongs to another session: ${id}`,
          code: 'attachment_forbidden',
        });
        return;
      }
      if (attachment.workspaceId && attachment.workspaceId !== workspace.id) {
        res.status(403).json({
          error: `attachment belongs to another workspace: ${id}`,
          code: 'attachment_forbidden',
        });
        return;
      }
    }
    const imageSupport =
      attachmentIds.length > 0 ? await imageSupportByAgent(ctx, workspace.id) : null;

    let created;
    try {
      created = createTurn(ctx.db, {
        session,
        workspace,
        prompt,
        mentionIds,
        commandId,
        attachmentIds,
        ...(imageSupport
          ? {
              validateAttachmentTargets: (agents: readonly Agent[]) => {
                const rejected = agents
                  .map((agent) => ({
                    agent,
                    reason: imageSupport.has(agent.id)
                      ? imageSupport.get(agent.id)!
                      : 'image input is not available',
                  }))
                  .filter((entry) => entry.reason !== null);
                if (rejected.length === 0) return;
                throw new AgentValidationError(
                  'attachments_unsupported_agent',
                  rejected
                    .map((entry) => `${entry.agent.name}: ${entry.reason}`)
                    .join('; '),
                );
              },
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof AgentValidationError) {
        res.status(err.code === 'command_id_conflict' ? 409 : 400).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      throw err;
    }

    // Own the uploads as soon as the turn exists. The per-run bind below adds a
    // run id later; the session/workspace binding is the access-control fact
    // the attachment GET route relies on.
    for (const id of attachmentIds) {
      ctx.attachments.bind(id, { sessionId: session.id, workspaceId: workspace.id });
    }

    res.status(202).json({
      turnId: created.turn.id,
      /** What the user's message became on the timeline (already committed). */
      addressed: created.addressed,
      dropped: created.dropped,
      tasks: created.tasks.map((task) => ({
        id: task.id,
        agentId: task.agent_id,
        source: task.source,
        status: task.status,
      })),
    });

    // A retry re-attaches to the turn it already created; starting its tasks a
    // second time would run the same agent twice.
    if (created.replayed) return;

    // Fire and forget: the response is the acknowledgement, not the answer. A
    // failure here is per-task and reported on the room stream.
    void runTurn(ctx, { publish: roomPublisher(ctx) }, {
      session,
      workspace,
      tasks: created.tasks,
    })
      .then((outcomes) => {
        ctx.db.finishTurnIfSettled(created.turn.id, Date.now());
        const failed = outcomes.filter((outcome) => outcome.status === 'failed');
        if (failed.length > 0) {
          log.warn(`turn ${created.turn.id}: ${failed.length}/${outcomes.length} task(s) failed`);
        }
      })
      .catch((err) => {
        log.error(`turn ${created.turn.id} crashed`, err);
        ctx.db.finishTurnIfSettled(created.turn.id, Date.now());
      });
  });
}
