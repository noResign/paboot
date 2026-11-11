import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { renderContextPrelude } from '../src/context/prelude';
import type { ContextSection } from '../src/context/types';
import { Db } from '../src/db/db';
import { knowledgePrelude } from '../src/runs/knowledge-context';
import { startSessionRun } from '../src/runs/run-service';
import { RunNotifier } from '../src/runs/run-notifier';
import { KnowledgeStore } from '../src/knowledge/store';
import { PermissionManager } from '../src/permissions/permissions';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { defaultCapabilities } from '../src/runtimes/types';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function section(content: string, source = 'knowledge:workspace'): ContextSection {
  return { kind: 'workspace', scope: 'workspace', priority: 0, content, source };
}

describe('renderContextPrelude', () => {
  it('returns null when there is nothing to inject', () => {
    expect(renderContextPrelude([], 'claude')).toBeNull();
    expect(renderContextPrelude([section('   ')], 'claude')).toBeNull();
  });

  it('wraps the assembled content in the stable marker', () => {
    const prelude = renderContextPrelude([section('## Knowledge\n- [note] Build — /x')], 'claude');
    expect(prelude?.prefix).toBe(
      '<paboot-memory-context>\n## Knowledge\n- [note] Build — /x\n</paboot-memory-context>',
    );
    expect(prelude?.overBudget).toBe(false);
  });

  it('reports truncation instead of cutting a section in half', () => {
    const prelude = renderContextPrelude(
      [section('a'.repeat(80), 'source-a'), section('b'.repeat(80), 'source-b')],
      'claude',
      100,
    );
    expect(prelude?.overBudget).toBe(true);
    expect(prelude?.prefix).not.toContain('b'.repeat(80));
    expect(prelude?.omitted).toBe(1);
  });
});

interface Harness {
  db: Db;
  knowledge: KnowledgeStore;
  workspacePath: string;
  workspaceId: string;
  dataDir: string;
  ctx: AppContext;
}

function harness(family: 'dev' | 'life' = 'dev', nativeSystemPrompt = false): Harness {
  const dataDir = tempDir('paboot-kn-inject-data-');
  const workspacePath = tempDir('paboot-kn-inject-ws-');
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath, family });
  const knowledge = new KnowledgeStore(dataDir);
  const ctx = {
    config: { dataDir },
    db,
    knowledge,
    notifier: new RunNotifier(),
    permissions: new PermissionManager(1000, () => {}),
    registry: {
      detection: () => ({
        capabilities: { ...defaultCapabilities, nativeSystemPrompt: nativeSystemPrompt },
      }),
    },
  } as unknown as AppContext;
  return { db, knowledge, workspacePath, workspaceId: workspace.id, dataDir, ctx };
}

function setSessionEnd(db: Db, sessionId: string, endId: string): void {
  (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    .prepare('UPDATE sessions SET end_id = ? WHERE id = ?')
    .run(endId, sessionId);
}

function createSession(h: Harness, runtime = 'claude') {
  return h.db.createSession({
    id: `session-${runtime}-${Math.random().toString(36).slice(2)}`,
    runtime,
    workspaceId: h.workspaceId,
    permissionMode: 'ask',
    cwd: h.workspacePath,
  });
}

describe('knowledgePrelude', () => {
  it('injects confirmed pointers into a fresh session', () => {
    const h = harness();
    h.knowledge.create(h.workspaceId, {
      title: 'Build',
      body: '# Build\n\nUse pnpm.',
      kind: 'convention',
    });
    const session = createSession(h);
    const workspace = h.db.getWorkspace(h.workspaceId)!;

    const prelude = knowledgePrelude(h.ctx, session, workspace);
    expect(prelude?.documents).toBe(1);
    expect(prelude?.prefix).toContain('<paboot-memory-context>');
    expect(prelude?.prefix).toContain('- [convention] Build —');
    expect(prelude?.prefix).toContain(path.join(h.dataDir, 'workspaces', h.workspaceId));
  });

  it('does not inject on resume, for command sessions, or for life', () => {
    const h = harness();
    h.knowledge.create(h.workspaceId, { title: 'Build', body: '# Build', kind: 'convention' });
    const session = createSession(h);
    const workspace = h.db.getWorkspace(h.workspaceId)!;

    h.db.setNativeSessionId(session.id, 'native-1');
    expect(knowledgePrelude(h.ctx, h.db.getSession(session.id)!, workspace)).toBeNull();

    const command = createSession(h, 'command');
    expect(knowledgePrelude(h.ctx, command, workspace)).toBeNull();

    const life = harness('life');
    life.knowledge.create(life.workspaceId, { title: 'Life', body: '# Life', kind: 'note' });
    const lifeSession = createSession(life);
    const lifeWorkspace = life.db.getWorkspace(life.workspaceId)!;
    expect(knowledgePrelude(life.ctx, lifeSession, lifeWorkspace)).toBeNull();
  });

  it('drops end-scoped knowledge once the end is archived', () => {
    const h = harness();
    const end = h.db.createEnd({
      workspaceId: h.workspaceId,
      family: 'dev',
      kind: 'android',
      name: 'Pixel',
      status: 'active',
    });
    h.db.addEndRoot(end.id, h.workspacePath);
    h.knowledge.create(h.workspaceId, {
      title: 'Android',
      body: '# Android',
      kind: 'convention',
      endId: end.id,
    });
    const session = createSession(h);
    setSessionEnd(h.db, session.id, end.id);
    const workspace = h.db.getWorkspace(h.workspaceId)!;

    const before = knowledgePrelude(h.ctx, h.db.getSession(session.id)!, workspace);
    expect(before?.documents).toBe(1);
    expect(before?.prefix).toContain('Android');

    h.db.setEndStatus(end.id, 'archived');
    expect(knowledgePrelude(h.ctx, h.db.getSession(session.id)!, workspace)).toBeNull();
  });

  it('skips builtin because it has no provider-native session id (P3 uses the assembler)', () => {
    const h = harness();
    h.knowledge.create(h.workspaceId, { title: 'Build', body: '# Build', kind: 'convention' });
    const session = createSession(h, 'builtin');
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    expect(knowledgePrelude(h.ctx, session, workspace)).toBeNull();
  });

  it('keeps injecting for task_config sessions by decision', () => {
    const h = harness();
    h.knowledge.create(h.workspaceId, { title: 'Build', body: '# Build', kind: 'convention' });
    const session = h.db.createSession({
      id: 'session-task-config',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: h.workspacePath,
      purpose: 'task_config',
    });
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const prelude = knowledgePrelude(h.ctx, session, workspace);
    expect(prelude?.documents).toBe(1);
    expect(prelude?.prefix).toContain('<paboot-memory-context>');
  });

  it('includes unverified documents and marks them in the pointer', () => {
    const h = harness();
    const root = h.knowledge.root(h.workspaceId);
    fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(root, 'knowledge', 'build.md'), '# Build\n\nScanned.');
    const session = createSession(h);
    const workspace = h.db.getWorkspace(h.workspaceId)!;

    const prelude = knowledgePrelude(h.ctx, session, workspace);
    expect(prelude?.documents).toBe(1);
    expect(prelude?.prefix).toContain('- [note] Build（未核验） — ');
  });

  it('changes the version marker when only the body changes', () => {
    const h = harness();
    const created = h.knowledge.create(h.workspaceId, {
      title: 'Build',
      body: '# Build\n\nUse pnpm.',
      kind: 'convention',
    });
    const session = createSession(h);
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const version = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 8);

    const first = knowledgePrelude(h.ctx, session, workspace);
    expect(first?.prefix).toContain(`（v=${version(created.contentHash)}）`);

    h.knowledge.update(h.workspaceId, created.id, {
      body: '# Build\n\nUse pnpm.\n\nAppended line.',
      summary: created.summary,
    });
    const updated = h.knowledge.get(h.workspaceId, created.id);
    const second = knowledgePrelude(h.ctx, session, workspace);

    expect(second?.prefix).toContain(`（v=${version(updated.contentHash)}）`);
    expect(second?.prefix).not.toBe(first?.prefix);
    expect(second?.indexVersion).not.toBe(first?.indexVersion);
  });

  it('never blocks the run when the knowledge store is broken', () => {
    const h = harness();
    const root = h.knowledge.root(h.workspaceId);
    fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(root, 'knowledge', '.meta.json'), '{"version":99,"documents":{}}');
    fs.writeFileSync(path.join(root, 'knowledge', 'build.md'), '# Build\n\nPending.');
    const session = createSession(h);
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    expect(knowledgePrelude(h.ctx, session, workspace)).toBeNull();
  });
});

describe('run-service knowledge injection', () => {
  it('sends the prefixed prompt to the runtime but stores the raw prompt', async () => {
    const h = harness();
    h.knowledge.create(h.workspaceId, {
      title: 'Build',
      body: '# Build\n\nUse pnpm.',
      kind: 'convention',
    });
    const session = h.db.createSession({
      id: 'session-run',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: h.workspacePath,
    });
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const starts: RuntimeDriverRequest[] = [];
    const driver: RuntimeDriver = {
      id: 'claude',
      start(req) {
        starts.push(req);
        return {
          id: req.runId,
          promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
          cancel: () => {},
        };
      },
    };

    const run = startSessionRun(h.ctx, {
      session,
      workspace,
      prompt: 'hello',
      driver,
      permissionMode: 'ask',
      model: null,
      modelParameters: null,
      trigger: 'user',
      commandId: null,
      sink: { frame: () => {}, end: () => {} },
    });
    await run.done;

    expect(starts[0]?.prompt).toContain('<paboot-memory-context>');
    expect(starts[0]?.prompt).toContain('- [convention] Build —');
    expect(starts[0]?.prompt?.endsWith('\n\nhello')).toBe(true);
    expect(h.db.listMessages(session.id).find((message) => message.role === 'user')?.content).toBe('hello');
    expect(h.db.listRuns(session.id)[0]?.prompt).toBe('hello');
  });

  it('passes knowledge as a native system prompt when the runtime supports it', async () => {
    const h = harness('dev', true);
    h.knowledge.create(h.workspaceId, {
      title: 'Build',
      body: '# Build\n\nUse pnpm.',
      kind: 'convention',
    });
    const session = h.db.createSession({
      id: 'session-native',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: h.workspacePath,
    });
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const starts: RuntimeDriverRequest[] = [];
    const driver: RuntimeDriver = {
      id: 'claude',
      start(req) {
        starts.push(req);
        return {
          id: req.runId,
          promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
          cancel: () => {},
        };
      },
    };

    await startSessionRun(h.ctx, {
      session,
      workspace,
      prompt: 'hello',
      driver,
      permissionMode: 'ask',
      model: null,
      modelParameters: null,
      trigger: 'user',
      commandId: null,
      sink: { frame: () => {}, end: () => {} },
    }).done;

    expect(starts[0]?.prompt).toBe('hello');
    expect(starts[0]?.systemContext).toContain('<paboot-memory-context>');
    expect(starts[0]?.systemContext).toContain('- [convention] Build — Use pnpm.');
    expect(h.db.listMessages(session.id).find((message) => message.role === 'user')?.content).toBe('hello');
  });

  it('does not re-inject when the session already has a native id', async () => {
    const h = harness();
    h.knowledge.create(h.workspaceId, { title: 'Build', body: '# Build', kind: 'convention' });
    const session = h.db.createSession({
      id: 'session-resume',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: h.workspacePath,
    });
    h.db.setNativeSessionId(session.id, 'native-1');
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const starts: RuntimeDriverRequest[] = [];
    const driver: RuntimeDriver = {
      id: 'claude',
      start(req) {
        starts.push(req);
        return {
          id: req.runId,
          promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
          cancel: () => {},
        };
      },
    };

    await startSessionRun(h.ctx, {
      session: h.db.getSession(session.id)!,
      workspace,
      prompt: 'again',
      driver,
      permissionMode: 'ask',
      model: null,
      modelParameters: null,
      trigger: 'user',
      commandId: null,
      sink: { frame: () => {}, end: () => {} },
    }).done;

    expect(starts[0]?.prompt).toBe('again');
  });
});
