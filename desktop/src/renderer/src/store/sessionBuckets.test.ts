import { describe, expect, it } from 'vitest';
import { bucketSessions } from './sessionBuckets';
import type { SessionDto } from '../../../shared/contract';

function session(id: string, over: Partial<SessionDto> = {}): SessionDto {
  return {
    id,
    runtime: 'claude',
    workspaceId: 'ws',
    permissionMode: 'ask',
    model: null,
    modelParameters: null,
    cwd: '/p',
    title: id,
    createdAt: 0,
    lastActiveAt: 0,
    running: false,
    runningRunId: null,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('bucketSessions', () => {
  it('keeps a fixed bucket order and sorts within a bucket by recency', () => {
    const now = 100 * DAY;
    const buckets = bucketSessions({
      sessions: [
        session('old-run', { running: true, lastActiveAt: now - 10 * DAY }),
        session('new-run', { running: true, lastActiveAt: now - 60_000 }),
        session('done', { lastActiveAt: now - 10 * DAY }),
      ],
      needsInput: new Set(),
      failed: new Set(),
      now,
    });
    expect(buckets.map((b) => b.id)).toEqual(['needsInput', 'failed', 'rest', 'older']);
    // Running and finished share one list — a running row is marked on the row
    // itself, so it does not need a list of its own. A long-running session is
    // never folded into「更早」, so old-run stays here while done does not.
    expect(buckets[2]?.sessions.map((s) => s.id)).toEqual(['new-run', 'old-run']);
    expect(buckets[3]?.sessions.map((s) => s.id)).toEqual(['done']);
  });

  it('folds non-actionable sessions older than 3 days into「更早」', () => {
    const now = 100 * DAY;
    const buckets = bucketSessions({
      sessions: [
        session('recent', { lastActiveAt: now - 2 * DAY }),
        session('old', { lastActiveAt: now - 3 * DAY - 1 }),
        session('old-waiting', { lastActiveAt: now - 10 * DAY }),
        session('old-running', { running: true, lastActiveAt: now - 10 * DAY }),
      ],
      needsInput: new Set(['old-waiting']),
      failed: new Set(),
      now,
    });
    // Work that needs the user stays visible regardless of age.
    expect(buckets[0]?.sessions.map((s) => s.id)).toEqual(['old-waiting']);
    expect(buckets[2]?.sessions.map((s) => s.id)).toEqual(['recent', 'old-running']);
    expect(buckets[3]?.sessions.map((s) => s.id)).toEqual(['old']);
  });

  it('lets "waiting on me" beat "running" for the same session', () => {
    const buckets = bucketSessions({
      sessions: [session('s1', { running: true })],
      needsInput: new Set(['s1']),
      failed: new Set(),
    });
    expect(buckets[0]?.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(buckets[2]?.sessions).toEqual([]);
  });

  it('puts a failed session above a merely running one', () => {
    const buckets = bucketSessions({
      sessions: [session('run', { running: true }), session('bad')],
      needsInput: new Set(),
      failed: new Set(['bad']),
    });
    expect(buckets[1]?.sessions.map((s) => s.id)).toEqual(['bad']);
    expect(buckets[2]?.sessions.map((s) => s.id)).toEqual(['run']);
  });
});
