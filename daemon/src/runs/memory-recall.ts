import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import type { ContextSection } from '../context/types.js';
import {
  claimAllowed,
  resolveReadPolicy,
  scopeAllowsSensitivity,
} from '../memory/read-policy.js';
import { recallQuery, shouldRecall } from '../memory/recall.js';
import { isMemoryInjectionEnabled } from '../memory/settings.js';
import { log } from '../platform/log.js';

export interface RunMemoryRecall extends ContextPrelude {
  hits: number;
}

const MAX_RECALL_CHARS = 800;
const MAX_RECALL_ITEMS = 5;

/**
 * Search memory when the prompt explicitly refers to the past. Results follow
 * the same read policy as the brief; `source` hits stay out (raw message text
 * is too noisy for an automatic injection).
 */
export function memoryRecall(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
  prompt: string,
): RunMemoryRecall | null {
  if (!ctx.memory) return null;
  if (session.runtime === 'command' || session.runtime === 'builtin') return null;
  if (session.purpose === 'task_config') return null;
  if (session.memory_mode !== 'normal') return null;
  const cue = shouldRecall(prompt);

  try {
    const settings = ctx.db.getMemorySettings(workspace.id);
    if (!isMemoryInjectionEnabled(workspace, settings)) return null;
    const policy = resolveReadPolicy({
      workspace,
      workspaces: ctx.db.listWorkspaces(),
      getSettings: (workspaceId) => ctx.db.getMemorySettings(workspaceId),
    });
    if (policy.scopes.length === 0) return null;
    const query = recallQuery(prompt);
    const terms = query.split(' ').filter((term) => Array.from(term).length >= 2);
    if (query === '' && !cue) return null;

    const hits =
      query === ''
        ? []
        : ctx.memory.searchMemory({
            scopes: policy.scopes.map((item) => item.scope),
            query,
            limit: 16,
          });

    const lines: string[] = [];
    const seen = new Set<string>();
    // Open loops are the best continuation hint when another session left work
    // unfinished; include up to two before regular hits.
    for (const readScope of policy.scopes) {
      if (lines.length >= 2) break;
      for (const loop of ctx.memory.listOpenLoops(readScope.scope)) {
        if (!cue && !isRelevant(loop.title, terms)) continue;
        lines.push(`- [未完成] ${compact(loop.title, 120)} #loop_${short(loop.id)}`);
        if (lines.length >= 2) break;
      }
    }
    for (const hit of hits) {
      if (lines.length >= MAX_RECALL_ITEMS) break;
      const key = `${hit.kind}:${hit.refId}`;
      if (seen.has(key)) continue;
      // Explicit cues may recall broadly; without one, require a real term hit
      // so unrelated new sessions do not get another session's timeline.
      if (!cue && !isRelevant(hit.text, terms)) continue;
      const line = renderHit(ctx, hit, policy);
      if (!line) continue;
      seen.add(key);
      lines.push(line);
    }
    if (lines.length === 0) return null;
    const content = trimLines('## 相关记忆\n以下按需核对；与当前说法冲突时以当前为准。', lines, MAX_RECALL_CHARS);
    const section: ContextSection = {
      kind: 'memory',
      scope: 'workspace',
      priority: 0,
      content,
      source: 'memory:recall',
    };
    const prelude = renderContextPrelude([section], session.runtime);
    if (!prelude) return null;
    log.info(`memory recall: ${lines.length} hit(s) for ${session.runtime}`);
    return { ...prelude, hits: lines.length };
  } catch (err) {
    log.warn(`memory recall failed for workspace ${workspace.id}: ${String(err)}`);
    return null;
  }
}

function renderHit(
  ctx: AppContext,
  hit: { kind: string; refId: string },
  policy: ReturnType<typeof resolveReadPolicy>,
): string | null {
  if (hit.kind === 'claim') {
    const claim = ctx.memory!.getClaim(hit.refId);
    if (!claim || claim.status !== 'active' || !claimAllowed(claim, policy)) return null;
    return `- [记忆] ${compact(claim.summary, 200)} #claim_${short(claim.id)}`;
  }
  if (hit.kind === 'observation') {
    const observation = ctx.memory!.getObservation(hit.refId);
    if (
      !observation ||
      observation.status !== 'active' ||
      !scopeAllowsSensitivity(policy, observation.scope, observation.sensitivity)
    ) {
      return null;
    }
    return `- [最近] ${compact(observation.title, 120)}（${observation.type}）` +
      ` #obs_${short(observation.id)}`;
  }
  if (hit.kind === 'summary') {
    const summary = ctx.memory!.getSessionSummary(hit.refId);
    if (!summary || !scopeAllowsSensitivity(policy, summary.scope, summary.sensitivity)) return null;
    const detail = summary.completed !== '' ? ` — ${compact(summary.completed, 160)}` : '';
    return `- [摘要] ${compact(summary.request, 100)}${detail} #sum_${short(summary.id)}`;
  }
  if (hit.kind === 'document') {
    const document = ctx.memory!.getDocument(hit.refId);
    if (
      !document ||
      document.reviewStatus === 'missing' ||
      !scopeAllowsSensitivity(policy, document.scope, document.sensitivity)
    ) {
      return null;
    }
    return `- [文档] ${compact(document.title, 120)} — ${document.path}`;
  }
  return null;
}

function trimLines(header: string, lines: readonly string[], maxChars: number): string {
  const kept: string[] = [];
  let length = Array.from(header).length;
  for (const line of lines) {
    const size = Array.from(line).length + 1;
    if (length + size > maxChars && kept.length > 0) break;
    kept.push(line);
    length += size;
  }
  return [header, ...kept].join('\n');
}

function isRelevant(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  let matched = 0;
  let strong = false;
  for (const term of terms) {
    if (!haystack.includes(term.toLowerCase())) continue;
    matched += 1;
    if (Array.from(term).length >= 3) strong = true;
  }
  return strong || matched >= 2;
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length <= max ? normalized : `${chars.slice(0, max - 1).join('')}…`;
}

function short(id: string): string {
  return id.replace(/-/g, '').slice(0, 4);
}
