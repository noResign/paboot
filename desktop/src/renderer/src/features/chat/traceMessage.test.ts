import { describe, expect, it } from 'vitest';
import { pickTraceMessage } from './traceMessage';

/**
 * The pane used to render `live ?? trace` and clear the stale snapshot in an
 * effect. Effects run after paint, so the frame right after switching runs
 * still had the *previous* agent's trace on screen — reported as "it shows the
 * last agent until I click again".
 */

interface Trace {
  runId?: string | null;
  text: string;
}

const a: Trace = { runId: 'run-a', text: 'A 的轨迹' };
const b: Trace = { runId: 'run-b', text: 'B 的轨迹' };

describe('pickTraceMessage', () => {
  it('shows the fetched trace that belongs to the open run', () => {
    expect(pickTraceMessage(null, b, 'run-b')).toBe(b);
  });

  it('never shows a snapshot from another run', () => {
    // The bug: switching to B while `trace` still held A's snapshot.
    expect(pickTraceMessage(null, a, 'run-b')).toBeNull();
  });

  it('prefers the live answer for the same run', () => {
    const live = { runId: 'run-b', message: b };
    expect(pickTraceMessage(live, a, 'run-b')).toBe(b);
  });

  it('shows nothing before the first fetch resolves', () => {
    expect(pickTraceMessage(null, null, 'run-b')).toBeNull();
  });

  it('rejects a live answer that belongs to another run', () => {
    // Today's caller only ever passes the right one, but the guard must not
    // depend on that: a new entry point would otherwise show another agent's
    // live trace.
    expect(pickTraceMessage({ runId: 'run-a', message: a }, null, 'run-b')).toBeNull();
  });

  it('treats a snapshot without a runId as unstamped, not as a match', () => {
    // Guards against a future builder that forgets to stamp the run.
    expect(pickTraceMessage<{ runId?: string | null; text: string }>(null, { text: '无来源' }, 'run-b')).toBeNull();
  });
});
