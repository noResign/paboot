import fs from 'node:fs';
import path from 'node:path';

import type { AppContext } from '../../app/context.js';
import { resolveSessionEnd } from '../../ends/scope.js';
import type { SessionRow, WorkspaceRow } from '../../db/db.js';
import { log } from '../../platform/log.js';
import type { NormalizedEvent, PermissionStatus, QuestionDto } from '../../types/api.js';
import type { RuntimeDriver, RuntimeDriverRequest } from '../RuntimeDriver.js';
import { registerActiveRun, type ManagedRun } from '../active-runs.js';
import type { RunOutcome } from '../engine.js';
import type { TranscriptContentBlock } from '../../types/transcript.js';
import { DEFAULT_BUILTIN_CONFIG } from './config.js';
import { resolveContextBudget } from './budget.js';
import { summarizeCompaction } from './compact.js';
import { buildAnthropicBody } from '../../llm/anthropic.js';
import { buildOpenAIBody } from '../../llm/openai.js';
import { AgentKernel } from './kernel/agent.js';
import { resolveBuiltinModel } from './models.js';
import { createTokenCalibrator } from './tokens.js';
import {
  assembleAgentContext,
  builtinGlobalPromptSections,
  EnvironmentContextSource,
  MemoryBriefContextSource,
  ProjectDocsContextSource,
  WorkspaceKnowledgeContextSource,
} from './context/index.js';
import { SkillsCatalogContextSource } from './skills/catalog.js';
import type { AgentContextProfile } from './runtime-context.js';
import { createTranscriptStore } from './transcript/store.js';
import { createAttachmentImageResolver } from './transcript/render.js';
import { NativeToolProvider } from './tools/native.js';
import { createReadTool } from './tools/read.js';
import { ReadFilesTracker } from './tools/read-files.js';
import { createWriteTool } from './tools/write.js';
import { createEditTool } from './tools/edit.js';
import { createBashTool } from './tools/bash.js';
import { createGrepTool } from './tools/grep.js';
import { createGlobTool } from './tools/glob.js';
import { createTodoTool } from './tools/todo.js';
import {
  createAskUserQuestionTool,
  type QuestionExchange,
} from './tools/ask-user-question.js';
import { createWebFetchTool } from './tools/webfetch.js';
import { resolveFetchBackend } from './web/fetch.js';
import { createLoadSkillTool } from './skills/load-tool.js';
import { SkillRegistry, type SkillRoot } from './skills/registry.js';
import { createPermissionBroker } from './tools/permission-broker.js';
import { ToolExecutor } from './tools/executor.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolProvider } from './tools/types.js';
import { McpToolProvider } from './mcp/provider.js';
import type { AgentProfile, AgentRunContext, PathGrant, ResolvedPathPolicy, ToolDescriptor } from './types.js';
import type { AgentPromptPreset } from './prompt.js';
import { isBypassAllowed } from '../../permissions/security-profile.js';
import { resolveReadPolicy } from '../../memory/read-policy.js';
import { isMemoryInjectionEnabled } from '../../memory/settings.js';

export function createBuiltinDriver(ctx: AppContext): RuntimeDriver {
  return {
    id: 'builtin',
    requiresDetection: true,
    start(req: RuntimeDriverRequest): ManagedRun<RunOutcome> {
      const controller = new AbortController();
      let cancelReason: string | undefined;
      const promise = runBuiltin(ctx, req, controller.signal, () => cancelReason);
      const active: ManagedRun<RunOutcome> = {
        id: req.runId,
        promise,
        cancel(reason?: string) {
          cancelReason = reason ?? 'cancelled';
          controller.abort(cancelReason);
        },
      };
      registerActiveRun(active);
      return active;
    },
  };
}

async function runBuiltin(
  ctx: AppContext,
  req: RuntimeDriverRequest,
  signal: AbortSignal,
  cancelReason: () => string | undefined,
): Promise<RunOutcome> {
  let executor: ToolExecutor | undefined;
  try {
    const session = ctx.db.getSession(req.sessionId);
    if (!session) throw new Error(`session not found: ${req.sessionId}`);
    const workspace = session.workspace_id ? ctx.db.getWorkspace(session.workspace_id) : undefined;
    if (!workspace) throw new Error('workspace not found for builtin session');

    const resolved = await resolveBuiltinModel(req.model, process.env);
    const builtinConfig = ctx.builtinConfig ?? DEFAULT_BUILTIN_CONFIG;
    const budget = resolveContextBudget(builtinConfig, resolved.snapshot.contextWindow);
    const denyRoots =
      builtinConfig.securityProfile === 'server-strict'
        ? serverStrictDenyRoots(ctx.config.dataDir)
        : [];
    const calibrator = createTokenCalibrator(resolved.modelId);
    const measure = calibrator.measure;
    const attachments = (req.attachmentIds ?? []).map((id) => {
      const row = ctx.attachments.get(id);
      if (!row) throw new Error(`attachment not found: ${id}`);
      if (row.sessionId && row.sessionId !== session.id) {
        throw new Error(`attachment belongs to another session: ${id}`);
      }
      return row;
    });
    if (attachments.length > 0 && !resolved.snapshot.supportsImages) {
      throw new Error(`model does not support image input: ${resolved.modelId}`);
    }

    const transcript = createTranscriptStore(ctx.db);
    const thread = transcript.getOrCreateThread({ sessionId: session.id, agentId: 'builtin' });
    const userBlocks: TranscriptContentBlock[] = [];
    if (req.prompt) userBlocks.push({ type: 'text', text: req.prompt });
    for (const attachment of attachments) {
      userBlocks.push({
        type: 'image',
        attachmentId: attachment.id,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
      });
      ctx.attachments.bind(attachment.id, {
        sessionId: session.id,
        workspaceId: workspace.id,
        runId: req.runId,
      });
    }
    transcript.append({
      threadId: thread.id,
      role: 'user',
      blocks: userBlocks,
      source: { kind: 'user' },
      runId: req.runId,
      step: 1,
    });

    const skills = new SkillRegistry(skillRoots(ctx, workspace), {
      maxFileBytes: builtinConfig.skills.maxFileBytes,
    });
    const skillsAvailable = skills.list();
    const profile: AgentProfile = {
      identity: { id: 'builtin', name: 'Builtin', role: 'assistant' },
      instructions: '',
      budgetDefaults: { maxSteps: budget.maxSteps, maxToolCalls: budget.maxToolCalls },
    };
    const preset: AgentPromptPreset = { id: 'builtin-default', version: 1 };
    const presets = new Map([[preset.id, preset]]);
    const contextProfile: AgentContextProfile = {
      agentId: 'builtin',
      promptPreset: preset,
      contextSources: [
        new EnvironmentContextSource(),
        new ProjectDocsContextSource({
          maxFileBytes: builtinConfig.projectDocs.maxFileBytes,
          maxTokens: budget.projectDocsTokens,
          measure,
        }),
        new WorkspaceKnowledgeContextSource(ctx.knowledge),
        ...(ctx.memory
          ? [
              new MemoryBriefContextSource(ctx.memory, {
                resolvePolicy: (snapshot) => {
                  const workspace = ctx.db.getWorkspace(snapshot.id);
                  if (!workspace) {
                    return { scopes: [], profileMode: 'off', includesUser: false };
                  }
                  const settings = ctx.db.getMemorySettings(workspace.id);
                  if (!isMemoryInjectionEnabled(workspace, settings)) {
                    return { scopes: [], profileMode: 'off', includesUser: false };
                  }
                  return resolveReadPolicy({
                    workspace,
                    workspaces: ctx.db.listWorkspaces(),
                    getSettings: (workspaceId) => ctx.db.getMemorySettings(workspaceId),
                  });
                },
              }),
            ]
          : []),
        new SkillsCatalogContextSource(skills, {
          descriptionMaxChars: builtinConfig.skills.catalogDescriptionChars,
        }),
      ],
    };

    const agent = makeAgentContext({
      ctx,
      req,
      session,
      workspace,
      signal,
      budget,
      securityProfile: builtinConfig.securityProfile,
      allowBypass: isBypassAllowed(builtinConfig),
      denyRoots,
    });
    const permissionBroker = createPermissionBroker({
      permissions: ctx.permissions,
      notifier: ctx.notifier,
      grants: ctx.db,
    });
    agent.permissionBroker = permissionBroker;

    // Read-before-write survives resume: seed from the persisted transcript.
    const readFiles = ReadFilesTracker.fromTranscript(transcript.list(thread.id), session.cwd);
    const webSelection = resolveFetchBackend({
      settings: builtinConfig.web.fetch,
      provider: resolved.providerConfig,
    });
    if (webSelection.fallbackFrom === 'provider') {
      // Widened reach behind the user's back is exactly the change that has to
      // stay traceable: the local backend can hit intranet and loopback.
      log.warn(
        `run ${req.runId}: WebFetch fell back to the local backend (no usable provider ` +
          'fetch API); it can reach intranet and loopback addresses',
      );
    }
    const pendingQuestions = new Map<string, QuestionDto[]>();
    const questionExchange: QuestionExchange = {
      create(questions) {
        const pending = ctx.permissions.create(req.runId, req.sessionId, 'UserInput', {
          kind: 'questions',
          questions,
          message: '需要你的回答',
        });
        pendingQuestions.set(pending.id, questions);
        pending.validateResponse = (response) => validateQuestionResponse(response, questions);
        return pending.id;
      },
      async wait(permissionId, questionSignal) {
        const decided = await waitForAnswer(
          ctx.permissions.wait(permissionId),
          questionSignal,
          () => ctx.permissions.decide(permissionId, 'deny', 'run cancelled'),
        );
        const questions = pendingQuestions.get(permissionId) ?? [];
        pendingQuestions.delete(permissionId);
        const allowed = decided.status === 'allowed';
        return {
          status:
            decided.status === 'timed_out'
              ? 'timed_out'
              : allowed
                ? 'allowed'
                : 'denied',
          answer: allowed ? formatQuestionAnswers(questions, decided.response) : null,
        };
      },
    };
    const nativeTools = [
      createReadTool({
        maxFileBytes: builtinConfig.tools.read.maxFileBytes,
        defaultLimit: builtinConfig.tools.read.defaultLimit,
        maxLimit: builtinConfig.tools.read.maxLimit,
        maxLineChars: builtinConfig.tools.read.maxLineChars,
        maxOutputTokens: budget.maxResultTokens,
        measure,
        recordRead: (path) => readFiles.add(path),
      }),
      createWriteTool({
        maxFileBytes: builtinConfig.tools.write.maxFileBytes,
        wasRead: (path) => readFiles.has(path),
        recordWrite: (path) => readFiles.add(path),
      }),
      createEditTool({
        maxFileBytes: builtinConfig.tools.edit.maxFileBytes,
        wasRead: (path) => readFiles.has(path),
        recordWrite: (path) => readFiles.add(path),
      }),
      createBashTool({
        defaultTimeoutMs: builtinConfig.tools.bash.defaultTimeoutMs,
        maxTimeoutMs: builtinConfig.tools.bash.maxTimeoutMs,
        maxOutputBytes: builtinConfig.tools.bash.maxOutputBytes,
        envAllow: builtinConfig.tools.bash.envAllow,
        ...(ctx.spill ? { spill: ctx.spill } : {}),
      }),
      createGrepTool({
        maxResults: builtinConfig.tools.grep.maxResults,
        maxFileBytes: builtinConfig.tools.grep.maxFileBytes,
        maxLineChars: builtinConfig.tools.grep.maxLineChars,
      }),
      createGlobTool({ maxResults: builtinConfig.tools.glob.maxResults }),
      createTodoTool(),
      createLoadSkillTool(skills, {
        allowedSkills: profile.allowedSkills,
      }),
      createAskUserQuestionTool(questionExchange),
    ];
    // Register WebFetch when a backend is usable. An explicitly configured but
    // unusable backend is still registered so its call returns the reason
    // instead of the tool silently disappearing.
    if (
      builtinConfig.web.fetch.enabled &&
      (webSelection.backend !== null || builtinConfig.web.fetch.provider !== 'auto')
    ) {
      nativeTools.push(
        createWebFetchTool({
          selection: webSelection,
          provider: resolved.provider,
          model: resolved.model,
          maxInputTokens: budget.maxResultTokens,
          measure,
        }),
      );
    }
    const nativeProvider = new NativeToolProvider(nativeTools);
    const toolProviders: ToolProvider[] = [nativeProvider];
    // The daemon assembled this run's MCP servers; mount the entries that
    // actually exist (the dev tsx runner may not have compiled dist/).
    const mcpServers = (req.toolServers ?? []).filter((spec) => {
      const entry = spec.args[0];
      return typeof entry === 'string' && fs.existsSync(entry);
    });
    if (mcpServers.length > 0) {
      toolProviders.push(new McpToolProvider(mcpServers));
    }
    const toolsRegistry = new ToolRegistry(toolProviders);
    const toolDescriptors = await toolsRegistry.list({ agent, signal });
    const visibleTools = resolved.snapshot.supportsTools ? toolDescriptors : [];
    executor = new ToolExecutor({
      registry: toolsRegistry,
      maxResultTokens: budget.maxResultTokens,
      measure,
    });

    const imageResolver = resolved.snapshot.supportsImages
      ? createAttachmentImageResolver(ctx.attachments)
      : undefined;
    const startedAt = Date.now();
    let lastContextReport: string | null = null;
    const assembleContext = async (tools: readonly ToolDescriptor[]) => {
      const promptContext = {
        agent,
        profile,
        preset,
        session: {
          id: session.id,
          workspaceId: workspace.id,
          agentId: 'builtin',
          endId: resolveSessionEnd(ctx.db, session)?.id ?? null,
          memoryMode: session.memory_mode,
          purpose: session.purpose,
        },
        workspace: agent.workspace,
        model: resolved.snapshot,
        toolSet: tools,
        skillCatalog: skillsAvailable,
        stepFacts: {},
        signal,
      };
      const runtimeContextContext = {
        agent,
        profile,
        session: promptContext.session,
        model: resolved.snapshot,
        toolSet: tools,
        skillCatalog: skillsAvailable,
        signal,
        now: startedAt,
      };
      const assembled = await assembleAgentContext({
        profile: contextProfile,
        presets,
        globalSections: builtinGlobalPromptSections(),
        promptContext,
        runtimeContextContext,
        systemTokenBudget: budget.systemPromptTokens,
        runtimeContextTokenBudget: budget.runtimeContextTokens,
        measure,
      });
      // Budget drops are otherwise invisible: a whole section can disappear
      // from the prompt with no trace anywhere. Report once per distinct set.
      const omitted = [
        ...assembled.system.omitted.map((item) => `system:${item.id}:${item.reason}`),
        ...assembled.runtimeContext.omitted.map((item) => `runtime:${item.source}:${item.reason}`),
      ];
      if (assembled.system.overBudget || assembled.runtimeContext.overBudget || omitted.length > 0) {
        const report = `${assembled.contextVersion}|${omitted.join(',')}`;
        if (report !== lastContextReport) {
          lastContextReport = report;
          log.warn(
            `builtin run ${req.runId} context trimmed: ` +
              `systemOverBudget=${assembled.system.overBudget} ` +
              `runtimeOverBudget=${assembled.runtimeContext.overBudget}` +
              (omitted.length > 0 ? ` omitted=[${omitted.join(', ')}]` : ''),
          );
        }
      }
      return assembled;
    };

    // [debug] wire the per-step snapshot; the recorder no-ops when idle
    const debugRecorder = ctx.debug;
    const kernel = new AgentKernel({
      provider: resolved.provider,
      model: resolved.model,
      modelSnapshot: resolved.snapshot,
      threadId: thread.id,
      transcript,
      toolDescriptors: visibleTools,
      toolExecutor: executor,
      assembleContext,
      tokenCalibrator: calibrator,
      compaction: {
        settings: builtinConfig.context.compaction,
        contextWindow: budget.contextWindowTokens,
        summarize: (plan, previous, signal) =>
          summarizeCompaction({
            transcript,
            threadId: thread.id,
            provider: resolved.provider,
            model: resolved.model,
            plan,
            previous,
            settings: builtinConfig.context.compaction,
            measure,
            signal,
          }),
      },
      ...(imageResolver ? { resolveImage: imageResolver } : {}),
      ...(debugRecorder
        ? {
            debugStep: (record) =>
              debugRecorder.recordBuiltinStep({
                sessionId: session.id,
                workspaceId: workspace.id,
                runId: record.runId,
                step: record.step,
                provider: record.provider,
                model: record.model,
                request: record.request,
                assembly: record.context,
                estimatedTokens: record.estimatedTokens,
                // Only build the duplicate wire payload while capture is live.
                wireBody: debugRecorder.active
                  ? resolved.providerConfig.kind === 'anthropic'
                    ? buildAnthropicBody(record.request)
                    : buildOpenAIBody(record.request)
                  : undefined,
              }),
            debugStepResult: (result) =>
              debugRecorder.recordBuiltinStepResult({
                sessionId: session.id,
                workspaceId: workspace.id,
                ...result,
              }),
          }
        : {}),
    });
    const result = await kernel.run(agent);
    if (result.status === 'succeeded') return { status: 'succeeded', exitCode: 0, error: null };
    if (result.status === 'cancelled') {
      return { status: 'cancelled', exitCode: null, error: cancelReason() ?? result.error ?? 'cancelled' };
    }
    return { status: 'failed', exitCode: null, error: result.error ?? 'builtin run failed' };
  } catch (error) {
    if (signal.aborted) {
      return { status: 'cancelled', exitCode: null, error: cancelReason() ?? 'cancelled' };
    }
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`builtin run ${req.runId} failed: ${message}`);
    return { status: 'failed', exitCode: null, error: message };
  } finally {
    await executor?.close().catch(() => undefined);
  }
}

function makeAgentContext(input: {
  ctx: AppContext;
  req: RuntimeDriverRequest;
  session: SessionRow;
  workspace: WorkspaceRow;
  signal: AbortSignal;
  budget: { maxSteps: number; maxToolCalls: number };
  securityProfile: 'server-strict' | 'local';
  allowBypass: boolean;
  denyRoots: string[];
}): AgentRunContext {
  const roots = unique([input.req.cwd, ...(input.req.extraDirs ?? [])]);
  const grants: PathGrant[] = roots.map((root) => ({
    root,
    capabilities: ['read', 'write', 'list'],
  }));
  const bypass =
    input.req.permissionMode === 'bypass' && input.allowBypass;
  const pathPolicy: ResolvedPathPolicy = bypass
    ? { mode: 'bypass', grants: [], denyRoots: [] }
    : {
        mode: input.securityProfile,
        grants,
        denyRoots: input.denyRoots,
      };
  return {
    runId: input.req.runId,
    sessionId: input.session.id,
    actor: { id: 'builtin', name: 'Builtin', role: 'assistant' },
    workspace: {
      id: input.workspace.id,
      name: input.workspace.name,
      family: input.workspace.family === 'life' ? 'life' : 'dev',
      root: input.workspace.path,
    },
    cwd: input.req.cwd,
    extraDirs: input.req.extraDirs ?? [],
    pathPolicy,
    permissionMode: input.req.permissionMode,
    signal: input.signal,
    budget: {
      maxSteps: input.budget.maxSteps,
      maxToolCalls: input.budget.maxToolCalls,
    },
    eventSink: {
      emit: (event) => input.req.onEvent(event as NormalizedEvent),
    },
    permissionBroker: {
      request: async () => ({ status: 'denied', reason: 'permission broker not configured' }),
    },
  };
}

/**
 * Hard denies for server-strict runs. Grants normally exclude these paths, but
 * an overlapping workspace (for example `~/.paboot` itself) must not expose the
 * daemon's credentials, database or attachment store.
 */
function serverStrictDenyRoots(dataDir: string): string[] {
  return [
    path.join(dataDir, 'token'),
    path.join(dataDir, 'paboot.sqlite'),
    path.join(dataDir, 'paboot.sqlite-wal'),
    path.join(dataDir, 'paboot.sqlite-shm'),
    path.join(dataDir, 'providers.json'),
    path.join(dataDir, 'builtin.json'),
    path.join(dataDir, 'paboot.lock'),
    path.join(dataDir, 'attachments'),
  ];
}

function skillRoots(ctx: AppContext, workspace: WorkspaceRow): SkillRoot[] {
  return [
    { source: 'workspace', path: path.join(workspace.path, '.paboot', 'skills') },
    { source: 'user', path: path.join(ctx.config.dataDir, 'skills') },
  ];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Legacy/free-text answer: a bare string or `{ answer: string }`. Kept for older
 * clients; blocking question cards now send structured answers.
 */
function readQuestionAnswer(response: unknown): string | null {
  if (typeof response === 'string' && response.trim().length > 0) return response.trim();
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const answer = (response as Record<string, unknown>)['answer'];
    if (typeof answer === 'string' && answer.trim().length > 0) return answer.trim();
  }
  return null;
}

/** `{ answers: { <questionId>: { answers: string[] } } }` (same shape as Codex). */
function parseStructuredAnswers(response: unknown): Map<string, string[]> | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const answers = (response as Record<string, unknown>)['answers'];
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const parsed = new Map<string, string[]>();
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const list = (value as Record<string, unknown>)['answers'];
    if (!Array.isArray(list)) continue;
    const labels = list
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    if (labels.length > 0) parsed.set(id, labels);
  }
  return parsed;
}

function validateQuestionResponse(
  response: unknown,
  questions: readonly QuestionDto[],
): string | null {
  if (readQuestionAnswer(response)) return null;
  const answers = parseStructuredAnswers(response);
  if (!answers) return 'answers are required';
  for (const question of questions) {
    if (!question.id || !(answers.get(question.id)?.length)) return 'Please answer every question';
  }
  const known = new Set(questions.map((question) => question.id));
  for (const id of answers.keys()) {
    if (!known.has(id)) return 'Unknown question';
  }
  return null;
}

function formatQuestionAnswers(
  questions: readonly QuestionDto[],
  response: unknown,
): string | null {
  const legacy = readQuestionAnswer(response);
  if (legacy) return legacy;
  const answers = parseStructuredAnswers(response);
  if (!answers) return null;
  return questions
    .map((question) => `- ${question.question}：${(answers.get(question.id ?? '') ?? []).join('、')}`)
    .join('\n');
}

/**
 * Wait for a pending permission while honoring run cancellation. On abort the
 * pending slot is denied so it never outlives the run.
 */
function waitForAnswer(
  pending: Promise<{ status: PermissionStatus; response?: unknown }>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<{ status: PermissionStatus; response?: unknown }> {
  if (signal.aborted) {
    onAbort();
    return Promise.resolve({ status: 'denied' });
  }
  return new Promise((resolve) => {
    const abort = (): void => {
      onAbort();
      resolve({ status: 'denied' });
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}
