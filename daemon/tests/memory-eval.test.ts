import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import { Db, type WorkspaceRow } from '../src/db/db';
import { buildLifeBrief } from '../src/memory/brief';
import { captureRunMessages } from '../src/memory/ingest';
import type { MemoryModelSelection } from '../src/memory/model';
import { MemoryStore } from '../src/memory/store';
import { MemoryWorker } from '../src/memory/worker';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

function setup(): { db: Db; store: MemoryStore; workspace: WorkspaceRow; endId: string } {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory-eval'));
  stores.push(store);
  const { workspace, end } = db.ensureLifeWorkspace(tmpDir('life'));
  return { db, store, workspace, endId: end.id };
}

interface Fixture {
  match: string;
  predicate: string;
  object: string;
  kind: string;
  summary: string;
  sensitivity?: string;
}

const FIXTURES: Fixture[] = [
  { match: '搬到上海', predicate: 'lives_in', object: '上海', kind: 'fact', summary: '住在上海' },
  { match: '青鸟科技', predicate: 'works_at', object: '青鸟科技', kind: 'fact', summary: '在青鸟科技工作' },
  { match: '不吃香菜', predicate: 'dislikes', object: '香菜', kind: 'preference', summary: '不喜欢香菜' },
  { match: '团子', predicate: 'has_pet', object: '团子', kind: 'relation', summary: '养了一只叫团子的猫' },
  { match: '七点跑步', predicate: 'habit', object: '早上七点跑步', kind: 'fact', summary: '每天早上七点跑步' },
  { match: '美式咖啡', predicate: 'likes', object: '美式咖啡', kind: 'preference', summary: '喜欢美式咖啡' },
  { match: '复查牙齿', predicate: 'plan', object: '去医院复查牙齿', kind: 'fact', summary: '下周三去医院复查牙齿' },
  { match: '女朋友叫小林', predicate: 'relation', object: '小林', kind: 'relation', summary: '女朋友叫小林' },
  { match: '五月二十日', predicate: 'birthday', object: '5 月 20 日', kind: 'profile', summary: '生日是 5 月 20 日' },
  { match: '学会游泳', predicate: 'goal', object: '学会游泳', kind: 'fact', summary: '今年想学会游泳' },
  {
    match: '银行卡密码',
    predicate: 'profile',
    object: '银行卡密码',
    kind: 'profile',
    summary: '银行卡密码',
    sensitivity: 'secret',
  },
];

/** Scripted extractor: parses the batch block and emits one claim per matched fact. */
function evalProvider(): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    async *stream() {
      // Memory uses complete() only.
    },
    async complete(request: LlmRequest) {
      const prompt = String(request.messages[0]?.content ?? '');
      const blocks = [...prompt.matchAll(/\[source ([^ |]+) \|[^\]]+\]\n([\s\S]*?)\n\[\/source\]/g)];
      const claims = [];
      for (const [, sourceId, content] of blocks) {
        for (const fixture of FIXTURES) {
          if (!content!.includes(fixture.match)) continue;
          claims.push({
            predicate: fixture.predicate,
            object: fixture.object,
            kind: fixture.kind,
            summary: fixture.summary,
            confidence: 0.9,
            importance: 0.8,
            sensitivity: fixture.sensitivity ?? 'normal',
            evidence: [{ sourceId, quote: content!.trim() }],
          });
        }
      }
      return { text: JSON.stringify({ claims }), toolCalls: [], finishReason: 'stop', usage: null };
    },
  };
}

function model(provider: LlmProvider): MemoryModelSelection {
  return {
    provider,
    providerId: 'fake',
    model: 'fake-1',
    modelId: 'fake:fake-1',
    providerConfig: { id: 'fake' },
    modelConfig: { id: 'fake-1' },
  } as unknown as MemoryModelSelection;
}

describe('M0 evaluation v0', () => {
  it('turns 3 life conversations into 10 facts, drops secret, and stays editable', async () => {
    const { db, store, workspace } = setup();
    const conversations = [
      ['我上个月搬到上海了。', '我在青鸟科技上班。', '我不吃香菜。', '我养了一只猫，叫团子。'],
      ['我每天早上七点跑步。', '我喜欢喝美式咖啡。', '下周三我要去医院复查牙齿。'],
      ['我女朋友叫小林。', '我生日是五月二十日。', '我希望今年学会游泳。'],
      ['我的银行卡密码是 123456。'],
    ];

    conversations.forEach((messages, index) => {
      const session = db.createSession({
        id: `s-eval-${index}`,
        runtime: 'claude',
        workspaceId: workspace.id,
        permissionMode: 'ask',
        cwd: workspace.path,
      });
      for (const content of messages) db.addMessage(session.id, 'user', content);
      captureRunMessages({
        store,
        session,
        workspace,
        ends: db.listEnds(workspace.id),
        messages: db.listMessages(session.id),
        runId: `r-eval-${index}`,
      });
    });

    const worker = new MemoryWorker({
      store,
      resolveModel: async () => model(evalProvider()),
      batchSize: 50,
    });
    while (store.countSources('pending', `workspace:${workspace.id}`) > 0) {
      const result = await worker.runOnce();
      if (result.processed === 0) break;
    }

    const claims = store.listClaims(`workspace:${workspace.id}`);
    expect(claims).toHaveLength(10);
    expect(claims.some((claim) => claim.summary.includes('密码'))).toBe(false);
    expect(claims.every((claim) => store.claimEvidence(claim.id).length > 0)).toBe(true);

    const brief = buildLifeBrief(store, `workspace:${workspace.id}`);
    expect(brief).not.toBeNull();
    expect(brief!.markdown.match(/#claim_/g)).toHaveLength(10);
    expect(brief!.markdown).not.toContain('密码');

    const target = claims.find((claim) => claim.summary === '住在上海')!;
    const corrected = store.correctClaim(target.id, {
      summary: '常住杭州',
      objectText: '杭州',
    });
    expect(corrected).toMatchObject({ authority: 'user_confirmed', confidence: 1, summary: '常住杭州' });
    const after = buildLifeBrief(store, `workspace:${workspace.id}`);
    expect(after!.markdown).toContain('常住杭州');
    expect(after!.markdown).not.toContain('住在上海');
    expect(after!.usedClaimIds).toContain(target.id);
  });

  it('keeps pending sources in record-only mode and digests the backlog later', async () => {
    const { db, store, workspace } = setup();
    const session = db.createSession({
      id: 's-none',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
    });
    db.addMessage(session.id, 'user', '我上个月搬到上海了。');
    captureRunMessages({
      store,
      session,
      workspace,
      ends: db.listEnds(workspace.id),
      messages: db.listMessages(session.id),
      runId: 'r-none',
    });

    const inactiveWorker = new MemoryWorker({ store, resolveModel: async () => null });
    const inactive = await inactiveWorker.runOnce();
    expect(inactive.inactive).toBe(true);
    expect(store.countSources('pending', `workspace:${workspace.id}`)).toBe(1);
    expect(store.listClaims(`workspace:${workspace.id}`)).toHaveLength(0);

    const activeWorker = new MemoryWorker({
      store,
      resolveModel: async () => model(evalProvider()),
    });
    await activeWorker.runOnce();
    expect(store.countSources('pending', `workspace:${workspace.id}`)).toBe(0);
    expect(store.listClaims(`workspace:${workspace.id}`)).toHaveLength(1);
  });
});
