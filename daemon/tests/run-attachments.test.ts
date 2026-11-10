import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';
import { runDto } from '../src/db/dto';

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('run attachment ids', () => {
  it('persists and exposes the ids admitted with a run', () => {
    const db = new Db(':memory:');
    dbs.push(db);
    db.seedDefaultWorkspace(process.cwd(), 'ask');
    const workspace = db.getDefaultWorkspace()!;
    const session = db.createSession({
      id: 's-attachments',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
    });
    db.createRun({
      id: 'r-attachments',
      sessionId: session.id,
      runtime: 'claude',
      model: null,
      prompt: 'look',
      attachmentIds: ['a', 'b'],
      status: 'succeeded',
    });
    const row = db.getRun('r-attachments')!;
    expect(runDto(row).attachmentIds).toEqual(['a', 'b']);

    db.createRun({
      id: 'r-empty',
      sessionId: session.id,
      runtime: 'claude',
      model: null,
      prompt: 'text only',
      status: 'succeeded',
    });
    expect(runDto(db.getRun('r-empty')!).attachmentIds).toEqual([]);
  });
});
