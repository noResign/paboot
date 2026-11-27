import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import type { LlmRequest } from '../llm/types.js';
import { BuiltinModelError, resolveBuiltinModel } from '../runtimes/builtin/models.js';

/** A draft that failed for a reason the route can map to an HTTP status. */
export class DefinitionDraftError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DefinitionDraftError';
  }
}

export interface DraftDefinitionInput {
  workspaceId: string;
  name: string;
  summary?: string;
  /** Include workspace name/ends/knowledge titles/top-level dirs in the prompt. */
  includeWorkspace?: boolean;
}

export interface DraftAgentInput {
  workspaceId: string;
  /** Free-form description of what the assistant should be/do. */
  idea: string;
  includeWorkspace?: boolean;
}

export interface DraftAgentResult {
  name: string;
  summary: string;
  instructions: string;
}

/** Narrow slice of the provider we actually use, so tests can inject a fake. */
interface DraftModel {
  provider: { id: string; complete(req: LlmRequest): Promise<{ text: string }> };
  model: string;
}

export interface DraftDefinitionDeps {
  resolveModel?: (requested?: string) => Promise<DraftModel>;
}

const MAX_CONTEXT_CHARS = 2400;
const MAX_TOKENS = 700;
const MAX_NAME_CHARS = 40;
const MAX_SUMMARY_CHARS = 40;
/** Defensive caps on what we paste into a prompt; the UI caps much lower. */
const MAX_INPUT_NAME_CHARS = 200;
const MAX_INPUT_SUMMARY_CHARS = 400;
const MAX_INPUT_IDEA_CHARS = 4_000;

const DEFINITION_SYSTEM = [
  'You write the system prompt ("definition") for an AI assistant, from its name and one-line summary.',
  "Write in the same language as the user's name/summary (Chinese if those are Chinese).",
  'Describe the role, what to focus on, working style, and boundaries/what to avoid.',
  'Address the assistant as "you". Keep it practical: 120-250 Chinese characters or 80-160 English words.',
  'Output ONLY the definition body: no title, no markdown fences, no quotes, no preamble.',
].join(' ');

const DRAFT_SYSTEM = [
  'You design an AI assistant from a description of what the user wants it to do.',
  "Write in the same language as the user's description (Chinese if it is Chinese).",
  'Reply with ONE JSON object and nothing else:',
  '{"name": "...", "summary": "...", "instructions": "..."}',
  `- name: the assistant's name, at most ${MAX_NAME_CHARS} characters.`,
  `- summary: one line shown in a room roster, at most ${MAX_SUMMARY_CHARS} characters.`,
  '- instructions: the system prompt, second person ("you"/"你"), 120-250 Chinese characters or 80-160 English words, covering role, focus, style and boundaries.',
  'No markdown, no code fences, no commentary outside the JSON.',
].join(' ');

/**
 * Generate an assistant's long-form definition in one tool-free completion.
 *
 * Deliberately not a builtin run: it needs no session, tools, or kernel. The
 * model is the builtin default (first configured provider/model); no provider
 * configured is a 409 the UI turns into "go configure one".
 */
export async function draftAgentDefinition(
  ctx: AppContext,
  input: DraftDefinitionInput,
  deps: DraftDefinitionDeps = {},
): Promise<{ instructions: string }> {
  const name = input.name.trim();
  if (!name) throw new DefinitionDraftError('name_required', 400, 'name is required');
  if (name.length > MAX_INPUT_NAME_CHARS) {
    throw new DefinitionDraftError('name_too_long', 400, 'name is too long');
  }
  const workspace = ctx.db.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new DefinitionDraftError('workspace_not_found', 404, 'workspace not found');
  }

  const summary = input.summary?.trim();
  if (summary && summary.length > MAX_INPUT_SUMMARY_CHARS) {
    throw new DefinitionDraftError('summary_too_long', 400, 'summary is too long');
  }
  const model = await resolveDraftModel(deps);
  const context = input.includeWorkspace
    ? workspaceContext(ctx, workspace.path, workspace.name, workspace.id)
    : '';
  const user = [
    `名字：${name}`,
    summary ? `简介：${summary}` : null,
    context ? `\n工作区上下文（仅供参考，用来让定义更贴合这个空间）：\n${context}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const instructions = await completeText(model, DEFINITION_SYSTEM, user);
  return { instructions };
}

/**
 * Draft a whole assistant (name/summary/definition) from a free-form idea.
 * Returns the fields only — the client fills its form and the user reviews and
 * saves, so a bad generation never creates an agent by itself.
 */
export async function draftAgentFromIdea(
  ctx: AppContext,
  input: DraftAgentInput,
  deps: DraftDefinitionDeps = {},
): Promise<DraftAgentResult> {
  const idea = input.idea.trim();
  if (!idea) throw new DefinitionDraftError('idea_required', 400, 'idea is required');
  if (idea.length > MAX_INPUT_IDEA_CHARS) {
    throw new DefinitionDraftError('idea_too_long', 400, 'idea is too long');
  }
  const workspace = ctx.db.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new DefinitionDraftError('workspace_not_found', 404, 'workspace not found');
  }

  const model = await resolveDraftModel(deps);
  const context = input.includeWorkspace
    ? workspaceContext(ctx, workspace.path, workspace.name, workspace.id)
    : '';
  const user = [
    `用户想要的助手：${idea}`,
    context ? `\n工作区上下文（仅供参考）：\n${context}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const text = await completeText(model, DRAFT_SYSTEM, user);
  return parseDraft(text);
}

async function resolveDraftModel(deps: DraftDefinitionDeps): Promise<DraftModel> {
  try {
    return await (deps.resolveModel?.(undefined) ?? resolveBuiltinModel(undefined));
  } catch (err) {
    if (err instanceof BuiltinModelError) {
      throw new DefinitionDraftError(
        err.code === 'no_provider' ? 'no_provider' : 'model_unavailable',
        409,
        err.message,
      );
    }
    throw err;
  }
}

async function completeText(model: DraftModel, system: string, user: string): Promise<string> {
  const controller = new AbortController();
  // The desktop request allows 45s, so the daemon must abort first and return a
  // readable reason instead of letting the client give up on a live run.
  const timer = setTimeout(() => controller.abort(), 25_000);
  timer.unref?.();
  try {
    const completion = await model.provider.complete({
      provider: model.provider.id,
      model: model.model,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: MAX_TOKENS,
      temperature: 0.4,
      signal: controller.signal,
    });
    const text = completion.text.trim();
    if (!text) {
      throw new DefinitionDraftError('empty_response', 502, 'the model returned nothing');
    }
    return text;
  } catch (err) {
    if (err instanceof DefinitionDraftError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new DefinitionDraftError('generation_timeout', 504, 'generation timed out');
    }
    throw new DefinitionDraftError(
      'generation_failed',
      502,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerate fenced/prose-wrapped JSON, then validate the three fields. */
function parseDraft(raw: string): DraftAgentResult {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : raw.trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  let parsed: unknown = null;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (!isRecord(parsed)) {
    throw new DefinitionDraftError('bad_response', 502, 'the model did not return a usable JSON object');
  }
  const name = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
  const summary = typeof parsed['summary'] === 'string' ? parsed['summary'].trim() : '';
  const instructions =
    typeof parsed['instructions'] === 'string' ? parsed['instructions'].trim() : '';
  if (!name || !instructions) {
    throw new DefinitionDraftError('bad_response', 502, 'the draft is missing a name or definition');
  }
  return {
    name: clamp(name, MAX_NAME_CHARS),
    summary: clamp(summary, MAX_SUMMARY_CHARS),
    instructions,
  };
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structured workspace context only — names and one-line summaries, never file
 * contents. Bounded so a huge workspace cannot blow the prompt budget.
 */
function workspaceContext(
  ctx: AppContext,
  workspacePath: string,
  workspaceName: string,
  workspaceId: string,
): string {
  const lines = [`工作区：${workspaceName}`, `主目录：${workspacePath}`];

  const ends = ctx.db
    .listEnds(workspaceId)
    .filter((end) => end.status !== 'archived')
    .slice(0, 8);
  for (const end of ends) {
    const detail = [end.summary?.trim(), end.notes?.trim()].filter(Boolean).join('；');
    const roots = ctx.db
      .listEndRoots(end.id)
      .map((root) => path.basename(root))
      .filter(Boolean);
    lines.push(
      `- 端「${end.name}」${detail ? `：${detail}` : ''}${roots.length ? `（目录：${roots.join(', ')}）` : ''}`,
    );
  }

  const docs = ctx.knowledge.list(workspaceId, { verified: true }).slice(0, 12);
  if (docs.length > 0) {
    lines.push(`知识：${docs.map((doc) => doc.title).join('、')}`);
  }

  try {
    const dirs = fs
      .readdirSync(workspacePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .slice(0, 20);
    if (dirs.length > 0) lines.push(`顶层目录：${dirs.join(', ')}`);
  } catch {
    // The workspace path may be gone; the rest of the context is still useful.
  }

  const text = lines.join('\n');
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text;
}
