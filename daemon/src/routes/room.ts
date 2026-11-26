import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { SseFrame } from '../types/api.js';
import { log } from '../platform/log.js';
import { getActiveRun } from '../runtimes/active-runs.js';
import { asyncRoute } from '../http/async-route.js';
import { sseHeaders, writeSseFrame } from '../http/sse.js';
import {
  addRoomSubscriber,
  removeRoomSubscriber,
  REPLAY_PAGE,
  roomSubscribers,
  type RoomFrame,
  type Subscriber,
} from '../rooms/session-events.js';
import { dispatchTurn, parseTurnBody, TurnHttpError } from '../rooms/dispatch-turn.js';

// Re-exported for the routes that tear down a session's streams.
export { closeSessionRoomStreams } from '../rooms/session-events.js';
export { roomPublisher } from '../rooms/session-events.js';

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
    addRoomSubscriber(subscriber);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': keepalive\n\n');
    }, 15_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      removeRoomSubscriber(subscriber);
      // The room keeps running; only this listener goes away.
      log.info(`room stream closed for ${session.id}; turns keep running`);
    });
  });

  /** Drop every subscriber of a session (tests, and daemon shutdown). */
  app.delete('/api/sessions/:id/stream', (req, res) => {
    for (const subscriber of roomSubscribers(req.params.id!) ?? []) subscriber.close();
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
    // Pure read-only: the exposing side does not stop the visitor's run. The
    // guest cancels through its own `/peer/runs/:id/cancel`, and the contract's
    // wall clock reaps anything left behind.
    if (session.purpose === 'peer') {
      res.status(403).json({
        error: 'shared runs are read-only on this machine',
        code: 'peer_session_read_only',
      });
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
   * Stop one queued or running task, leaving its siblings alone.
   *
   * A queued task never acquired a run, so it is closed synchronously. A live
   * one is cancelled through its run: the normal terminal path finalizes the
   * task row and emits the frame the room stream is already watching for.
   */
  app.post('/api/tasks/:id/cancel', (req, res) => {
    const task = ctx.db.getTask(req.params.id!);
    if (!task || (task.status !== 'queued' && task.status !== 'running')) {
      // Ended tasks are not an error worth explaining: stopping an answer that
      // already finished is a no-op the caller can ignore (and its roster will
      // refresh anyway).
      res.status(404).json({ error: 'task is no longer running', code: 'task_not_found' });
      return;
    }

    if (task.status === 'queued' && !task.run_id) {
      const now = Date.now();
      ctx.db.updateTask(task.id, {
        status: 'cancelled',
        endedAt: now,
        error: 'cancelled by user',
      });
      ctx.db.finishTurnIfSettled(task.turn_id, now);
      res.json({ ok: true, taskId: task.id, status: 'cancelled' });
      return;
    }

    const active = task.run_id ? getActiveRun(task.run_id) : undefined;
    if (active) {
      active.cancel('cancelled by user');
      res.json({ ok: true, taskId: task.id, status: 'cancelling' });
      return;
    }

    // The run left the active table but its task row has not settled yet: the
    // normal terminal path is already writing the final status. Report "not
    // running" rather than racing it with a second update.
    res.status(404).json({ error: 'task is no longer running', code: 'task_not_found' });
  });

  /**
   * One user input, several agents.
   *
   * Returns 202 with the tasks it created: the answer arrives on the room
   * stream, not in this response. That is what makes the turn a batch rather
   * than a barrier — the client is free immediately and watches the room.
   */
  app.post('/api/sessions/:id/turns', asyncRoute(async (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    // `purpose='peer'` sessions belong to the remote visitor driving them; the
    // exposing side may watch but must not inject turns into that conversation.
    if (session.purpose === 'peer') {
      res.status(403).json({
        error: 'shared runs are read-only on this machine',
        code: 'peer_session_read_only',
      });
      return;
    }
    const workspace = session.workspace_id ? ctx.db.getWorkspace(session.workspace_id) : undefined;
    if (!workspace) {
      res.status(400).json({ error: 'session has no workspace', code: 'workspace_not_found' });
      return;
    }

    const parsed = parseTurnBody(req.body);
    if (parsed instanceof TurnHttpError) {
      res.status(parsed.status).json({ error: parsed.message, code: parsed.code });
      return;
    }

    try {
      const dispatched = await dispatchTurn(ctx, { session, workspace, ...parsed });
      res.status(202).json(dispatched);
    } catch (err) {
      if (err instanceof TurnHttpError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  }));
}
