import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Db } from '../src/db/db';
import {
  createTranscriptStore,
  projectActiveMessages,
  renderTranscriptMessages,
  selectActiveRuntimeContext,
  type NativeMessage,
  type NativeMessageSource,
  type TranscriptContentBlock,
} from '../src/runtimes/builtin/transcript/index';

const dbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(file = ':memory:'): Db {
  const db = new Db(file);
  dbs.push(db);
  return db;
}

function seed(db: Db, sessionId = 's-1'): void {
  const workspace = db.seedDefaultWorkspace(process.cwd(), 'ask');
  if (!workspace) throw new Error('expected workspace');
  db.createSession({
    id: sessionId,
    runtime: 'builtin',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
}

function message(
  seq: number,
  role: NativeMessage['role'],
  blocks: TranscriptContentBlock[],
  source: NativeMessageSource,
): NativeMessage {
  return {
    id: seq,
    threadId: 'thread-1',
    seq,
    role,
    blocks,
    source,
    runId: 'run-1',
    step: 1,
    provider: null,
    model: null,
    usage: null,
    formatVersion: 1,
    createdAt: seq,
  };
}

describe('native transcript store', () => {
  it('allocates per-thread sequence numbers and round-trips neutral blocks', () => {
    const db = openDb();
    seed(db);
    const store = createTranscriptStore(db);
    const thread = store.getOrCreateThread({ sessionId: 's-1', agentId: 'builtin' });
    expect(store.getOrCreateThread({ sessionId: 's-1', agentId: 'builtin' }).id).toBe(thread.id);

    const user = store.append({
      threadId: thread.id,
      role: 'user',
      blocks: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          attachmentId: 'att-1',
          mediaType: 'image/png',
          bytes: 68,
          width: 1,
          height: 1,
        },
      ],
      source: { kind: 'user' },
      runId: 'run-1',
      step: 1,
    });
    const assistant = store.append({
      threadId: thread.id,
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'reading' },
        { type: 'tool_call', id: 'tool-1', name: 'Read', arguments: '{"file_path":"a.ts"}' },
      ],
      source: { kind: 'model', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      runId: 'run-1',
      step: 1,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 10, outputTokens: 3 },
    });

    expect(user.seq).toBe(1);
    expect(assistant.seq).toBe(2);
    const rows = store.list(thread.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      seq: 1,
      role: 'user',
      blocks: user.blocks,
      source: { kind: 'user' },
    });
    expect(rows[1]).toMatchObject({
      seq: 2,
      provider: 'anthropic',
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    expect(store.list(thread.id, 1).map((row) => row.seq)).toEqual([2]);

    db.deleteSession('s-1');
    expect(store.list(thread.id)).toEqual([]);
    expect(db.listNativeThreads('s-1')).toEqual([]);
  });

  it('survives a daemon restart from the same SQLite file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-transcript-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'paboot.sqlite');
    const first = new Db(file);
    seed(first);
    const firstStore = createTranscriptStore(first);
    const thread = firstStore.getOrCreateThread({ sessionId: 's-1', agentId: 'builtin' });
    firstStore.append({
      threadId: thread.id,
      role: 'user',
      blocks: [{ type: 'text', text: 'remember me' }],
      source: { kind: 'user' },
    });
    first.close();

    const second = openDb(file);
    const secondStore = createTranscriptStore(second);
    const reopened = secondStore.getOrCreateThread({ sessionId: 's-1', agentId: 'builtin' });
    expect(reopened.id).toBe(thread.id);
    expect(secondStore.list(reopened.id)).toMatchObject([
      { seq: 1, role: 'user', blocks: [{ type: 'text', text: 'remember me' }] },
    ]);
  });

  it('stores compaction boundaries without deleting source messages', () => {
    const db = openDb();
    seed(db);
    const store = createTranscriptStore(db);
    const thread = store.getOrCreateThread({ sessionId: 's-1', agentId: 'builtin' });
    for (let seq = 1; seq <= 3; seq += 1) {
      store.append({
        threadId: thread.id,
        role: 'user',
        blocks: [{ type: 'text', text: `m${seq}` }],
        source: { kind: 'user' },
      });
    }

    const compaction = store.appendCompaction({
      threadId: thread.id,
      summary: 'summary',
      throughSeq: 2,
      tokensBefore: 100,
      tokensAfter: 10,
    });
    expect(compaction).toMatchObject({ threadId: thread.id, throughSeq: 2, summary: 'summary' });
    expect(store.listCompactions(thread.id)).toHaveLength(1);
    expect(store.list(thread.id).map((row) => row.seq)).toEqual([1, 2, 3]);
  });
});

describe('transcript request projection', () => {
  it('keeps only the latest runtime-context snapshot', () => {
    const messages = [
      message(1, 'user', [{ type: 'text', text: 'old context' }], {
        kind: 'runtime-context',
        sourceKey: 'runtime',
        version: 'v1',
      }),
      message(2, 'user', [{ type: 'text', text: 'hello' }], { kind: 'user' }),
      message(3, 'user', [{ type: 'text', text: 'new context' }], {
        kind: 'runtime-context',
        sourceKey: 'runtime',
        version: 'v2',
      }),
    ];

    expect(selectActiveRuntimeContext(messages)?.seq).toBe(3);
    expect(projectActiveMessages(messages).map((row) => row.seq)).toEqual([2, 3]);
  });

  it('renders user, assistant tool calls, tool results and images for providers', async () => {
    const messages = [
      message(
        1,
        'user',
        [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            attachmentId: 'att-1',
            mediaType: 'image/png',
            bytes: 68,
            width: 1,
            height: 1,
          },
        ],
        { kind: 'user' },
      ),
      message(
        2,
        'assistant',
        [
          { type: 'text', text: 'reading' },
          { type: 'tool_call', id: 'tool-1', name: 'Read', arguments: '{"file_path":"a.ts"}' },
          { type: 'reasoning', text: 'not replayed' },
        ],
        { kind: 'model', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      ),
      message(
        3,
        'tool',
        [{ type: 'tool_result', toolUseId: 'tool-1', content: 'file body', isError: false }],
        { kind: 'tool', callId: 'tool-1' },
      ),
      message(4, 'user', [{ type: 'text', text: 'thanks' }], { kind: 'user' }),
    ];

    const rendered = await renderTranscriptMessages(messages, {
      resolveImage: (block) => ({
        type: 'image',
        mediaType: block.mediaType,
        data: 'iVBORw0KGgo=',
      }),
    });

    expect(rendered).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tool-1', content: 'file body' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ]);
  });

  it('uses a text placeholder when no image resolver is available', async () => {
    const rendered = await renderTranscriptMessages([
      message(
        1,
        'user',
        [
          {
            type: 'image',
            attachmentId: 'att-1',
            mediaType: 'image/webp',
            bytes: 10,
            width: 2,
            height: 3,
          },
        ],
        { kind: 'user' },
      ),
    ]);
    expect(rendered).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[image att-1 omitted: image/webp, 2x3]' }],
      },
    ]);
  });
});
