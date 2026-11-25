import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { buildContract, evaluatePeerTool } from '../src/peer';
import { PermissionManager } from '../src/permissions/permissions';
import { registerPermissionRoutes } from '../src/routes/permissions';
import { RunNotifier } from '../src/runs/run-notifier';
import { SessionNotifier } from '../src/runs/session-notifier';
import { withToolPolicy } from '../src/runtimes/builtin/tools/permission-broker';
import type { PermissionBroker } from '../src/runtimes/builtin/types';

const servers: Server[] = [];
const dbs: Db[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harness(patch: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'paboot-peer-perm-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'paboot-peer-data-'));
  dirs.push(root, dataDir);
  writeFileSync(join(dataDir, 'token'), 'secret');
  writeFileSync(join(root, 'readme.txt'), 'hello');

  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.seedDefaultWorkspace(root, 'ask')!;
  const session = db.createSession({
    id: 'peer-session',
    runtime: 'builtin',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: root,
    purpose: 'peer',
  });
  const contract = buildContract({
    agent: { id: 'exposed-1', name: '审阅', summary: '', kind: 'builtin' },
    workspacePath: root,
    patch,
  });
  db.upsertExposedAgent({
    agent_id: 'exposed-1',
    contract_json: JSON.stringify(contract),
    enabled: 1,
    created_at: 1,
    updated_at: 1,
  });
  db.createRun({
    id: 'peer-run',
    sessionId: session.id,
    runtime: 'builtin',
    model: null,
    prompt: 'hi',
    status: 'running',
    trigger: 'peer',
    agentId: 'exposed-1',
    peerId: 'peer-a',
  });

  const permissions = new PermissionManager(60_000);
  const notifier = new RunNotifier();
  const events: string[] = [];
  notifier.register('peer-run', (event) => events.push(event.type));
  const ctx = {
    db,
    permissions,
    notifier,
    sessionNotifier: new SessionNotifier(),
    config: { dataDir },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerPermissionRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    permissions,
    events,
    root,
    dataDir,
    create: (toolName: string, toolInput: unknown) =>
      fetch(`${base}/api/internal/permissions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'peer-run', toolName, toolInput }),
      }),
  };
}

describe('peer run permissions', () => {
  it('auto-allows ordinary reads without a relay round-trip', async () => {
    const h = await harness();
    const res = await h.create('Read', { file_path: join(h.root, 'readme.txt') });
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('allowed');
    expect(h.permissions.get(body.id)?.decisionReason).toBe('peer read');
    expect(h.events).toEqual([]);
  });

  it('denies the daemon data dir, including through a symlink', async () => {
    const h = await harness();
    const direct = await h.create('Read', { file_path: join(h.dataDir, 'token') });
    expect(((await direct.json()) as { status: string }).status).toBe('denied');

    const link = join(h.root, 'sneaky');
    symlinkSync(join(h.dataDir, 'token'), link);
    const viaLink = await h.create('Read', { file_path: link });
    expect(((await viaLink.json()) as { status: string }).status).toBe('denied');
  });

  it('honours auto_deny for write-class tools', async () => {
    const h = await harness({ approvalPolicy: 'auto_deny' });
    const res = await h.create('Bash', { command: 'rm -rf build' });
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('denied');
    expect(h.permissions.get(body.id)?.decisionReason).toContain('auto_deny');
  });

  it('denies after sharing is paused', async () => {
    const h = await harness();
    h.db.setExposedAgentEnabled('exposed-1', false, Date.now());
    const res = await h.create('Read', { file_path: join(h.root, 'readme.txt') });
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('denied');
    expect(h.permissions.get(body.id)?.decisionReason).toContain('paused');
  });
});

describe('builtin peer runs honour the same contract', () => {
  function brokerFor(input: { enabled: boolean; approvalPolicy: 'relay' | 'auto_deny' }) {
    const asked: string[] = [];
    const inner: PermissionBroker = {
      async request(request) {
        asked.push(request.toolName);
        return { status: 'allowed', reason: 'asked' };
      },
    };
    const policy = (toolName: string, toolInput: unknown) =>
      evaluatePeerTool({
        enabled: input.enabled,
        approvalPolicy: input.approvalPolicy,
        dataDir: '/home/u/.paboot',
        toolName,
        toolInput,
      }).decision;
    return { broker: withToolPolicy(inner, policy), asked };
  }

  it('denies auto_deny writes without surfacing them to the visitor', async () => {
    const { broker, asked } = brokerFor({ enabled: true, approvalPolicy: 'auto_deny' });
    const decision = await broker.request({
      runId: 'r',
      sessionId: 's',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
    });
    expect(decision.status).toBe('denied');
    expect(asked).toEqual([]);
  });

  it('denies once the share is paused', async () => {
    const { broker, asked } = brokerFor({ enabled: false, approvalPolicy: 'relay' });
    const decision = await broker.request({
      runId: 'r',
      sessionId: 's',
      toolName: 'Write',
      toolInput: { file_path: '/home/u/project/a.ts' },
    });
    expect(decision.status).toBe('denied');
    expect(asked).toEqual([]);
  });

  it('auto-allows reads and still asks for writes under relay', async () => {
    const { broker, asked } = brokerFor({ enabled: true, approvalPolicy: 'relay' });
    expect(
      (
        await broker.request({
          runId: 'r',
          sessionId: 's',
          toolName: 'Read',
          toolInput: { file_path: '/home/u/project/a.ts' },
        })
      ).status,
    ).toBe('allowed');
    expect(asked).toEqual([]);
    expect(
      (
        await broker.request({
          runId: 'r',
          sessionId: 's',
          toolName: 'Write',
          toolInput: { file_path: '/home/u/project/a.ts' },
        })
      ).status,
    ).toBe('allowed');
    expect(asked).toEqual(['Write']);
  });
});
