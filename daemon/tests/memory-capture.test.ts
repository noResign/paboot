import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db, type SessionRow, type WorkspaceRow } from '../src/db/db';
import { filterCaptureText, isPrivate } from '../src/memory/capture-filter';
import { captureRunMessages } from '../src/memory/ingest';
import { resolveRunMemoryScope, shouldCaptureSession } from '../src/memory/scope-resolver';
import { hashContent, MemoryStore } from '../src/memory/store';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name = 'root'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  tmpDirs.push(root);
  return root;
}

function setup(): {
  db: Db;
  store: MemoryStore;
  workspace: WorkspaceRow;
  lifeEndId: string;
} {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace, end } = db.ensureLifeWorkspace(tmpDir('life'));
  return { db, store, workspace, lifeEndId: end.id };
}

function lifeSession(db: Db, workspace: WorkspaceRow, id = 's-life'): SessionRow {
  return db.createSession({
    id,
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
}

function capture(
  store: MemoryStore,
  db: Db,
  session: SessionRow,
  workspace: WorkspaceRow,
  runId = 'r-1',
): number {
  return captureRunMessages({
    store,
    session,
    workspace,
    ends: db.listEnds(workspace.id),
    messages: db.listMessages(session.id),
    runId,
  });
}

describe('capture filter', () => {
  it('removes private and no-memory spans', () => {
    expect(filterCaptureText('<private>密码是 123</private>我搬到上海')).toBe('我搬到上海');
    expect(filterCaptureText('前<no-memory>临时笔记</no-memory>后')).toBe('前后');
  });

  it('removes the injected memory context block', () => {
    const raw = '<paboot-memory-context>\n## 关于你\n- 住在上海\n</paboot-memory-context>今天去看牙';
    expect(filterCaptureText(raw)).toBe('今天去看牙');
  });

  it('returns an empty string when the whole message is excluded', () => {
    expect(filterCaptureText('<private>整条都是私密</private>')).toBe('');
    expect(filterCaptureText('   ')).toBe('');
  });

  it('detects private tags without leaking state across calls', () => {
    expect(isPrivate('a <private>b</private>')).toBe(true);
    expect(isPrivate('normal text')).toBe(false);
    expect(isPrivate('another <private>b</private>')).toBe(true);
  });
});

describe('memory scope resolver', () => {
  it('writes life chats to the life workspace scope and tags the life end', () => {
    const { db, workspace, lifeEndId } = setup();
    const session = lifeSession(db, workspace);
    const scope = resolveRunMemoryScope(session, workspace, db.listEnds(workspace.id), 'run-1');

    expect(scope).toMatchObject({
      scope: `workspace:${workspace.id}`,
      workspaceId: workspace.id,
      endId: lifeEndId,
      sessionId: session.id,
      runId: 'run-1',
    });
  });

  it('does not capture dev workspaces in M0', () => {
    const db = new Db(':memory:');
    dbs.push(db);
    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask');
    if (!dev) throw new Error('expected dev workspace');
    const session = db.createSession({
      id: 's-dev',
      runtime: 'claude',
      workspaceId: dev.id,
      permissionMode: 'ask',
      cwd: dev.path,
    });
    expect(resolveRunMemoryScope(session, dev, db.listEnds(dev.id))).toBeNull();
  });

  it('skips command and task-config sessions, and off-mode chats', () => {
    const { db, workspace } = setup();
    const command = db.createSession({
      id: 's-command',
      runtime: 'command',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
      kind: 'command',
    });
    const authoring = db.createSession({
      id: 's-authoring',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
      purpose: 'task_config',
    });
    const off = lifeSession(db, workspace, 's-off');
    db.setSessionMemoryMode(off.id, 'off');

    expect(shouldCaptureSession(command)).toBe(false);
    expect(shouldCaptureSession(authoring)).toBe(false);
    expect(shouldCaptureSession(db.getSession(off.id) as SessionRow)).toBe(false);
  });

  it('still captures a session set to no_injection', () => {
    const { db, workspace } = setup();
    const session = lifeSession(db, workspace);
    db.setSessionMemoryMode(session.id, 'no_injection');
    expect(resolveRunMemoryScope(session, workspace, db.listEnds(workspace.id))).not.toBeNull();
  });
});

describe('run ingest', () => {
  it('captures user and assistant messages idempotently', () => {
    const { db, store, workspace } = setup();
    const session = lifeSession(db, workspace);
    db.addMessage(session.id, 'user', '我上个月搬到上海了');
    db.addMessage(session.id, 'assistant', '好的，记下了。');

    expect(capture(store, db, session, workspace)).toBe(2);
    const sources = store.listSources(`workspace:${workspace.id}`);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.kind).toBe('message');
    expect(sources[0]?.sourceTable).toBe('messages');
    expect(sources[0]?.sessionId).toBe(session.id);
    expect(sources[0]?.runId).toBe('r-1');

    expect(capture(store, db, session, workspace, 'r-2')).toBe(0);
    expect(store.listSources(`workspace:${workspace.id}`)).toHaveLength(2);
  });

  it('stores filtered text without private spans or injected context', () => {
    const { db, store, workspace } = setup();
    const session = lifeSession(db, workspace);
    db.addMessage(session.id, 'user', '<private>密码</private>我搬到上海');
    db.addMessage(
      session.id,
      'assistant',
      '<paboot-memory-context>注入块</paboot-memory-context>新会话已经记住了。',
    );
    db.addMessage(session.id, 'user', '<private>整条私密</private>');

    expect(capture(store, db, session, workspace)).toBe(2);
    const contents = store
      .listSources(`workspace:${workspace.id}`)
      .map((source) => source.content);
    expect(contents).toEqual(['我搬到上海', '新会话已经记住了。']);
  });

  it('does not re-capture content that has a tombstone', () => {
    const { db, store, workspace } = setup();
    const session = lifeSession(db, workspace);
    db.addMessage(session.id, 'user', '我不吃香菜');
    expect(capture(store, db, session, workspace)).toBe(1);

    store.addTombstone({
      scope: `workspace:${workspace.id}`,
      endId: db.listEnds(workspace.id)[0]?.id ?? null,
      contentHash: hashContent('我不吃香菜'),
      reason: 'forget',
    });

    db.addMessage(session.id, 'user', '我不吃香菜');
    expect(capture(store, db, session, workspace)).toBe(0);
  });

  it('ignores non-chat sessions before touching the store', () => {
    const { db, store, workspace } = setup();
    const session = db.createSession({
      id: 's-command',
      runtime: 'command',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
      kind: 'command',
    });
    db.addMessage(session.id, 'user', 'echo hi');
    expect(capture(store, db, session, workspace)).toBe(0);
    expect(store.countSources('pending')).toBe(0);
  });
});
