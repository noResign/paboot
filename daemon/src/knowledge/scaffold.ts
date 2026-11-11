import fs from 'node:fs';
import path from 'node:path';
import { log } from '../platform/log.js';
import { ensureKnowledgeRoot, resolveDocumentFile } from './paths.js';
import type { KnowledgeStore } from './store.js';
import type { DocumentKind } from './types.js';

export interface ScaffoldDocument {
  /** POSIX path relative to the workspace knowledge root. */
  path: string;
  kind: DocumentKind;
  title: string;
  /** First paragraph; also becomes the document summary. */
  description: string;
}

/**
 * Workspaces are not only for development, so the default scaffold is just the
 * universal description document. Conventions / knowledge / requirements are
 * created on demand from the knowledge page.
 */
export const WORKSPACE_KNOWLEDGE_SCAFFOLD: readonly ScaffoldDocument[] = [
  {
    path: 'WORKSPACE.md',
    kind: 'workspace_context',
    title: '工作区说明',
    description: '本工作区的目标、边界、主要入口和必须遵守的约定。',
  },
];

/**
 * Create the default `WORKSPACE.md` for a newly registered workspace. Existing
 * files are never overwritten, so this is also safe for a future "initialize
 * knowledge" action.
 */
export function scaffoldWorkspaceKnowledge(store: KnowledgeStore, workspaceId: string): string[] {
  const created: string[] = [];
  try {
    const root = ensureKnowledgeRoot(store.root(workspaceId));
    for (const doc of WORKSPACE_KNOWLEDGE_SCAFFOLD) {
      const absolute = resolveDocumentFile(root, doc.path);
      if (fs.existsSync(absolute)) continue;
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      const body = `# ${doc.title}\n\n${doc.description}\n`;
      try {
        fs.writeFileSync(absolute, body, { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      created.push(doc.path);
    }
    if (created.length > 0) {
      // A daemon-provided template is trusted content, not an unverified import.
      store.markAuthority(workspaceId, created, 'curated');
      log.info(`workspace ${workspaceId}: created knowledge scaffolding (${created.join(', ')})`);
    }
  } catch (err) {
    // Scaffolding is a convenience; never block workspace creation on it.
    log.warn(`workspace ${workspaceId}: knowledge scaffolding failed`, err);
  }
  return created;
}
