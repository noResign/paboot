import { randomUUID } from 'node:crypto';
import type { Agent, AgentThread } from '../agents/index.js';
import type { AppContext } from '../app/context.js';
import type { AgentTaskRow, SessionRow, WorkspaceRow } from '../db/db.js';
import type { RunSink } from '../runs/run-service.js';
import type { RunOutcome, RunStatus } from '../runtimes/engine.js';
import { registerActiveRun } from '../runtimes/active-runs.js';
import type { NormalizedEvent, SseFrame } from '../types/api.js';
import { cancelPeerRun, openPeerRun, readPeerFrames } from './client.js';
import { PeerValidationError } from './contract.js';

/**
 * B-side executor for a remote agent.
 *
 * It is deliberately *not* a RuntimeDriver: a peer consumes HTTP events and
 * owns a `threadKey` + remote peer id, neither of which belongs in the argv/RPC
 * driver seam. It returns the same `{runId, done}` shape so the task runner's
 * persistence and room wiring stay unchanged.
 */
export interface PeerTaskRunInput {
  session: SessionRow;
  workspace: WorkspaceRow;
  task: AgentTaskRow;
  agent: Agent;
  thread: AgentThread;
  roomContext?: string;
  roomSystem?: string;
  sink: RunSink;
}

export interface PeerTaskRunHandle {
  runId: string;
  done: Promise<RunOutcome>;
}

const RETRIES = 3;

export function startPeerTaskRun(ctx: AppContext, input: PeerTaskRunInput): PeerTaskRunHandle {
  const peerId = input.agent.peerId;
  const remoteAgentId = input.agent.remoteAgentId;
  if (!peerId || !remoteAgentId) {
    throw new PeerValidationError('peer agent is missing its remote binding', 'peer_not_connected', 503);
  }
  const peer = ctx.db.getPeer(peerId);
  if (!peer || peer.direction !== 'out' || !peer.token_cipher) {
    throw new PeerValidationError('peer is not connected', 'peer_not_connected', 503);
  }
  const threadKey = input.thread.remoteThreadKey ?? `tk_${randomUUID()}`;
  if (!input.thread.remoteThreadKey) ctx.db.setAgentThreadRemoteKey(input.thread.id, threadKey);

  const runId = randomUUID();
  const clientRunId = input.task.id;
  ctx.db.createRun({
    id: runId,
    sessionId: input.session.id,
    runtime: `peer:${peer.id}`,
    model: null,
    prompt: input.task.prompt,
    status: 'running',
    trigger: 'peer',
    permissionMode: input.session.permission_mode,
    agentId: input.agent.id,
    threadId: input.thread.id,
    turnId: input.task.turn_id,
    peerId: peer.id,
    clientRunId,
  });

  const controller = new AbortController();
  let cancelled = false;
  let remoteRunId: string | null = null;

  const done = run().finally(() => {
    controller.abort();
  });

  registerActiveRun({
    id: runId,
    promise: done,
    cancel: () => {
      cancelled = true;
      controller.abort();
      if (remoteRunId) void cancelPeerRun(peer.base_url, peer.token_cipher!, remoteRunId);
    },
  });

  async function run(): Promise<RunOutcome> {
    let lastSeq = 0;
    let text = '';
    let error: string | null = null;
    let status: RunStatus | null = null;
    input.sink.begin?.();

    for (let attempt = 0; attempt < RETRIES && status === null && !cancelled; attempt += 1) {
      try {
        const response = await openPeerRun(
          peer!.base_url,
          peer!.token_cipher!,
          {
            agentId: remoteAgentId,
            clientRunId,
            threadKey,
            prompt: input.task.prompt,
            ...(input.roomContext || input.roomSystem
              ? {
                  room: {
                    ...(input.roomContext ? { projection: input.roomContext } : {}),
                    ...(input.roomSystem ? { roster: input.roomSystem } : {}),
                  },
                }
              : {}),
          },
          controller.signal,
        );
        ctx.db.touchPeer(peer!.id, Date.now());
        for await (const frame of readPeerFrames(response)) {
          if (frame.seq !== 0 && frame.seq <= lastSeq) continue;
          if (frame.event['type'] === 'peer_meta') {
            const meta = frame.event as { runId?: string };
            if (typeof meta.runId === 'string') {
              remoteRunId = meta.runId;
              ctx.db.setRunRemoteRunId(runId, remoteRunId);
            }
            continue;
          }
          const event = frame.event as unknown as NormalizedEvent;
          if (frame.seq > lastSeq) lastSeq = frame.seq;
          ctx.db.appendEvent(runId, frame.seq, event.type, event);
          const out: SseFrame = { runId, seq: frame.seq, event };
          try {
            input.sink.frame(out);
          } catch {
            // The room stream is best-effort; persistence above is the truth.
          }
          if (event.type === 'text_delta') text += event.delta;
          if ('terminal' in event && event.terminal === true) {
            if (event.type === 'error') {
              error = event.message;
              status = 'failed';
            } else if (event.type === 'status') {
              status = toRunStatus(event.label);
              if (status === 'failed' && error === null) error = event.label;
            }
          }
        }
      } catch (err) {
        if (cancelled) break;
        error = err instanceof Error ? err.message : String(err);
        if (attempt + 1 < RETRIES) {
          await delay(500 * 2 ** attempt);
          continue;
        }
      }
    }

    if (cancelled) status = 'cancelled';
    if (status === null) {
      status = 'failed';
      error = error ?? 'peer stream ended without a terminal frame';
    }

    const finalStatus = status;
    let messageId: number | null = null;
    if (text.trim()) {
      messageId = ctx.db.addMessage(input.session.id, 'assistant', text.trim(), {
        agentId: input.agent.id,
        turnId: input.task.turn_id,
        taskId: input.task.id,
        source: 'peer',
        commit: true,
      });
    }
    ctx.db.updateRun(runId, {
      status: finalStatus,
      endedAt: Date.now(),
      exitCode: null,
      error: finalStatus === 'succeeded' ? null : error,
    });
    ctx.db.audit(
      'peer_call',
      JSON.stringify({
        peerId: peer!.id,
        agentId: input.agent.id,
        runId,
        remoteRunId,
        status: finalStatus,
        error: finalStatus === 'succeeded' ? null : error,
      }),
    );
    return {
      status: finalStatus,
      exitCode: null,
      error: finalStatus === 'succeeded' ? null : error,
      messageId,
      ...(text.trim() ? { replyText: text.trim() } : {}),
    };
  }

  return { runId, done };
}

function toRunStatus(label: string): RunStatus {
  if (label === 'succeeded' || label === 'failed' || label === 'cancelled') return label;
  return label.includes('fail') ? 'failed' : 'succeeded';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
