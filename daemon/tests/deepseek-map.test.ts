import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../src/types/api';
import { createDeepSeekStreamMapper, mapToolName } from '../src/runtimes/deepseek/map';

function collect(updates: unknown[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const mapper = createDeepSeekStreamMapper((ev) => events.push(ev));
  for (const update of updates) mapper.onUpdate(update);
  return events;
}

describe('deepseek ACP updates → NormalizedEvent', () => {
  it('starts a thinking card once per message and streams text separately', () => {
    const events = collect([
      { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'plan' } },
      { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: ' more' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'hello' } },
    ]);

    expect(events).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'plan' },
      { type: 'thinking_delta', delta: ' more' },
      { type: 'text_delta', delta: 'hello' },
    ]);
  });

  it('maps the tool lifecycle and keeps the raw name for approval enrichment', () => {
    const events: NormalizedEvent[] = [];
    const mapper = createDeepSeekStreamMapper((ev) => events.push(ev));

    mapper.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'bash',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    });
    mapper.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    });

    expect(events).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
    ]);
    expect(mapper.toolCall('t1')).toEqual({ name: 'bash', input: { command: 'ls' } });
  });

  it('ignores in-progress tool updates and flags failed results', () => {
    const events = collect([
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'edit', status: 'in_progress', rawInput: {} },
      { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', content: [] },
    ]);

    expect(events).toEqual([
      { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
      { type: 'tool_result', toolUseId: 't2', content: '', isError: true },
    ]);
  });

  it('reports context occupancy and USD cost from usage updates', () => {
    const events = collect([
      { sessionUpdate: 'usage_update', used: 1200, size: 234_000, cost: { amount: 0.03, currency: 'USD' } },
    ]);

    expect(events).toEqual([
      {
        type: 'usage',
        usage: null,
        contextTokens: 1200,
        contextWindow: 234_000,
        costUsd: 0.03,
      },
    ]);
  });
});

describe('deepseek tool names', () => {
  it('maps DSH names to the labels clients branch on', () => {
    expect(mapToolName('bash')).toBe('Bash');
    expect(mapToolName('write')).toBe('Write');
    expect(mapToolName('edit')).toBe('Edit');
    expect(mapToolName('web_search')).toBe('WebSearch');
  });

  it('leaves MCP tools in their grant-key spelling', () => {
    expect(mapToolName('mcp__paboot_tasks__schedule_task')).toBe('mcp__paboot_tasks__schedule_task');
  });
});
