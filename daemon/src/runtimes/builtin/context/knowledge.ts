import type { KnowledgeDocument } from '../../../knowledge/types.js';
import { buildKnowledgeSections } from '../../../knowledge/index.js';
import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';

/** The subset of KnowledgeStore the builtin context source needs. */
export interface KnowledgeContextReader {
  root(workspaceId: string): string;
  confirmed(workspaceId: string, endId: string | null): KnowledgeDocument[];
}

/** K0 confirmed documents, rendered as pointer-only runtime context. */
export class WorkspaceKnowledgeContextSource implements RuntimeContextSource {
  readonly id = 'workspace-knowledge';

  constructor(private readonly knowledge: KnowledgeContextReader) {}

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    if (context.agent.workspace.family !== 'dev') return [];
    const documents = this.knowledge.confirmed(
      context.agent.workspace.id,
      context.session.endId ?? null,
    );
    if (documents.length === 0) return [];
    const sections = buildKnowledgeSections(
      this.knowledge.root(context.agent.workspace.id),
      documents,
    );
    return sections.map((section) => ({
      source: section.source,
      kind: 'knowledge' as const,
      stability: 'dynamic' as const,
      trust: 'workspace' as const,
      priority:
        section.kind === 'requirements' ? 15 : section.kind === 'end' ? 12 : 10,
      content: section.content,
    }));
  }
}
