import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDiff, listChanges } from '../src/workspaces/changes';

let dir: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(repoDir: string): void {
  gitIn(repoDir, 'init', '-q');
  gitIn(repoDir, 'config', 'user.email', 'test@example.com');
  gitIn(repoDir, 'config', 'user.name', 'Test');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-changes-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('git changes', () => {
  it('returns non-git workspaces as isGitRepo=false', async () => {
    const result = await listChanges(dir);
    expect(result.isGitRepo).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('lists modified, untracked and renamed files', async () => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one');
    fs.writeFileSync(path.join(dir, 'rename-me.txt'), 'rename');
    git('add', '.');
    git('commit', '-qm', 'init');

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new');
    git('mv', 'rename-me.txt', 'renamed.txt');

    const result = await listChanges(dir);
    expect(result.isGitRepo).toBe(true);
    expect(result.repos).toEqual([]);

    const tracked = result.files.find((f) => f.path === 'tracked.txt');
    expect(tracked).toMatchObject({ status: 'modified', staged: false, additions: 1, deletions: 1 });

    const untracked = result.files.find((f) => f.path === 'untracked.txt');
    expect(untracked).toMatchObject({ status: 'untracked', staged: false });

    const renamed = result.files.find((f) => f.path === 'renamed.txt');
    expect(renamed).toMatchObject({ status: 'renamed', staged: true, oldPath: 'rename-me.txt' });
  });

  it('returns diff for modified and untracked files', async () => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new file\n');

    const tracked = await getDiff(dir, 'tracked.txt');
    expect(tracked.binary).toBe(false);
    expect(tracked.patch).toContain('+two');

    const untracked = await getDiff(dir, 'untracked.txt');
    expect(untracked.status).toBe('untracked');
    expect(untracked.patch).toContain('+new file');
  });

  it('rejects paths outside the workspace', async () => {
    await expect(getDiff(dir, '../outside.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    await expect(getDiff(dir, '/tmp/outside.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
  });
});

describe('non-repo roots', () => {
  it('lists git repos among the direct children when the root is not a repo', async () => {
    fs.mkdirSync(path.join(dir, 'beta'));
    fs.mkdirSync(path.join(dir, 'alpha'));
    fs.mkdirSync(path.join(dir, 'plain'));
    fs.mkdirSync(path.join(dir, '.hidden'));
    initRepo(path.join(dir, 'beta'));
    initRepo(path.join(dir, 'alpha'));

    const result = await listChanges(dir);
    expect(result.isGitRepo).toBe(false);
    expect(result.repos).toEqual(['alpha', 'beta']);
  });

  it('does not look past the direct children', async () => {
    const nested = path.join(dir, 'wrapper', 'inner');
    fs.mkdirSync(nested, { recursive: true });
    initRepo(nested);

    const result = await listChanges(dir);
    expect(result.isGitRepo).toBe(false);
    expect(result.repos).toEqual([]);
  });

  // 原来靠 `dir` 参数「在根之内缩窄范围」，现在客户端改为直接把根换成那个仓库，
  // 于是同一份改动从「根 = repo 的父目录」变成「根 = repo」来取。
  it('reports a child repo as a normal repo once the root is that repo', async () => {
    const repo = path.join(dir, 'alpha');
    fs.mkdirSync(repo);
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'one\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

    const result = await listChanges(repo);
    expect(result.isGitRepo).toBe(true);
    expect(result.repos).toEqual([]);
    expect(result.files.map((f) => f.path)).toEqual(['keep.txt', 'untracked.txt']);

    const diff = await getDiff(repo, 'keep.txt');
    expect(diff.status).toBe('modified');
    expect(diff.patch).toContain('+two');
  });

  it('rejects a root that is missing or not a directory', async () => {
    await expect(listChanges(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'directory_not_found' });

    const file = path.join(dir, 'plain.txt');
    fs.writeFileSync(file, 'x');
    await expect(listChanges(file)).rejects.toMatchObject({ code: 'not_a_directory' });
  });
});
