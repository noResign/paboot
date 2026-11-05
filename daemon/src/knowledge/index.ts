import path from 'node:path';
import type { ContextSection } from '../context/types.js';
import type { KnowledgeDocument } from './types.js';

const WORKSPACE_HEADER = '## 工作区知识（按需读取；正文不在上下文里）';
const END_HEADER = '## 当前端知识（按需读取；正文不在上下文里）';
const REQUIREMENTS_HEADER = '## 关联需求（按需读取；正文不在上下文里）';

/**
 * Turn confirmed documents into assembler sections.
 *
 * Only pointers are injected: title + kind + summary-free path. The body stays
 * on disk so the agent Reads it on demand (and always gets the latest text).
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
      return `- [${doc.kind}] ${doc.title}${marker} — ${absolute}`;
    });
  sections.push({
    kind,
    scope: kind === 'end' ? 'end' : 'workspace',
    priority: 0,
    content: [header, ...lines].join('\n'),
    source,
  });
}
