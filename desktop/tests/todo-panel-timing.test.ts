import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guard for the todo strip's "no flash" rule.
 *
 * Both halves are invisible to a unit test — they are *where* a value is read,
 * not what it computes — and both are easy to undo by accident while tidying up
 * ("this belongs in an effect"). The failure they prevent is user-visible: a
 * dismissed strip reappearing for a frame, which reads as the app ignoring the
 * user's click.
 */
const PANEL = resolve(import.meta.dirname, '../src/renderer/src/features/chat/TodoPanel.tsx');
const VIEW = resolve(import.meta.dirname, '../src/renderer/src/features/chat/ChatView.tsx');

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('todo panel render timing', () => {
  it('reads the dismissal during the first render, not in an effect', () => {
    const code = source(PANEL);
    // The lazy initializer is the whole point: an effect paints one frame first.
    expect(code).toMatch(/useState<string \| null>\(\(\) =>\s*readTodoDismissal\(/);
    // No effect may write it back either — that would reintroduce the same frame
    // (and would also fight a dismissal the user just made).
    expect(code).not.toMatch(/useEffect\([\s\S]*?setDismissed/);
  });

  it('is keyed by session where it is mounted', () => {
    const code = source(VIEW);
    // Remounting is what makes the initializer read the *new* session's answer.
    // Without the key the component survives a switch and paints the previous
    // session's dismissal for a frame.
    expect(code).toMatch(/<TodoPanel\s+key=\{chat\.sessionId \?\? 'new'\}/);
  });
});
