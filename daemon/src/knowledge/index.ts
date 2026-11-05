import path from 'node:path';
import type { ContextSection } from '../context/types.js';
import type { KnowledgeDocument } from './types.js';

// The version marker is the only signal that a body changed without changing
// the title/summary. It breaks prompt cache on body edits by design: freshness
// wins over a cached-but-stale answer.
const VERSION_NOTE =
  '每条末尾的 v= 是该文件的正文版本；需要正文细节时请按路径 Read；版本变化时请重新读取。';
const WORKSPACE_HEADER = `## 工作区知识（按需读取；正文不在上下文里）\n${VERSION_NOTE}`;
const END_HEADER = `## 当前端知识（按需读取；正文不在上下文里）\n${VERSION_NOTE}`;
const REQUIREMENTS_HEADER = `## 关联需求（按需读取；正文不在上下文里）\n${VERSION_NOTE}`;

/**
 * Turn confirmed documents into assembler sections.
 *
 * Only pointers are injected: kind + title + summary + absolute path + a short
 * body version. The body stays on disk so the agent Reads it on demand, and a
 * body edit changes the version marker even when title/summary stay the same.
 * Section sources are stable so a re-assembly with unchanged documents produces
 * a byte-identical block.
 */
export function buildKnowledgeSections(
  root: string,
  documents: readonly KnowledgeDocument[],
): ContextSection[] {
  const workspaceDocs: KnowledgeDocument[] = [];
  const requirementDocs: KnowledgeDocument[] = [];
  const endDocs = new Map<string, KnowledgeDocument[]>();

  for (const doc of documents) {
    if (doc.kind === 'requirement') {
      requirementDocs.push(doc);
      continue;
    }
    if (doc.endId) {
      const list = endDocs.get(doc.endId) ?? [];
      list.push(doc);
      endDocs.set(doc.endId, list);
      continue;
    }
    workspaceDocs.push(doc);
  }

  const sections: ContextSection[] = [];
  appendSection(sections, 'workspace', 'knowledge:workspace', WORKSPACE_HEADER, root, workspaceDocs);
  for (const [endId, docs] of [...endDocs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    appendSection(sections, 'end', `knowledge:end:${endId}`, END_HEADER, root, docs);
  }
  appendSection(
    sections,
    'requirements',
    'knowledge:requirements',
    REQUIREMENTS_HEADER,
    root,
    requirementDocs,
  );
  return sections;
}

function appendSection(
  sections: ContextSection[],
  kind: ContextSection['kind'],
  source: string,
  header: string,
  root: string,
  documents: KnowledgeDocument[],
): void {
  if (documents.length === 0) return;
  const lines = [...documents]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((doc) => {
      const absolute = path.join(root, ...doc.path.split('/'));
      const marker = doc.authority === 'curated' ? '' : '（未核验）';
      // Title + one-line summary + path: enough for the model to decide whether
      // to Read the file, without injecting the body. Collapse whitespace so a
      // hand-edited summary can never break the one-line pointer format.
      const summaryText = doc.summary?.replace(/\s+/g, ' ').trim();
      const summary = summaryText ? ` — ${summaryText}` : '';
      return `- [${doc.kind}] ${doc.title}${marker}${summary} — ${absolute} （v=${bodyVersion(doc)}）`;
    });
  sections.push({
    kind,
    scope: kind === 'end' ? 'end' : 'workspace',
    priority: 0,
    content: [header, ...lines].join('\n'),
    source,
  });
}

/** `sha256:abcd…` → `abcd1234`; stable across runs, changes with the body. */
function bodyVersion(doc: KnowledgeDocument): string {
  const hex = doc.contentHash.startsWith('sha256:') ? doc.contentHash.slice('sha256:'.length) : doc.contentHash;
  return hex.slice(0, 8) || 'unknown';
}
