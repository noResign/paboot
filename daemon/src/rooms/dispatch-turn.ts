import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import {
  AgentValidationError,
  createTurn,
  listAgents,
  MAX_MENTIONS,
  runTurn,
} from '../agents/index.js';
import { normalizeAttachmentIds } from '../attachments/request.js';
import { log } from '../platform/log.js';
import { taskRunnerDeps } from './session-events.js';

/**
 * Create one turn on a session and start its runs.
 *
 * Shared by `POST /api/sessions/:id/turns` and the optional first-prompt path
 * of `POST /api/sessions`, so the create-and-send and send-only flows cannot
 * drift. Fire-and-forget: the answer arrives on the room stream, not in the
 * HTTP response.
 */

/** A turn failure that maps directly to an HTTP status. */
export class TurnHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TurnHttpError';
  }
}

export interface ParsedTurnBody {
  prompt: string;
  mentionIds: string[];
  commandId: string | null;
  attachmentIds: string[];
}

/**
 * Read a turn request body. Returns a `TurnHttpError` (instead of throwing) so
 * both callers can answer with the same status/code without a try/catch around
 * pure validation.
 */
export function parseTurnBody(body: unknown): ParsedTurnBody | TurnHttpError {
  const raw = (body ?? {}) as {
    prompt?: unknown;
    mentions?: unknown;
    commandId?: unknown;
    attachmentIds?: unknown;
  };
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) {
    return new TurnHttpError(400, 'prompt_required', 'prompt is required');
  }
  const mentionIds = Array.isArray(raw.mentions)
    ? raw.mentions.filter((id): id is string => typeof id === 'string')
    : [];
  if (mentionIds.length > MAX_MENTIONS) {
    return new TurnHttpError(
      400,
      'too_many_mentions',
      `at most ${MAX_MENTIONS} agents may be addressed in one turn`,
    );
  }
  const commandId =
    typeof raw.commandId === 'string' && raw.commandId ? raw.commandId : null;
  const attachmentIds = normalizeAttachmentIds(raw.attachmentIds);
  if (attachmentIds === null) {
    return new TurnHttpError(
      400,
      'bad_request',
      'attachmentIds must be an array of unique ids',
    );
  }
  return { prompt, mentionIds, commandId, attachmentIds };
}

export interface DispatchTurnInput extends ParsedTurnBody {
  session: SessionRow;
  workspace: WorkspaceRow;
}

export interface DispatchedTurn {
  turnId: string;
  addressed: { agentId: string; name: string; source: string }[];
  dropped: { id: string; name: string; reason: string }[];
  tasks: { id: string; agentId: string; source: string; status: string }[];
}

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

export async function dispatchTurn(
  ctx: AppContext,
  input: DispatchTurnInput,
): Promise<DispatchedTurn> {
  const { session, workspace, attachmentIds } = input;

  for (const id of attachmentIds) {
    const attachment = ctx.attachments.get(id);
    if (!attachment) {
      throw new TurnHttpError(404, 'attachment_not_found', `attachment not found: ${id}`);
    }
    if (attachment.sessionId && attachment.sessionId !== session.id) {
      throw new TurnHttpError(
        403,
        'attachment_forbidden',
        `attachment belongs to another session: ${id}`,
      );
    }
    if (attachment.workspaceId && attachment.workspaceId !== workspace.id) {
      throw new TurnHttpError(
        403,
        'attachment_forbidden',
        `attachment belongs to another workspace: ${id}`,
      );
    }
  }

  const imageSupport =
    attachmentIds.length > 0 ? await imageSupportByAgent(ctx, workspace.id) : null;

  let created;
  try {
    created = createTurn(ctx.db, {
      session,
      workspace,
      prompt: input.prompt,
      mentionIds: input.mentionIds,
      commandId: input.commandId,
      attachmentIds: input.attachmentIds,
      ...(imageSupport
        ? {
            validateAttachmentTargets: (agents) => {
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
      const status =
        err.code === 'command_id_conflict' || err.code === 'room_full' ? 409 : 400;
      throw new TurnHttpError(status, err.code, err.message);
    }
    throw err;
  }

  // Own the uploads as soon as the turn exists. The per-run bind below adds a
  // run id later; the session/workspace binding is the access-control fact the
  // attachment GET route relies on.
  for (const id of attachmentIds) {
    ctx.attachments.bind(id, { sessionId: session.id, workspaceId: workspace.id });
  }

  const dispatched: DispatchedTurn = {
    turnId: created.turn.id,
    addressed: created.addressed,
    dropped: created.dropped,
    tasks: created.tasks.map((task) => ({
      id: task.id,
      agentId: task.agent_id,
      source: task.source,
      status: task.status,
    })),
  };

  // A retry re-attaches to the turn it already created; starting its tasks a
  // second time would run the same agent twice.
  if (created.replayed) return dispatched;

  // Fire and forget: the response is the acknowledgement, not the answer. A
  // failure here is per-task and reported on the room stream.
  void runTurn(ctx, taskRunnerDeps(ctx), {
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

  return dispatched;
}
