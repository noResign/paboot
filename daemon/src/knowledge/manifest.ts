import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyDocumentPath, isSafeRelativePath, manifestPath } from './paths.js';
import {
  KnowledgeError,
  isDocumentKind,
  isReviewStatus,
  type DocumentAuthority,
  type DocumentOrigin,
  type KnowledgeDocumentMeta,
  type KnowledgeManifest,
  type LastEditedBy,
} from './types.js';

export const MANIFEST_VERSION = 1 as const;

export function emptyManifest(): KnowledgeManifest {
  return { version: MANIFEST_VERSION, documents: {} };
}

/**
 * Read `.meta.json`. A corrupt manifest is moved aside and treated as empty:
 * the next reconcile collects every file again as `confirmed / derived`
 * (unverified) — corruption must never restore `authority=curated`.
 */
export function readManifest(root: string): KnowledgeManifest {
  const file = manifestPath(root);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    backupCorruptManifest(file);
    return emptyManifest();
  }
  if (!isRecord(raw) || raw.version !== MANIFEST_VERSION) {
    throw new KnowledgeError(
      'unsupported knowledge manifest version',
      'knowledge_manifest_version',
      500,
    );
  }

  const documents: Record<string, KnowledgeDocumentMeta> = {};
  if (isRecord(raw.documents)) {
    for (const [relative, value] of Object.entries(raw.documents)) {
      if (!isSafeRelativePath(relative)) continue;
      const meta = normalizeMeta(value);
      if (meta) documents[relative] = meta;
    }
  }
  return { version: MANIFEST_VERSION, documents };
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeManifest(root: string, manifest: KnowledgeManifest): void {
  const file = manifestPath(root);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.meta.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const data = `${JSON.stringify({ version: MANIFEST_VERSION, documents: manifest.documents }, null, 2)}\n`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function hashContent(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/**
 * A file discovered on disk is included immediately, but starts unverified:
 * `authority=derived` is the human-review marker. A user editing or verifying
 * it promotes the entry to `curated`.
 */
export function inferMetadata(relative: string, body: string, now: number): KnowledgeDocumentMeta {
  const classified = classifyDocumentPath(relative);
  if (!classified) {
    throw new KnowledgeError(`not a knowledge document path: ${relative}`, 'knowledge_path_invalid', 400);
  }
  return {
    id: `kn_${randomUUID()}`,
    kind: classified.kind,
    title: titleFromContent(relative, body),
    summary: summaryFromContent(body),
    endId: classified.endId,
    origin: 'user',
    authority: 'derived',
    reviewStatus: 'confirmed',
    tags: [],
    contentHash: hashContent(body),
    createdAt: now,
    updatedAt: now,
    lastEditedBy: 'scan',
  };
}

export function titleFromContent(relative: string, body: string): string {
  const lines = body.replace(/^﻿/, '').split(/\r?\n/);
  for (const line of lines) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) return clamp(match[1].trim(), 120);
  }
  const base = path.posix.basename(relative).replace(/\.md$/i, '');
  return clamp(base.replace(/[-_]+/g, ' ').trim() || 'Untitled', 120);
}

export function summaryFromContent(body: string): string | null {
  const lines = stripFrontmatter(body).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^(```|~~~)/.test(line)) continue;
    if (/^<[^>]+>/.test(line)) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    const text = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^>\s+/, '')
      .replace(/[`*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return clamp(text, 160);
  }
  return null;
}

function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return body;
  const after = body.indexOf('\n', end + 4);
  return after === -1 ? '' : body.slice(after + 1);
}

function normalizeMeta(value: unknown): KnowledgeDocumentMeta | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (!isDocumentKind(value.kind)) return null;
  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  const now = Date.now();
  return {
    id: value.id,
    kind: value.kind,
    title: value.title.trim().slice(0, 200),
    summary: typeof value.summary === 'string' ? value.summary.trim().slice(0, 500) || null : null,
    endId: typeof value.endId === 'string' && value.endId ? value.endId : null,
    origin: isOrigin(value.origin) ? value.origin : 'user',
    authority: isAuthority(value.authority) ? value.authority : 'derived',
    reviewStatus: isReviewStatus(value.reviewStatus) ? value.reviewStatus : 'pending',
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
      : [],
    contentHash: typeof value.contentHash === 'string' ? value.contentHash : '',
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now,
    lastEditedBy: isLastEditedBy(value.lastEditedBy) ? value.lastEditedBy : 'scan',
  };
}

function isOrigin(value: unknown): value is DocumentOrigin {
  return value === 'user' || value === 'agent' || value === 'imported';
}

function isAuthority(value: unknown): value is DocumentAuthority {
  return value === 'curated' || value === 'derived';
}

function isLastEditedBy(value: unknown): value is LastEditedBy {
  return value === 'user' || value === 'agent' || value === 'scan';
}

function backupCorruptManifest(file: string): void {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // If the backup fails, treating the manifest as empty still keeps the
    // daemon usable; the next write replaces the corrupt file.
  }
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
