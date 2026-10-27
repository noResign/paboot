import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_CONTENT_BYTES = 1024 * 1024;
export const IGNORED_DIRS = new Set([
  '.git',
  '.gradle',
  '.idea',
  '.next',
  '.nuxt',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

export type FileEntryType = 'file' | 'directory';

export interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
  modifiedAt: number | null;
}

export interface FilesResult {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  nextCursor: string | null;
}

export interface FileContentResult {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

export class FileBrowserError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

function insideWorkspace(workspacePath: string, absolute: string): boolean {
  const rel = path.relative(workspacePath, absolute);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toWire(relativePath: string): string {
  return relativePath.split(path.sep).filter(Boolean).join('/');
}

function resolveRelative(workspacePath: string, raw: string): string {
  if (path.isAbsolute(raw)) {
    throw new FileBrowserError('path must be relative to workspace', 'path_outside_workspace', 400);
  }
  const absolute = raw ? path.resolve(workspacePath, raw) : workspacePath;
  if (!insideWorkspace(workspacePath, absolute)) {
    throw new FileBrowserError('path is outside workspace', 'path_outside_workspace', 400);
  }
  return absolute;
}

function parseCursor(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function checkDirectory(workspacePath: string, absolute: string): { real: string; wire: string } {
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new FileBrowserError('directory not found', 'directory_not_found', 404);
  }
  if (!insideWorkspace(workspacePath, real)) {
    throw new FileBrowserError('path is outside workspace', 'path_outside_workspace', 400);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new FileBrowserError('directory not found', 'directory_not_found', 404);
  }
  if (!stat.isDirectory()) {
    throw new FileBrowserError('path is not a directory', 'not_a_directory', 400);
  }
  const wire = path.relative(workspacePath, absolute);
  return { real, wire: toWire(wire) };
}

export function listFiles(
  workspacePath: string,
  relativePath: string,
  options: { cursor?: unknown; limit?: unknown; showHidden?: boolean; showIgnored?: boolean } = {},
): FilesResult {
  const absolute = resolveRelative(workspacePath, relativePath);
  const current = checkDirectory(workspacePath, absolute);
  const offset = parseCursor(options.cursor);
  const limit = parseLimit(options.limit);
  const showHidden = options.showHidden === true;
  const showIgnored = options.showIgnored === true;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(current.real, { withFileTypes: true });
  } catch {
    throw new FileBrowserError('directory not readable', 'directory_not_readable', 403);
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (!name || name === '.' || name === '..') continue;
    if (!showHidden && name.startsWith('.')) continue;
    if (dirent.isSymbolicLink()) continue; // 不跟随 symlink，避免越界与循环
    const isDirectory = dirent.isDirectory();
    if (isDirectory && !showIgnored && IGNORED_DIRS.has(name)) continue;

    const childAbs = path.join(current.real, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(childAbs);
    } catch {
      continue;
    }
    const childWire = current.wire ? `${current.wire}/${name}` : name;
    entries.push({
      name,
      path: childWire,
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory ? null : stat.size,
      modifiedAt: Math.round(stat.mtimeMs),
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const page = entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  // Root has no parent (`null`); every other directory points at its parent
  // relative to the root, with the root itself represented by an empty string.
  const parentWire = current.wire ? toWire(path.dirname(current.wire)) : null;
  return {
    path: current.wire,
    parent: parentWire === '.' ? '' : parentWire,
    entries: page,
    nextCursor: nextOffset < entries.length ? String(nextOffset) : null,
  };
}

export function resolveFile(workspacePath: string, relativePath: string): { absolute: string; wire: string } {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new FileBrowserError('path must be a relative file path', 'path_outside_workspace', 400);
  }
  const absolute = resolveRelative(workspacePath, relativePath);
  if (absolute === workspacePath) {
    throw new FileBrowserError('path is not a file', 'not_a_file', 400);
  }
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new FileBrowserError('file not found', 'file_not_found', 404);
  }
  if (!insideWorkspace(workspacePath, real)) {
    throw new FileBrowserError('path is outside workspace', 'path_outside_workspace', 400);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new FileBrowserError('file not found', 'file_not_found', 404);
  }
  if (!stat.isFile()) {
    throw new FileBrowserError('path is not a file', 'not_a_file', 400);
  }
  return { absolute: real, wire: toWire(relativePath) };
}

export function readFileContent(workspacePath: string, relativePath: string): FileContentResult {
  const resolved = resolveFile(workspacePath, relativePath);
  const stat = fs.statSync(resolved.absolute);
  const readSize = Math.min(stat.size, MAX_CONTENT_BYTES);
  const fd = fs.openSync(resolved.absolute, 'r');
  let data: Buffer;
  try {
    const buffer = Buffer.alloc(readSize);
    const bytes = fs.readSync(fd, buffer, 0, readSize, 0);
    data = buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
  const binary = data.includes(0);
  return {
    path: resolved.wire,
    size: stat.size,
    binary,
    truncated: stat.size > readSize,
    content: binary ? '' : data.toString('utf8'),
  };
}

/**
 * Content-Type for `/api/files/raw`. Only browsers/players need this — the byte
 * stream itself is type-agnostic — so the map stops at image/video and anything
 * else degrades to `application/octet-stream` (players then rely on sniffing).
 */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
};

export function guessContentType(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

/**
 * Parse a single-range `Range: bytes=…` header against a known file size.
 *
 * - `null`      → no range asked for, or one we don't handle (multi-range,
 *                 unknown unit): the caller serves the whole file with 200.
 * - `'invalid'` → a range was asked for but is unsatisfiable: caller sends 416.
 * - `{start,end}` → inclusive offsets to serve with 206.
 *
 * Open-ended (`bytes=5-`) and suffix (`bytes=-500`) forms are supported; the
 * end is clamped to the last byte, and a start past EOF is rejected.
 */
export function parseRange(header: unknown, size: number): ByteRange | 'invalid' | null {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // unknown unit or multi-range → serve the full body
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (size === 0) return 'invalid';

  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return 'invalid';
    if (start >= size) return 'invalid';
    if (end >= size) end = size - 1;
  }
  return { start, end };
}
