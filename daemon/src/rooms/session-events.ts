import type { AppContext } from '../app/context.js';
import type { SseFrame } from '../types/api.js';
import type { TaskRunnerDeps } from '../agents/index.js';
import { startPeerTaskRun } from '../peer/index.js';
import { log } from '../platform/log.js';

/**
 * In-process fan-out and persistence for one session's room stream.
 *
 * Kept out of `routes/` so turn dispatch (used by both `/turns` and the
 * create-session endpoint) can publish without importing a route module.
 * Nothing here is persisted by this file; `events` already is.
 */

export interface RoomFrame extends SseFrame {
  /** Session-wide frame position; the client's resume cursor. */
  roomSeq: number;
  /** Which task produced this frame (null for session-level notices). */
  taskId: string | null;
  /** Which agent produced it; null for frames that are not an agent's. */
  agentId: string | null;
}

export interface Subscriber {
  sessionId: string;
  write(frame: RoomFrame): void;
  close(): void;
}

/** Rows per replay query; the route loops until it catches up. */
export const REPLAY_PAGE = 500;

const subscribers = new Map<string, Set<Subscriber>>();

/** Live listeners of a session, for the SSE route to replay then attach to. */
export function roomSubscribers(sessionId: string): Set<Subscriber> | undefined {
  return subscribers.get(sessionId);
}

export function addRoomSubscriber(subscriber: Subscriber): void {
  const set = subscribers.get(subscriber.sessionId) ?? new Set<Subscriber>();
  subscribers.set(subscriber.sessionId, set);
  set.add(subscriber);
}

export function removeRoomSubscriber(subscriber: Subscriber): void {
  const set = subscribers.get(subscriber.sessionId);
  if (!set) return;
  set.delete(subscriber);
  if (set.size === 0) subscribers.delete(subscriber.sessionId);
}

/** Close every room listener for a session that is being deleted. */
export function closeSessionRoomStreams(sessionId: string): void {
  for (const subscriber of subscribers.get(sessionId) ?? []) subscriber.close();
  subscribers.delete(sessionId);
}

export function broadcast(
  ctx: AppContext,
  sessionId: string,
  frame: Omit<RoomFrame, 'roomSeq'>,
): void {
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
    // Still fan the frame out live, but it is now unrecoverable for a client
    // that was not yet subscribed: with create-and-send the agent can finish
    // before the room stream opens, and replay is the only way that client
    // would see this frame. Log loudly enough to be actionable.
    log.error(
      `failed to persist room frame for ${sessionId} (seq ${frame.seq}); it cannot be replayed`,
      err,
    );
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

/** Task runners get peer execution injected here, keeping `agents/` transport-free. */
export function taskRunnerDeps(ctx: AppContext): TaskRunnerDeps {
  return {
    publish: roomPublisher(ctx),
    runPeerTask: (inner, input) => startPeerTaskRun(inner, input),
  };
}
