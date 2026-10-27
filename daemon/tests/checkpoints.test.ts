import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCheckpoint, diffRefs, restoreToRef } from '../src/workspaces/checkpoints';

const dirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-ckpt-'));
  dirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  return dir;
}

function write(dir: string, name: string, text: string): void {
  fs.writeFileSync(path.join(dir, name), text);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkpoints', () => {
  it('snapshots the working tree without touching the real index or HEAD', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    write(dir, 'b.txt', 'keep\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'init']);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();

    // Uncommitted changes: modify a, add new, delete b.
    write(dir, 'a.txt', 'two\n');
    write(dir, 'new.txt', 'hi\n');
    fs.rmSync(path.join(dir, 'b.txt'));

    const before = await captureCheckpoint(dir, 'run-1');
    expect(before).toBeTruthy();

    // The snapshot must not have staged anything or moved HEAD.
    expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(git(dir, ['diff', '--cached', '--name-only']).trim()).toBe('');
    // The working tree is still dirty exactly as we left it.
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
  });

  it('reports the change between two checkpoints', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    write(dir, 'b.txt', 'keep\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'init']);

    const before = (await captureCheckpoint(dir, 'before'))!;
    write(dir, 'a.txt', 'two\n');
    write(dir, 'new.txt', 'hi\n');
    fs.rmSync(path.join(dir, 'b.txt'));
    const after = (await captureCheckpoint(dir, 'after'))!;

    const files = await diffRefs(dir, before, after);
    const byPath = new Map(files.map((f) => [f.path, f.status]));
    expect(byPath.get('a.txt')).toBe('modified');
    expect(byPath.get('new.txt')).toBe('added');
    expect(byPath.get('b.txt')).toBe('deleted');
  });

  it('restores the tree to a checkpoint, deleting files the run added', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    write(dir, 'b.txt', 'keep\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'init']);

    const before = (await captureCheckpoint(dir, 'before'))!;
    write(dir, 'a.txt', 'two\n');
    write(dir, 'new.txt', 'hi\n');
    fs.rmSync(path.join(dir, 'b.txt'));

    await restoreToRef(dir, before);

    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false);
  });
});
