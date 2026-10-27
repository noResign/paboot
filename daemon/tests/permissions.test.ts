import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionManager } from '../src/permissions/permissions';
import { RunNotifier } from '../src/runs/run-notifier';

describe('PermissionManager', () => {
  afterEach(() => vi.useRealTimers());

  it('creates a pending permission and resolves it', () => {
    const pm = new PermissionManager(60_000);
    const p = pm.create('run-1', 'session-1', 'Bash', { command: 'ls' });
    expect(p.status).toBe('pending');
    expect(p.sessionId).toBe('session-1');
    expect(p.announced).toBe(false);
    expect(pm.get(p.id)).toBe(p);

    const decided = pm.decide(p.id, 'allow');
    expect(decided?.status).toBe('allowed');
    expect(decided?.decisionReason).toBeNull();
  });

  it('denies with a reason', () => {
    const pm = new PermissionManager(60_000);
    const p = pm.create('run-1', 'session-1', 'Bash', { command: 'rm -rf /' });
    const decided = pm.decide(p.id, 'deny', 'nope');
    expect(decided?.status).toBe('denied');
    expect(decided?.decisionReason).toBe('nope');
  });

  it('is idempotent — the first decision wins', () => {
    const pm = new PermissionManager(60_000);
    const p = pm.create('run-1', 'session-1', 'Bash', {});
    pm.decide(p.id, 'allow');
    const again = pm.decide(p.id, 'deny');
    expect(again?.status).toBe('allowed');
  });

  it('auto-denies on timeout', () => {
    vi.useFakeTimers();
    const pm = new PermissionManager(60_000);
    const p = pm.create('run-1', 'session-1', 'Bash', {});
    vi.advanceTimersByTime(60_000);
    expect(pm.get(p.id)?.status).toBe('timed_out');
  });

  it('returns undefined for unknown permission', () => {
    const pm = new PermissionManager(60_000);
    expect(pm.get('missing')).toBeUndefined();
    expect(pm.decide('missing', 'allow')).toBeUndefined();
  });

  it('allowAll resolves already-pending asks of the same session + tool', () => {
    const pm = new PermissionManager(60_000);
    const p1 = pm.create('run-1', 'session-1', 'Bash', { command: 'a' });
    const p2 = pm.create('run-2', 'session-1', 'Bash', { command: 'b' });
    const otherSession = pm.create('run-1', 'session-2', 'Bash', {});
    const otherTool = pm.create('run-1', 'session-1', 'Write', {});

    pm.allowAll('session-1', 'Bash');

    expect(p1.status).toBe('allowed');
    expect(p2.status).toBe('allowed');
    expect(otherSession.status).toBe('pending');
    expect(otherTool.status).toBe('pending');
  });

  it('allowAll on an MCP server covers every pending tool of that server', () => {
    const pm = new PermissionManager(60_000);
    const create = pm.create('run-1', 'session-1', 'mcp__github__create_issue', {});
    const list = pm.create('run-1', 'session-1', 'mcp__github__list_issues', {});
    const otherServer = pm.create('run-1', 'session-1', 'mcp__slack__send', {});
    const bash = pm.create('run-1', 'session-1', 'Bash', {});

    pm.allowAll('session-1', 'mcp__github__*');

    expect(create.status).toBe('allowed');
    expect(list.status).toBe('allowed');
    expect(otherServer.status).toBe('pending');
    expect(bash.status).toBe('pending');
  });

  it('clearRun resolves pending requests before dropping them', () => {
    const resolved: string[] = [];
    const pm = new PermissionManager(60_000, (req) => resolved.push(req.status));
    const p = pm.create('run-1', 'session-1', 'Bash', {});
    pm.clearRun('run-1');
    expect(p.status).toBe('denied');
    expect(resolved).toEqual(['denied']);
    expect(pm.get(p.id)).toBeUndefined();
  });

  it('clearSession resolves pending requests before dropping them', () => {
    const resolved: string[] = [];
    const pm = new PermissionManager(60_000, (req) => resolved.push(req.status));
    const p1 = pm.create('run-1', 'session-1', 'Bash', {});
    const p2 = pm.create('run-2', 'session-2', 'Bash', {});
    pm.clearSession('session-1');
    expect(p1.status).toBe('denied');
    expect(p2.status).toBe('pending');
    expect(resolved).toEqual(['denied']);
    expect(pm.get(p1.id)).toBeUndefined();
    expect(pm.get(p2.id)).toBe(p2);
  });
});

describe('RunNotifier', () => {
  it('routes events only to the registered run', () => {
    const n = new RunNotifier();
    const got: string[] = [];
    n.register('run-1', (ev) => got.push(ev.type));

    n.emit('run-1', { type: 'status', label: 'x' });
    n.emit('run-2', { type: 'status', label: 'y' }); // not registered
    expect(got).toEqual(['status']);

    n.unregister('run-1');
    n.emit('run-1', { type: 'status', label: 'z' });
    expect(got).toEqual(['status']);
  });

  it('broadcasts frames to every attached listener and honors unsubscribe', () => {
    const n = new RunNotifier();
    const a: number[] = [];
    const b: number[] = [];

    const unsubA = n.subscribe('run-1', (frame) => a.push(frame.seq));
    n.subscribe('run-1', (frame) => b.push(frame.seq));

    n.broadcast('run-1', { runId: 'run-1', seq: 1, event: { type: 'status', label: 'x' } });
    n.broadcast('run-1', { runId: 'run-1', seq: 2, event: { type: 'status', label: 'y' } });
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);

    unsubA();
    n.broadcast('run-1', { runId: 'run-1', seq: 3, event: { type: 'status', label: 'z' } });
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2, 3]);
    expect(n.subscriberCount('run-1')).toBe(1);
  });
});
