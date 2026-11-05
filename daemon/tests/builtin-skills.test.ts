import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createLoadSkillTool,
  SkillRegistry,
  SkillsCatalogContextSource,
  type AgentProfile,
  type AgentRunContext,
  type RuntimeContextCollectContext,
  type SkillRoot,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'paboot-skills-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  id: string,
  options: {
    name?: string;
    description?: string;
    whenToUse?: string;
    allowedTools?: string;
    body?: string;
    raw?: string;
  } = {},
): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const raw =
    options.raw ??
    [
      '---',
      `name: ${options.name ?? id}`,
      `description: ${options.description ?? `${id} description`}`,
      ...(options.whenToUse ? [`when-to-use: ${options.whenToUse}`] : []),
      ...(options.allowedTools ? [`allowed-tools: ${options.allowedTools}`] : []),
      '---',
      '',
      options.body ?? `# ${id}\n\nDo the ${id} work.`,
      '',
    ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
}

function setupRegistry(options: { maxFileBytes?: number } = {}): {
  registry: SkillRegistry;
  workspace: string;
  user: string;
  roots: SkillRoot[];
} {
  const workspace = tempDir('paboot-skills-ws-');
  const user = tempDir('paboot-skills-user-');
  const roots: SkillRoot[] = [
    { source: 'workspace', path: workspace },
    { source: 'user', path: user },
  ];
  return { registry: new SkillRegistry(roots, options), workspace, user, roots };
}

function context(allowedSkills?: string[]): RuntimeContextCollectContext {
  const root = tempDir('paboot-skills-repo-');
  const agent: AgentRunContext = {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin' },
    workspace: { id: 'ws-1', name: 'Acme', family: 'dev', root },
    cwd: root,
    extraDirs: [],
    pathPolicy: { mode: 'server-strict', grants: [], denyRoots: [] },
    permissionMode: 'ask',
    signal: new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'denied' }) },
  };
  const profile: AgentProfile = {
    identity: agent.actor,
    instructions: '',
    ...(allowedSkills === undefined ? {} : { allowedSkills }),
  };
  return {
    agent,
    profile,
    session: { id: 'session-1', workspaceId: 'ws-1', agentId: 'builtin', endId: null },
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      supportsTools: true,
      supportsImages: true,
    },
    toolSet: [],
    skillCatalog: [],
    signal: agent.signal,
  };
}

describe('SkillRegistry', () => {
  it('discovers workspace and user skills with workspace override', () => {
    const { registry, workspace, user } = setupRegistry();
    writeSkill(user, 'release', {
      name: 'Release user',
      description: 'User release skill',
      body: 'USER BODY',
    });
    writeSkill(workspace, 'release', {
      name: 'Release workspace',
      description: 'Workspace release skill',
      body: 'WORKSPACE BODY',
    });
    writeSkill(user, 'review', { description: 'Review code' });

    const skills = registry.list();
    expect(skills.map((skill) => skill.id)).toEqual(['release', 'review']);
    expect(skills.find((skill) => skill.id === 'release')?.source).toBe('workspace');
    expect(skills.find((skill) => skill.id === 'review')?.source).toBe('user');
    expect(registry.load('release')).toMatchObject({
      name: 'Release workspace',
      body: 'WORKSPACE BODY',
      source: 'workspace',
    });
  });

  it('parses when-to-use and allowed-tools metadata', () => {
    const { registry, workspace } = setupRegistry();
    writeSkill(workspace, 'release', {
      name: 'Release check',
      description: 'Check release',
      whenToUse: 'before deploy',
      allowedTools: 'Read, Bash',
    });
    const skill = registry.load('release');
    expect(skill).toMatchObject({
      name: 'Release check',
      whenToUse: 'before deploy',
      allowedTools: ['Read', 'Bash'],
    });
    expect(skill?.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('skips malformed, oversized and symlinked skill files', () => {
    const { registry, workspace } = setupRegistry({ maxFileBytes: 120 });
    writeSkill(workspace, 'missing-description', { raw: '---\nname: broken\n---\nbody' });
    writeSkill(workspace, 'too-big', { description: 'x'.repeat(200) });
    writeSkill(workspace, 'ok', { description: 'ok' });

    const outside = tempDir('paboot-skills-outside-');
    const outsideFile = path.join(outside, 'SKILL.md');
    fs.writeFileSync(outsideFile, '---\nname: link\ndescription: linked\n---\nhello');
    fs.mkdirSync(path.join(workspace, 'linked'));
    fs.symlinkSync(outsideFile, path.join(workspace, 'linked', 'SKILL.md'));

    expect(registry.list().map((skill) => skill.id)).toEqual(['ok']);
    expect(registry.load('linked')).toBeNull();
  });

  it('rejects unsafe skill ids and missing skills', () => {
    const { registry } = setupRegistry();
    expect(registry.load('../escape')).toBeNull();
    expect(registry.load('missing')).toBeNull();
  });
});

describe('skill catalog and load_skill', () => {
  it('injects only catalog metadata and filters by allowedSkills', () => {
    const { registry, workspace, user } = setupRegistry();
    writeSkill(workspace, 'release', {
      name: 'Release',
      description: 'Check release',
      whenToUse: 'before deploy',
      body: 'SECRET_BODY',
    });
    writeSkill(user, 'review', { description: 'Review code', body: 'REVIEW_BODY' });

    const all = new SkillsCatalogContextSource(registry).collect(context());
    expect(all[0]?.source).toBe('skills-catalog');
    expect(all[0]?.content).toContain('release');
    expect(all[0]?.content).toContain('when: before deploy');
    expect(all[0]?.content).toContain('review');
    expect(all[0]?.content).not.toContain('SECRET_BODY');
    expect(all[0]?.content).not.toContain('REVIEW_BODY');

    const onlyReview = new SkillsCatalogContextSource(registry).collect(context(['review']));
    expect(onlyReview[0]?.content).toContain('review');
    expect(onlyReview[0]?.content).not.toContain('release');
  });

  it('loads a skill body on demand and enforces the agent allowlist', () => {
    const { registry, workspace } = setupRegistry();
    writeSkill(workspace, 'release', {
      description: 'Check release',
      allowedTools: 'Read, Bash',
      body: 'FULL_SKILL_BODY',
    });

    const allowed = createLoadSkillTool(registry, { allowedSkills: ['release'] });
    const result = allowed.call({ name: 'release' }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('FULL_SKILL_BODY');
    expect(result.content).toContain('allowed tools (advisory): Read, Bash');
    expect(result.meta).toMatchObject({ skillId: 'release', source: 'workspace' });

    const denied = createLoadSkillTool(registry, { allowedSkills: ['other'] });
    expect(() => denied.call({ name: 'release' }, {} as never)).toThrow(/not available/);
    expect(() => createLoadSkillTool(registry).call({ name: 'missing' }, {} as never)).toThrow(/not found/);
  });

  it('returns no catalog contribution when there are no visible skills', () => {
    const { registry } = setupRegistry();
    expect(new SkillsCatalogContextSource(registry).collect(context())).toEqual([]);
  });
});
