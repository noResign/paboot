import { describe, expect, it } from 'vitest';
import { assembleContext } from '../src/context/assembler';
import type { ContextSection, ContextSectionKind } from '../src/context/types';

function section(
  kind: ContextSectionKind,
  source: string,
  content: string,
  priority = 0,
  tokenBudget?: number,
): ContextSection {
  return { kind, scope: 'workspace', priority, tokenBudget, content, source };
}

describe('assembleContext', () => {
  it('orders by kind, then priority desc, then source asc', () => {
    const result = assembleContext(
      [
        section('task', 't', 'task'),
        section('memory', 'm', 'memory'),
        section('workspace', 'w-low', 'low', 1),
        section('workspace', 'w-high', 'high', 10),
        section('workspace', 'w-same', 'same', 1),
      ],
      { runtime: 'builtin', budget: 1000 },
    );

    expect(result.sections.map((item) => item.source)).toEqual([
      'w-high',
      'w-low',
      'w-same',
      'm',
      't',
    ]);
    expect(result.text).toBe('high\n\nlow\n\nsame\n\nmemory\n\ntask');
    expect(result.overBudget).toBe(false);
    expect(result.omitted).toEqual([]);
    // 4 + 3 + 4 + 6 + 4; the `\n\n` separators are not counted.
    expect(result.used).toBe(21);
  });

  it('keeps one section per source and reports the duplicate', () => {
    const result = assembleContext(
      [
        section('workspace', 'same', 'first', 5),
        section('workspace', 'same', 'second', 10),
        section('workspace', 'other', 'other'),
      ],
      { runtime: 'builtin', budget: 1000 },
    );

    expect(result.sections.map((item) => item.content)).toEqual(['second', 'other']);
    expect(result.omitted).toEqual([{ source: 'same', kind: 'workspace', reason: 'duplicate' }]);
  });

  it('drops runtime-owned sections for every non-builtin runtime', () => {
    for (const runtime of ['claude', 'codex', 'deepseek']) {
      const result = assembleContext(
        [section('runtime', `${runtime}:CLAUDE.md`, 'agent rules'), section('workspace', 'w', 'ws')],
        { runtime, budget: 1000 },
      );
      expect(result.sections.map((item) => item.source)).toEqual(['w']);
      expect(result.omitted).toContainEqual({
        source: `${runtime}:CLAUDE.md`,
        kind: 'runtime',
        reason: 'runtime-self-managed',
      });
    }
  });

  it('keeps runtime-owned sections for builtin', () => {
    const result = assembleContext(
      [section('runtime', 'builtin:project', 'CLAUDE.md / AGENTS.md')],
      { runtime: 'builtin', budget: 1000 },
    );
    expect(result.sections.map((item) => item.source)).toEqual(['builtin:project']);
  });

  it('drops empty sections', () => {
    const result = assembleContext(
      [section('workspace', 'empty', '   '), section('workspace', 'w', 'content')],
      { runtime: 'builtin', budget: 1000 },
    );
    expect(result.sections.map((item) => item.source)).toEqual(['w']);
    expect(result.omitted).toEqual([{ source: 'empty', kind: 'workspace', reason: 'empty' }]);
  });

  it('drops a section that exceeds its own cap', () => {
    const result = assembleContext(
      [section('workspace', 'big', 'abcdef', 0, 5), section('workspace', 'ok', 'abc', 0, 5)],
      { runtime: 'builtin', budget: 1000 },
    );
    expect(result.sections.map((item) => item.source)).toEqual(['ok']);
    expect(result.omitted).toEqual([{ source: 'big', kind: 'workspace', reason: 'section-budget' }]);
    expect(result.overBudget).toBe(true);
  });

  it('drops the tail of the order until the total budget fits', () => {
    const sections = [
      section('workspace', 'w', '123456', 10),
      section('memory', 'm', '123456', 1),
    ];

    const fitsMemory = assembleContext(sections, { runtime: 'builtin', budget: 8 });
    expect(fitsMemory.sections.map((item) => item.source)).toEqual(['w']);
    expect(fitsMemory.used).toBe(6);
    expect(fitsMemory.overBudget).toBe(true);
    expect(fitsMemory.omitted).toContainEqual({ source: 'm', kind: 'memory', reason: 'budget' });

    const onlyNothing = assembleContext(sections, { runtime: 'builtin', budget: 4 });
    expect(onlyNothing.sections).toEqual([]);
    expect(onlyNothing.text).toBe('');
    expect(onlyNothing.used).toBe(0);
  });

  it('uses a custom measure when provided (e.g. later tokenizer)', () => {
    const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
    const result = assembleContext([section('workspace', 'w', 'one two three')], {
      runtime: 'builtin',
      budget: 2,
      measure: words,
    });
    expect(result.sections).toEqual([]);
    expect(result.omitted).toEqual([{ source: 'w', kind: 'workspace', reason: 'budget' }]);
  });
});
