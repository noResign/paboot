import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';
import { existingDirs, workspaceContains, workspaceContainsAny, workspaceRoots } from '../src/workspaces/workspace-service';

const dbs: Db[] = [];
const tmpDirs: string[] = [];

function openDb(): Db {
  const db = new Db(':memory:');
  dbs.push(db);
  return db;
}

/** A real directory under a fresh temp root — `seedDefaultWorkspace` realpaths it. */
function tmpDir(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-ws-'));
  tmpDirs.push(root);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed the startup workspace, asserting one was actually created. */
function seed(db: Db) {
  const ws = db.seedDefaultWorkspace(process.cwd(), 'ask');
  if (!ws) throw new Error('expected seedDefaultWorkspace to create a workspace');
  return ws;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Db workspaces + permissions', () => {
  it('seeds a default workspace and filters sessions by workspace', () => {
    const db = openDb();
    const ws = seed(db);
    expect(db.listWorkspaces()).toHaveLength(1);
    expect(db.getDefaultWorkspace()?.id).toBe(ws.id);

    db.createSession({ id: 's-1', runtime: 'claude', workspaceId: ws.id, permissionMode: 'ask', cwd: process.cwd() });
    db.createSession({ id: 's-2', runtime: 'claude', workspaceId: ws.id, permissionMode: 'acceptEdits', cwd: ws.path });

    expect(db.listSessions().map((s) => s.id).sort()).toEqual(['s-1', 's-2']);
    expect(db.listSessions(ws.id).map((s) => s.id).sort()).toEqual(['s-1', 's-2']);
    expect(db.listSessions('other')).toEqual([]);
  });

  it('persists session permission grants', () => {
    const db = openDb();
    const ws = seed(db);
    db.createSession({ id: 's-1', runtime: 'claude', workspaceId: ws.id, permissionMode: 'ask', cwd: ws.path });

    expect(db.hasPermissionGrant('s-1', 'Bash')).toBe(false);
    db.addPermissionGrant('s-1', 'Bash');
    db.addPermissionGrant('s-1', 'Bash'); // idempotent
    expect(db.hasPermissionGrant('s-1', 'Bash')).toBe(true);
    expect(db.listPermissionGrants('s-1').map((g) => g.tool_name)).toEqual(['Bash']);

    db.deletePermissionGrant('s-1', 'Bash');
    expect(db.hasPermissionGrant('s-1', 'Bash')).toBe(false);
  });

  it('allows a subdirectory of an existing workspace as its own workspace', () => {
    const db = openDb();
    const ws = seed(db);
    const childPath = `${ws.path}/child`;

    // Containment still holds (cwd validation relies on it)...
    expect(workspaceContains(ws.path, childPath)).toBe(true);
    // ...but registering the nested path is no longer refused.
    const child = db.createWorkspace({ name: 'child', path: childPath });
    expect(db.listWorkspaces().map((w) => w.path).sort()).toEqual([childPath, ws.path].sort());
    expect(db.getWorkspace(child.id)?.path).toBe(childPath);
  });

  it('deletes permission grants with their session', () => {
    const db = openDb();
    const ws = seed(db);
    db.createSession({ id: 's-1', runtime: 'claude', workspaceId: ws.id, permissionMode: 'ask', cwd: ws.path });
    db.addPermissionGrant('s-1', 'Bash');
    db.deleteSession('s-1');
    expect(db.listPermissionGrants('s-1')).toEqual([]);
  });
});

describe('workspace extra dirs', () => {
  it('stores extra dirs per workspace, idempotently, and cascades on delete', () => {
    const db = openDb();
    const ws = seed(db);
    expect(db.listWorkspaceDirs(ws.id)).toEqual([]);

    db.addWorkspaceDir(ws.id, '/srv/extra');
    db.addWorkspaceDir(ws.id, '/srv/extra'); // idempotent
    db.addWorkspaceDir(ws.id, '/srv/other');
    expect(db.listWorkspaceDirs(ws.id)).toEqual(['/srv/extra', '/srv/other']);
    expect(db.listAllWorkspaceDirs().get(ws.id)).toEqual(['/srv/extra', '/srv/other']);

    db.removeWorkspaceDir(ws.id, '/srv/extra');
    expect(db.listWorkspaceDirs(ws.id)).toEqual(['/srv/other']);

    db.deleteWorkspace(ws.id);
    expect(db.listWorkspaceDirs(ws.id)).toEqual([]);
    expect(db.listAllWorkspaceDirs().size).toBe(0);
  });

  it('keeps granted dirs scoped to their own workspace', () => {
    const db = openDb();
    const a = seed(db);
    const b = db.createWorkspace({ name: 'b', path: `${a.path}/child` });
    db.addWorkspaceDir(a.id, '/srv/extra');

    const rootsA = workspaceRoots(db, db.getWorkspace(a.id)!);
    const rootsB = workspaceRoots(db, db.getWorkspace(b.id)!);
    expect(rootsA).toEqual([a.path, '/srv/extra']);
    expect(rootsB).toEqual([b.path]);

    // The whole point of workspace scope: a grant serves every session under
    // its own workspace, and nothing else.
    expect(workspaceContainsAny(rootsA, '/srv/extra/pkg')).toBe(true);
    expect(workspaceContainsAny(rootsB, '/srv/extra/pkg')).toBe(false);
  });

  it('drops vanished dirs at spawn time without forgetting them in config', () => {
    const cwd = fs.realpathSync(process.cwd());
    expect(existingDirs([process.cwd()])).toEqual([cwd]);
    expect(existingDirs([`${cwd}/definitely-not-here`])).toEqual([]);
  });
});

describe('workspace browse shortcuts', () => {
  it('stores shortcuts separately from granted dirs and cascades on delete', () => {
    const db = openDb();
    const ws = seed(db);
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual([]);

    db.addWorkspaceShortcut(ws.id, '/srv/bookmark');
    db.addWorkspaceShortcut(ws.id, '/srv/bookmark'); // idempotent
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual(['/srv/bookmark']);
    expect(db.listAllWorkspaceShortcuts().get(ws.id)).toEqual(['/srv/bookmark']);

    // 书签不是授权，授权也不是书签：两张表互不影响。
    expect(db.listWorkspaceDirs(ws.id)).toEqual([]);
    db.addWorkspaceDir(ws.id, '/srv/granted');
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual(['/srv/bookmark']);
    expect(db.listWorkspaceDirs(ws.id)).toEqual(['/srv/granted']);

    db.removeWorkspaceShortcut(ws.id, '/srv/bookmark');
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual([]);
    expect(db.listWorkspaceDirs(ws.id)).toEqual(['/srv/granted']);

    db.addWorkspaceShortcut(ws.id, '/srv/bookmark');
    db.deleteWorkspace(ws.id);
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual([]);
    expect(db.listAllWorkspaceShortcuts().size).toBe(0);
  });

  // 先有书签、后把同一目录授权：书签变成多余的，否则 tab 行上会出现两个一样的目录。
  it('drops a bookmark once the same dir gets granted', () => {
    const db = openDb();
    const ws = seed(db);
    db.addWorkspaceShortcut(ws.id, '/srv/x');
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual(['/srv/x']);

    db.addWorkspaceDir(ws.id, '/srv/x');
    expect(db.listWorkspaceDirs(ws.id)).toEqual(['/srv/x']);
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual([]);

    // 只是授权，别的书签不受影响。
    db.addWorkspaceShortcut(ws.id, '/srv/y');
    db.addWorkspaceDir(ws.id, '/srv/z');
    expect(db.listWorkspaceShortcuts(ws.id)).toEqual(['/srv/y']);
  });
});

describe('startup workspace seeding (env / cwd source)', () => {
  // env / cwd 来源是「首次安装的种子」而不是「每次启动都要存在」：以前每次启动都
  // 重建，用户删掉默认工作区后重启它又回来了。
  it('does not resurrect a deleted workspace on the next start', () => {
    const db = openDb();
    const ws = seed(db);
    db.deleteWorkspace(ws.id);

    const again = db.seedDefaultWorkspace(process.cwd(), 'ask');
    expect(again).toBeNull();
    expect(db.listWorkspaces()).toEqual([]);
  });

  it('does not re-add the startup dir when other workspaces exist', () => {
    const db = openDb();
    const first = seed(db);
    const other = db.createWorkspace({ name: 'other', path: '/srv/other' });
    db.deleteWorkspace(first.id);
    // 库层不管默认的重新指派（那是路由做的事），删完就没有默认了。
    expect(db.getDefaultWorkspace()).toBeUndefined();

    // seed 只是把剩下的那个扶成默认，不再把 --workspace 加回来。
    expect(db.seedDefaultWorkspace(process.cwd(), 'ask')?.id).toBe(other.id);
    expect(db.getDefaultWorkspace()?.id).toBe(other.id);
    expect(db.listWorkspaces().map((w) => w.id)).toEqual([other.id]);
  });
});

describe('--workspace flag is authoritative', () => {
  // 连接页填的目录(显式 --workspace)必须每次都成为默认工作区，否则一次更早的
  // 运行会把默认永久锁死到它启动时所在的目录——真实事故：初次使用填了完整路径，
  // 设置页却一直显示启动目录(home)。
  it('repoints the default to the flag dir even when another default exists', () => {
    const db = openDb();
    const home = tmpDir('home');
    const proj = tmpDir('proj');
    const seeded = db.seedDefaultWorkspace(home, 'ask');
    expect(db.getDefaultWorkspace()?.id).toBe(seeded?.id);

    const flagged = db.seedDefaultWorkspace(proj, 'ask', 'flag');
    expect(db.getDefaultWorkspace()?.id).toBe(flagged?.id);
    expect(db.getWorkspaceByPath(fs.realpathSync(proj))?.id).toBe(flagged?.id);
    // 旧的还在，只是不再是默认。
    const paths = db.listWorkspaces().map((w) => w.path).sort();
    expect(paths).toEqual([fs.realpathSync(home), fs.realpathSync(proj)].sort());
  });

  it('reuses the existing row instead of adding a duplicate', () => {
    const db = openDb();
    const dir = tmpDir('proj');
    const first = db.seedDefaultWorkspace(dir, 'ask', 'flag');
    const again = db.seedDefaultWorkspace(dir, 'ask', 'flag');
    expect(again?.id).toBe(first?.id);
    expect(db.listWorkspaces()).toHaveLength(1);
  });

  it('re-enables a disabled default so the flag dir is usable again', () => {
    const db = openDb();
    const dir = tmpDir('proj');
    const ws = db.seedDefaultWorkspace(dir, 'ask', 'flag');
    db.updateWorkspace(ws!.id, { enabled: false });
    expect(db.getDefaultWorkspace()).toBeUndefined();

    const again = db.seedDefaultWorkspace(dir, 'ask', 'flag');
    expect(again?.id).toBe(ws?.id);
    expect(db.getWorkspace(ws!.id)?.enabled).toBe(1);
    expect(db.getDefaultWorkspace()?.id).toBe(ws?.id);
  });
});
