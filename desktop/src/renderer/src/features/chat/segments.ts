import type { ContentBlock } from '../../store/chat/types';

/**
 * A run routinely makes a dozen-plus tool calls between two sentences. Rendering
 * one card each buries the prose, so consecutive tool calls collapse into one
 * group row — the group breaks where real text or a thinking card intervenes,
 * not on a timer.
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; active: boolean }
  | { kind: 'question'; toolUseId: string; questions: Extract<ContentBlock, { kind: 'question' }>['questions']; answered: boolean }
  | { kind: 'tools'; tools: Array<Extract<ContentBlock, { kind: 'tool' }>>; key: string };

export function segmentBlocks(blocks: ContentBlock[]): Segment[] {
  const segments: Segment[] = [];
  let group: Array<Extract<ContentBlock, { kind: 'tool' }>> = [];

  const flush = (): void => {
    if (group.length === 0) return;
    const tools = group;
    group = [];
    const key = tools[0]?.id ?? `group-${segments.length}`;
    segments.push({ kind: 'tools', tools, key });
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'tool':
        group.push(block);
        break;
      case 'text':
        flush();
        segments.push({ kind: 'text', text: block.text });
        break;
      case 'thinking':
        flush();
        segments.push({ kind: 'thinking', active: block.active });
        break;
      case 'question':
        flush();
        segments.push({
          kind: 'question',
          toolUseId: block.toolUseId,
          questions: block.questions,
          answered: block.answered,
        });
        break;
    }
  }
  flush();
  return segments;
}

/** `12 个工具调用 · Write, Bash, Read…` */
export function describeToolGroup(tools: Array<Extract<ContentBlock, { kind: 'tool' }>>): string {
  const names: string[] = [];
  for (const tool of tools) {
    if (!names.includes(tool.name)) names.push(tool.name);
  }
  const shown = names.slice(0, 3).join(', ');
  const suffix = names.length > 3 ? '…' : '';
  return `${tools.length} 个工具调用 · ${shown}${suffix}`;
}

/**
 * One-line gist for a tool card's header — the most specific field the input
 * carries, checked in the order the built-ins use them (`command` for Bash,
 * `file_path` for Read/Edit, `pattern` for Grep…). `pattern` deliberately
 * outranks `path`: for Grep/Glob the pattern *is* the gist and the path is only
 * its scope. Returns null when there is nothing worth showing, so the header
 * degrades to just the tool name rather than printing an empty run.
 */
export function toolSummary(input: unknown, limit = 80): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description']) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
  }
  return null;
}

export function toolGroupStatus(tools: Array<Extract<ContentBlock, { kind: 'tool' }>>): {
  running: number;
  failed: number;
  interrupted: number;
} {
  return {
    running: tools.filter((t) => t.running).length,
    failed: tools.filter((t) => t.isError).length,
    interrupted: tools.filter((t) => t.interrupted).length,
  };
}
