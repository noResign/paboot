import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guessContentType, listFiles, parseRange, readFileContent } from '../src/workspaces/file-browser';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-files-'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {}\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, '.secret'), 'hidden\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('file browser', () => {
  it('lists one directory level with hidden and ignored dirs hidden by default', () => {
    const result = listFiles(dir, '');
    expect(result.path).toBe('');
    expect(result.parent).toBeNull();
    expect(result.entries.map((e) => e.path).sort()).toEqual(['README.md', 'src']);
  });

  it('points a top-level directory at the root through an empty parent', () => {
    const result = listFiles(dir, 'src');
    expect(result.path).toBe('src');
    expect(result.parent).toBe('');
  });

  it('returns the parent path for deeper directories', () => {
    fs.mkdirSync(path.join(dir, 'src', 'nested'));
    fs.writeFileSync(path.join(dir, 'src', 'nested', 'deep.ts'), '');
    const result = listFiles(dir, 'src/nested');
    expect(result.path).toBe('src/nested');
    expect(result.parent).toBe('src');
  });

  it('can include hidden and ignored entries', () => {
    const result = listFiles(dir, '', { showHidden: true, showIgnored: true });
    expect(result.entries.map((e) => e.path).sort()).toEqual(['.secret', 'README.md', 'node_modules', 'src']);
  });

  it('paginates entries', () => {
    const first = listFiles(dir, '', { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBe('1');
    const second = listFiles(dir, '', { limit: 1, cursor: first.nextCursor });
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects paths outside workspace', () => {
    expect(() => listFiles(dir, '../outside')).toThrowError(expect.objectContaining({ code: 'path_outside_workspace' }));
    expect(() => listFiles(dir, '/tmp')).toThrowError(expect.objectContaining({ code: 'path_outside_workspace' }));
  });

  it('reads text content and detects binary files', () => {
    const text = readFileContent(dir, 'README.md');
    expect(text.content).toBe('hello\n');
    expect(text.binary).toBe(false);

    const binPath = path.join(dir, 'image.bin');
    fs.writeFileSync(binPath, Buffer.from([0, 1, 2, 3]));
    const binary = readFileContent(dir, 'image.bin');
    expect(binary.binary).toBe(true);
    expect(binary.content).toBe('');
  });
});

describe('guessContentType', () => {
  it('maps image and video extensions, case-insensitively', () => {
    expect(guessContentType('cat.png')).toBe('image/png');
    expect(guessContentType('photo.JPG')).toBe('image/jpeg');
    expect(guessContentType('clip.MP4')).toBe('video/mp4');
    expect(guessContentType('a/b/movie.mov')).toBe('video/quicktime');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(guessContentType('data.bin')).toBe('application/octet-stream');
    expect(guessContentType('LICENSE')).toBe('application/octet-stream');
  });
});

describe('parseRange', () => {
  const size = 1000;

  it('returns null when no usable range was requested', () => {
    expect(parseRange(undefined, size)).toBeNull();
    expect(parseRange('', size)).toBeNull();
    expect(parseRange('bytes=0-1,3-4', size)).toBeNull(); // multi-range: serve full
    expect(parseRange('items=0-1', size)).toBeNull(); // unknown unit
  });

  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=5-', size)).toEqual({ start: 5, end: 999 });
    expect(parseRange('bytes=-500', size)).toEqual({ start: 500, end: 999 });
  });

  it('clamps the end to the last byte', () => {
    expect(parseRange('bytes=0-99999', size)).toEqual({ start: 0, end: 999 });
  });

  it('rejects unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-1200', size)).toBe('invalid'); // start past EOF
    expect(parseRange('bytes=50-10', size)).toBe('invalid'); // start > end
    expect(parseRange('bytes=-0', size)).toBe('invalid'); // zero-length suffix
    expect(parseRange('bytes=0-0', 0)).toBe('invalid'); // empty file
  });
});
