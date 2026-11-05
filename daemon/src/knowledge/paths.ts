import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeError, type DocumentKind } from './types.js';

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const END_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SCAN_DEPTH = 8;

/** `<dataDir>/workspaces/<workspaceId>/` — knowledge is never anchored in the code repo. */
export function knowledgeRoot(dataDir: string, workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(dataDir, 'workspaces', workspaceId);
}

export function manifestPath(root: string): string {
  return path.join(root, 'knowledge', '.meta.json');
}

export function assertWorkspaceId(workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new KnowledgeError(`invalid workspace id: ${workspaceId}`, 'knowledge_path_invalid', 400);
  }
  return workspaceId;
}

export function assertEndId(endId: string): string {
  if (!END_ID_PATTERN.test(endId)) {
    throw new KnowledgeError(`invalid end id: ${endId}`, 'knowledge_path_invalid', 400);
  }
  return endId;
}

/** A manifest key is a POSIX relative path without hidden/traversal segments. */
export function isSafeRelativePath(relative: string): boolean {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > 512) return false;
  if (relative.startsWith('/') || relative.endsWith('/')) return false;
  if (relative.includes('\\') || relative.includes('\0')) return false;
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.' || segment === '..') return false;
    if (segment.startsWith('.')) return false;
  }
  return true;
}

export function toAbsolute(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

/**
 * Resolve a manifest key inside the knowledge root.
 *
 * Rejects traversal and, when the root exists, any symlink escape: the nearest
 * existing ancestor is realpath'd before the containment check, so a symlinked
 * file or directory cannot point outside the workspace store.
 */
export function resolveDocumentFile(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new KnowledgeError(`invalid knowledge path: ${relative}`, 'knowledge_path_invalid', 400);
  }
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!isInside(path.resolve(root), absolute)) {
    throw new KnowledgeError(`knowledge path escapes its root: ${relative}`, 'knowledge_path_invalid', 400);
  }
  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);
    const probe = nearestExistingAncestor(absolute);
    const realProbe = fs.realpathSync(probe);
    if (!isInside(realRoot, realProbe)) {
      throw new KnowledgeError(`knowledge path escapes its root: ${relative}`, 'knowledge_path_invalid', 400);
    }
  }
  return absolute;
}

export function ensureKnowledgeRoot(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Recognised knowledge layout. Everything else under the root is ignored:
 * unregistered files still need to be one of these shapes before they can
 * be collected.
 */
export function classifyDocumentPath(relative: string): { kind: DocumentKind; endId: string | null } | null {
  const parts = relative.split('/');
  if (relative === 'WORKSPACE.md') return { kind: 'workspace_context', endId: null };
  if (parts.length === 2 && parts[0] === 'conventions' && parts[1]!.endsWith('.md')) {
    return { kind: 'convention', endId: null };
  }
  if (parts.length === 2 && parts[0] === 'knowledge' && parts[1]!.endsWith('.md')) {
    return { kind: 'note', endId: null };
  }
  if (
    parts.length === 3 &&
    parts[0] === 'ends' &&
    parts[2] === 'CONVENTIONS.md' &&
    END_ID_PATTERN.test(parts[1]!)
  ) {
    return { kind: 'convention', endId: parts[1]! };
  }
  if (
    parts.length === 4 &&
    parts[0] === 'ends' &&
    parts[2] === 'knowledge' &&
    parts[3]!.endsWith('.md') &&
    END_ID_PATTERN.test(parts[1]!)
  ) {
    return { kind: 'tech_doc', endId: parts[1]! };
  }
  if (parts[0] === 'requirements' && relative.endsWith('.md')) {
    return { kind: 'requirement', endId: null };
  }
  return null;
}

/** All recognised markdown files under the root, as POSIX relative paths. */
export function scanDocumentFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  walk(root, '', 0, out);
  out.sort();
  return out;
}

function walk(dir: string, relativeDir: string, depth: number, out: string[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || entry.name === '_trash') continue;
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), relative, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (isSafeRelativePath(relative) && classifyDocumentPath(relative) !== null) out.push(relative);
  }
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

/** Pick a free `knowledge/<slug>.md` or `ends/<id>/knowledge/<slug>.md`. */
export function allocateDocumentPath(root: string, title: string, endId: string | null): string {
  const dirRelative = endId ? `ends/${assertEndId(endId)}/knowledge` : 'knowledge';
  const dir = path.join(root, ...dirRelative.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugify(title);
  for (let index = 1; index <= 100; index += 1) {
    const name = index === 1 ? `${slug}.md` : `${slug}-${index}.md`;
    const relative = `${dirRelative}/${name}`;
    if (!fs.existsSync(toAbsolute(root, relative))) return relative;
  }
  throw new KnowledgeError('could not allocate a unique document filename', 'knowledge_path_conflict', 409);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function nearestExistingAncestor(absolute: string): string {
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return probe;
}
