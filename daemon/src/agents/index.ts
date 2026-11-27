/**
 * `agents/` — the multi-agent domain module.
 *
 * Everything outside this folder imports *this file only*. The internal split
 * (store / service / resolve) is free to change; the surface below is not,
 * because `routes/` depends on it and `tests/architecture.test.ts` guards the
 * boundary.
 *
 * Boundary rules:
 *   - this module must not import `routes/` or `rooms/`;
 *   - `runtimes/` and `llm/` must not import it at all — they only ever see
 *     "prompt + cwd + permission", which is what lets a fourth runtime drop in
 *     without touching agents.
 */
export {
  backfillMultiAgent,
  backfillNativeThreadAgents,
  backfillRunAttribution,
  backfillRunTurnIds,
  DEFAULT_IMPLICIT_RUNTIME,
  type BackfillLogger,
  type BackfillResult,
} from './backfill.js';

export {
  AgentValidationError,
  addToSession,
  adoptLeader,
  assertWritableSlotFree,
  createAgent,
  ensureThread,
  getAgent,
  listAgents,
  listThreads,
  MAX_SUMMARY_CHARS,
  removeAgent,
  ROOM_MAX_MEMBERS,
  sessionRoster,
  syncSessionRuntime,
  updateAgent,
} from './service.js';

export {
  backendFor,
  defaultAgentFor,
  resolveSessionAgent,
  type ResolvedSessionAgent,
} from './resolve.js';

export {
  findSummonMentions,
  MAX_MENTIONS,
  mentionsAll,
  parseMentionNames,
  routeMentions,
  type MentionTarget,
} from './mentions.js';

export { buildRoomSystem, type RoomSystemInput } from './roster.js';

export {
  buildRoomProjection,
  ROOM_CONTEXT_MAX_CHARS,
  ROOM_CONTEXT_RECENT,
  type RoomProjectionInput,
} from './projection.js';

export {
  createTurn,
  type CreatedTurn,
  type CreateTurnInput,
} from './turns.js';

export {
  draftAgentDefinition,
  draftAgentFromIdea,
  DefinitionDraftError,
  type DraftAgentInput,
  type DraftAgentResult,
  type DraftDefinitionDeps,
  type DraftDefinitionInput,
} from './definition-draft.js';

export { runTask, runTurn, type TaskOutcome, type TaskRunnerDeps } from './task-runner.js';

export { getLeader, listSessionAgents } from './store.js';

export type {
  Agent,
  AgentAvailability,
  AgentBudgetOverride,
  AgentKind,
  AgentRunTarget,
  AgentThread,
  CreateAgentInput,
  UpdateAgentInput,
} from './types.js';
