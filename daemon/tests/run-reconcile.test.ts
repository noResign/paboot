import { describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';

/** A default workspace plus one session, so runs have an owner. */
function seed(db: Db, sessionId: string): void {
  const workspace = db.seedDefaultWorkspace(process.cwd(), 'ask');
  if (!workspace) throw new Error('expected a seeded workspace');
  db.createSession({ id: sessionId, runtime: 'claude', workspaceId: workspace.id, permissionMode: 'ask', cwd: workspace.path });
}

function addRun(db: Db, id: string, status: string): void {
  db.createRun({ id, sessionId: 's-1', runtime: 'claude', model: null, prompt: 'hi', status });
}

describe('interruptOrphanedRuns', () => {
  // A run is only `running` while a process is live. After a restart nothing is
  // live, so a row still marked `running` would read as "running" forever.
  it('marks runs left running by a previous process as interrupted', () => {
    const db = new Db(':memory:');
    seed(db, 's-1');
    addRun(db, 'r-live', 'running');
    addRun(db, 'r-done', 'succeeded');
    db.appendEvent('r-live', 1, 'text_delta', { type: 'text_delta', delta: 'hi' });

    const repaired = db.interruptOrphanedRuns('daemon restarted');

    expect(repaired).toBe(1);
    const live = db.getRun('r-live');
    expect(live?.status).toBe('interrupted');
    expect(live?.error).toBe('daemon restarted');
    expect(live?.ended_at).not.toBeNull();
    // The persisted stream is closed with a terminal frame, so a reconnect
    // replays a well-formed run instead of one that just stops mid-flight.
    const events = db.listEvents('r-live');
    expect(events.at(-1)?.seq).toBe(2);
    expect(JSON.parse(events.at(-1)!.payload)).toMatchObject({
      type: 'status',
      label: 'interrupted',
      terminal: true,
    });
    // Terminal runs are left alone.
    expect(db.getRun('r-done')?.status).toBe('succeeded');
    expect(db.listEvents('r-done')).toHaveLength(0);
    db.close();
  });

  it('is a no-op when no run is in flight', () => {
    const db = new Db(':memory:');
    seed(db, 's-1');
    addRun(db, 'r-done', 'failed');

    expect(db.interruptOrphanedRuns('daemon restarted')).toBe(0);
    expect(db.getRun('r-done')?.status).toBe('failed');
    db.close();
  });
});
