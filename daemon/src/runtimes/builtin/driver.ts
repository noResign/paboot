import fs from 'node:fs';
import path from 'node:path';

import type { AppContext } from '../../app/context.js';
import type { SessionRow, WorkspaceRow } from '../../db/db.js';
import { log } from '../../platform/log.js';
import type { NormalizedEvent } from '../../types/api.js';
import { existingDirs, workspaceRoots } from '../../workspaces/workspace-service.js';
import type { RuntimeDriver, RuntimeDriverRequest } from '../RuntimeDriver.js';
import { registerActiveRun, type ManagedRun } from '../active-runs.js';
import type { RunOutcome } from '../engine.js';
import type { TranscriptContentBlock } from '../../types/transcript.js';
import { AgentKernel } from './kernel/agent.js';
import { resolveBuiltinModel } from './models.js';
import {
  assembleAgentContext,
  builtinGlobalPromptSections,
  EnvironmentContextSource,
  ProjectDocsContextSource,
  WorkspaceKnowledgeContextSource,
} from './context/index.js';
import { SkillsCatalogContextSource } from './skills/catalog.js';
import type { AgentContextProfile } from './runtime-context.js';
import { createTranscriptStore } from './transcript/store.js';
import { createAttachmentImageResolver, renderTranscriptMessages } from './transcript/render.js';
import { NativeToolProvider } from './tools/native.js';
import { createReadTool } from './tools/read.js';
import { createLoadSkillTool } from './skills/load-tool.js';
import { SkillRegistry, type SkillRoot } from './skills/registry.js';
import { createPermissionBroker } from './tools/permission-broker.js';
import { ToolExecutor } from './tools/executor.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolProvider } from './tools/types.js';
import { createPabootTasksProvider } from './mcp/tasks.js';
import type { AgentProfile, AgentRunContext, PathGrant, ResolvedPathPolicy, ToolDescriptor } from './types.js';
import type { AgentPromptPreset, PromptSectionSpec } from './prompt.js';
import type { RuntimeContextSource } from './runtime-context.js';

const SYSTEM_BUDGET = 16_000;
const RUNTIME_CONTEXT_BUDGET = 8_000;
const MAX_STEPS = 100;
const MAX_TOOL_CALLS = 200;

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

    const skills = new SkillRegistry(skillRoots(ctx, workspace));
    const skillsAvailable = skills.list();
    const profile: AgentProfile = {
      identity: { id: 'builtin', name: 'Builtin', role: 'assistant' },
      instructions: '',
      budgetDefaults: { maxSteps: MAX_STEPS, maxToolCalls: MAX_TOOL_CALLS },
    };
    const preset: AgentPromptPreset = { id: 'builtin-default', version: 1 };
    const presets = new Map([[preset.id, preset]]);
    const contextProfile: AgentContextProfile = {
      agentId: 'builtin',
      promptPreset: preset,
      contextSources: [
        new EnvironmentContextSource(),
        new ProjectDocsContextSource(),
        new WorkspaceKnowledgeContextSource(ctx.knowledge),
        new SkillsCatalogContextSource(skills),
      ],
    };

    const agent = makeAgentContext({
      ctx,
      req,
      session,
      workspace,
      signal,
      attachments: attachments.map((item) => item.id),
    });
    const permissionBroker = createPermissionBroker({
      permissions: ctx.permissions,
      notifier: ctx.notifier,
      grants: ctx.db,
    });
    agent.permissionBroker = permissionBroker;

    const nativeProvider = new NativeToolProvider([
      createReadTool(),
      createLoadSkillTool(skills, {
        allowedSkills: profile.allowedSkills,
      }),
    ]);
    const toolProviders: ToolProvider[] = [nativeProvider];
    if (ctx.mcpServerPath && fs.existsSync(ctx.mcpServerPath)) {
      toolProviders.push(createPabootTasksProvider(ctx, req.runId));
    }
    const toolsRegistry = new ToolRegistry(toolProviders);
    const toolDescriptors = await toolsRegistry.list({ agent, signal });
    const visibleTools = resolved.snapshot.supportsTools ? toolDescriptors : [];
    executor = new ToolExecutor({ registry: toolsRegistry });

    const imageResolver = resolved.snapshot.supportsImages
      ? createAttachmentImageResolver(ctx.attachments)
      : undefined;
    const startedAt = Date.now();
    const assembleContext = async (tools: readonly ToolDescriptor[]) => {
      const promptContext = {
        agent,
        profile,
        preset,
        session: {
          id: session.id,
          workspaceId: workspace.id,
          agentId: 'builtin',
          endId: session.end_id,
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
      return assembleAgentContext({
        profile: contextProfile,
        presets,
        globalSections: builtinGlobalPromptSections(),
        promptContext,
        runtimeContextContext,
        systemBudget: SYSTEM_BUDGET,
        runtimeContextBudget: RUNTIME_CONTEXT_BUDGET,
      });
    };

    const kernel = new AgentKernel({
      provider: resolved.provider,
      model: resolved.model,
      modelSnapshot: resolved.snapshot,
      threadId: thread.id,
      transcript,
      toolDescriptors: visibleTools,
      toolExecutor: executor,
      assembleContext,
      ...(imageResolver ? { resolveImage: imageResolver } : {}),
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
  attachments: string[];
}): AgentRunContext {
  const roots = unique([input.req.cwd, ...(input.req.extraDirs ?? [])]);
  const grants: PathGrant[] = roots.map((root) => ({
    root,
    capabilities: ['read', 'write', 'list'],
  }));
  const knowledgeRoot = input.ctx.knowledge.root(input.workspace.id);
  grants.push({ root: knowledgeRoot, capabilities: ['read', 'list'] });
  const pathPolicy: ResolvedPathPolicy =
    input.req.permissionMode === 'bypass'
      ? { mode: 'bypass', grants: [], denyRoots: [] }
      : { mode: 'server-strict', grants, denyRoots: [] };
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
    extraDirs: existingDirs(workspaceRoots(input.ctx.db, input.workspace).filter((root) => root !== input.req.cwd)),
    pathPolicy,
    permissionMode: input.req.permissionMode,
    signal: input.signal,
    budget: {
      maxSteps: MAX_STEPS,
      maxToolCalls: MAX_TOOL_CALLS,
    },
    eventSink: {
      emit: (event) => input.req.onEvent(event as NormalizedEvent),
    },
    permissionBroker: {
      request: async () => ({ status: 'denied', reason: 'permission broker not configured' }),
    },
  };
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
