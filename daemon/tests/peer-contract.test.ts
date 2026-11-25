import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db/db';
import {
  buildContract,
  createInvite,
  exposeAgent,
  findGuestToken,
  getExposure,
  parseStoredContract,
  PeerValidationError,
  reconcilePeerRuns,
  redeemInvite,
  removeExposure,
  revokeAgentAccess,
  setExposureEnabled,
} from '../src/peer';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-peer-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const workspacePath = tempWorkspace();
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });
  seedAgent(db, workspace.id, 'a1', '审阅');
  seedAgent(db, workspace.id, 'a2', '记录');
  return { db, workspacePath, workspace };
}

/** Invites re-check the agent row, so tests need real (minimal) agents. */
function seedAgent(
  db: Db,
  workspaceId: string,
  id: string,
  name: string,
  kind: 'builtin' | 'runtime' = 'builtin',
  runtime: string | null = null,
): void {
  const now = Date.now();
  db.insertAgent({
    id,
    workspace_id: workspaceId,
    name,
    summary: '',
    avatar: null,
    kind,
    runtime,
    peer_id: null,
    remote_agent_id: null,
    model: null,
    model_parameters: null,
    instructions: '',
    cwd: null,
    extra_dirs: null,
    read_only: 0,
    permission_ceiling: 'ask',
    skills: null,
    budget_json: null,
    heavy: 0,
    is_implicit: 0,
    enabled: 1,
    version: 1,
    created_at: now,
    updated_at: now,
  });
}

const agent = { id: 'a1', name: '审阅', summary: '审查代码，不改代码', kind: 'builtin' };

describe('peer contract', () => {
  it('defaults to full + relay + capture off', () => {
    const contract = buildContract({ agent, workspacePath: tempWorkspace() });
    expect(contract).toMatchObject({
      agentId: 'a1',
      publicName: '审阅',
      summary: '审查代码，不改代码',
      access: 'full',
      approvalPolicy: 'relay',
      capture: false,
      maxConcurrentRuns: 1,
      protocolVersion: 1,
      version: 1,
      dirs: [],
    });
    expect(contract.quota).toEqual({
      runsPerHour: 20,
      maxInputTokensPerRun: 20_000,
      maxWallClockMs: 600_000,
    });
  });

  it('bumps version and applies patches', () => {
    const workspacePath = tempWorkspace();
    const first = buildContract({ agent, workspacePath });
    const second = buildContract({
      agent,
      workspacePath,
      previous: first,
      patch: { approvalPolicy: 'auto_deny', quota: { runsPerHour: 5 } },
    });
    expect(second.version).toBe(2);
    expect(second.approvalPolicy).toBe('auto_deny');
    expect(second.quota.runsPerHour).toBe(5);
    // Unspecified fields are inherited.
    expect(second.quota.maxWallClockMs).toBe(first.quota.maxWallClockMs);
  });

  it('only shares builtin and Claude agents in v1', () => {
    const workspacePath = tempWorkspace();
    for (const runtime of ['codex', 'deepseek']) {
      expect(() =>
        exposeAgent(new Db(':memory:'), {
          agent: { id: 'a2', name: '代码', summary: '', kind: 'runtime', runtime },
          workspacePath,
        }),
      ).toThrowError(/builtin and Claude/);
    }
    // Claude is the other supported backend.
    const db = new Db(':memory:');
    expect(
      exposeAgent(db, {
        agent: { id: 'a3', name: '代码', summary: '', kind: 'runtime', runtime: 'claude' },
        workspacePath,
      }).enabled,
    ).toBe(true);
  });

  it('rejects custom mode until it is implemented', () => {
    expect(() =>
      buildContract({ agent, workspacePath: tempWorkspace(), patch: { access: 'custom' } }),
    ).toThrowError(PeerValidationError);
    try {
      buildContract({ agent, workspacePath: tempWorkspace(), patch: { access: 'custom' } });
    } catch (error) {
      expect((error as PeerValidationError).code).toBe('custom_not_supported');
    }
  });

  it('rejects invalid quota and approval policy', () => {
    const workspacePath = tempWorkspace();
    expect(() =>
      buildContract({ agent, workspacePath, patch: { quota: { runsPerHour: 0 } } }),
    ).toThrowError(/runsPerHour/);
    expect(() =>
      buildContract({ agent, workspacePath, patch: { approvalPolicy: 'whatever' } }),
    ).toThrowError(/approvalPolicy/);
  });

  it('rejects local_prompt until v1 implements it', () => {
    try {
      buildContract({ agent, workspacePath: tempWorkspace(), patch: { approvalPolicy: 'local_prompt' } });
      throw new Error('expected local_prompt to be rejected');
    } catch (error) {
      expect((error as PeerValidationError).code).toBe('approval_policy_not_supported');
    }
  });

  it('rejects a capture switch that the run path does not honour', () => {
    expect(() =>
      buildContract({ agent, workspacePath: tempWorkspace(), patch: { capture: true } }),
    ).toThrowError(/capture is not available/);
  });

  it('keeps dirs inside the workspace', () => {
    const workspacePath = tempWorkspace();
    fs.mkdirSync(path.join(workspacePath, 'sub'));
    const contract = buildContract({
      agent,
      workspacePath,
      patch: { dirs: [path.join(workspacePath, 'sub')] },
    });
    expect(contract.dirs).toEqual([path.join(workspacePath, 'sub')]);

    // Relative dirs are relative to the workspace, not the daemon's cwd.
    const relative = buildContract({ agent, workspacePath, patch: { dirs: ['sub'] } });
    expect(relative.dirs).toEqual([path.join(workspacePath, 'sub')]);

    expect(() =>
      buildContract({ agent, workspacePath, patch: { dirs: ['/etc'] } }),
    ).toThrowError(/outside the workspace/);
  });

  it('round-trips through storage', () => {
    const contract = buildContract({ agent, workspacePath: tempWorkspace() });
    expect(parseStoredContract(JSON.stringify(contract))).toEqual(contract);
  });
});

describe('exposure and invites', () => {
  it('exposes, pauses and refuses re-exposing a peer agent', () => {
    const { db, workspacePath } = setup();
    const exposure = exposeAgent(db, { agent, workspacePath });
    expect(exposure.enabled).toBe(true);
    expect(exposure.contract.version).toBe(1);

    const paused = setExposureEnabled(db, exposure.agentId, false);
    expect(paused.enabled).toBe(false);

    // Editing must not silently resume a paused share...
    const stillPaused = exposeAgent(db, { agent, workspacePath });
    expect(stillPaused.contract.version).toBe(2);
    expect(stillPaused.enabled).toBe(false);

    // ...only an explicit enabled=true does.
    const resumed = exposeAgent(db, { agent, workspacePath, enabled: true });
    expect(resumed.enabled).toBe(true);

    expect(() =>
      exposeAgent(db, {
        agent: { id: 'p1', name: '远端', summary: '', kind: 'peer' },
        workspacePath,
      }),
    ).toThrowError(/cannot be exposed/i);
  });

  it('creates a one-shot invite and redeems it into a guest token', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });

    const invite = createInvite(db, { agentIds: ['a1'] });
    expect(invite.token).toHaveLength(64);
    expect(invite.agentIds).toEqual(['a1']);

    const guest = redeemInvite(db, { token: invite.token, label: '公司那台' });
    expect(guest.agentIds).toEqual(['a1']);
    expect(findGuestToken(db, invite.token)).toMatchObject({ agentIds: ['a1'], peerId: guest.peerId });

    expect(() => redeemInvite(db, { token: invite.token })).toThrowError(/already used/);
  });

  it('refuses an invite for a legacy exposure whose agent is unsupported', () => {
    const { db, workspacePath } = setup();
    // Simulate a row written before the backend gate existed.
    const contract = buildContract({ agent, workspacePath });
    db.upsertExposedAgent({
      agent_id: 'legacy-codex',
      contract_json: JSON.stringify({ ...contract, agentId: 'legacy-codex' }),
      enabled: 1,
      created_at: 1,
      updated_at: 1,
    });
    expect(() => createInvite(db, { agentIds: ['legacy-codex'] })).toThrowError(
      /backend is not shareable/,
    );
  });

  it('rejects an expired invite', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });
    const invite = createInvite(db, { agentIds: ['a1'], ttlMs: 1_000, now: 1_000 });
    expect(() => redeemInvite(db, { token: invite.token, now: 2_001 })).toThrowError(/expired/);
  });

  it('does not expire the connection when the invite does', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });
    const invite = createInvite(db, { agentIds: ['a1'], ttlMs: 1_000, now: 1_000 });
    redeemInvite(db, { token: invite.token, now: 1_500 });
    // The pairing link expires, but the issued token lasts until revoked.
    expect(findGuestToken(db, invite.token, 10_000_000)).not.toBeNull();
    expect(findGuestToken(db, invite.token, 2_001)).not.toBeNull();
  });

  it('refuses to rebind an outbound peer id', () => {
    const { db, workspacePath } = setup();
    db.upsertPeer({
      id: 'peer-corp',
      direction: 'out',
      server_id: 'peer-corp',
      remote_agent_id: 'remote-1',
      label: '公司那台',
      base_url: 'http://corp:4780',
      fingerprint: null,
      token_cipher: 't',
      last_seen_at: null,
      created_at: 1,
    });
    exposeAgent(db, { agent, workspacePath });
    const invite = createInvite(db, { agentIds: ['a1'] });
    expect(() => redeemInvite(db, { token: invite.token, peerId: 'peer-corp' })).toThrowError(
      /outbound peer/,
    );
  });

  it('removes the exposure and its credentials when the agent is deleted', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });
    const invite = createInvite(db, { agentIds: ['a1'] });
    redeemInvite(db, { token: invite.token });
    removeExposure(db, 'a1');
    expect(getExposure(db, 'a1')).toBeNull();
    expect(findGuestToken(db, invite.token)).toBeNull();
  });

  it('refuses to bundle several agents into one invite', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });
    exposeAgent(db, { agent: { ...agent, id: 'a2', name: '记录' }, workspacePath });
    expect(() => createInvite(db, { agentIds: ['a1', 'a2'] })).toThrowError(/exactly one agent/);
  });

  it('keeps each agent on its own token', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });
    exposeAgent(db, { agent: { ...agent, id: 'a2', name: '记录' }, workspacePath });

    const first = createInvite(db, { agentIds: ['a1'] });
    const second = createInvite(db, { agentIds: ['a2'] });
    redeemInvite(db, { token: first.token });
    redeemInvite(db, { token: second.token });

    expect(getExposure(db, 'a1')?.hasTokens).toBe(true);
    expect(getExposure(db, 'a2')?.hasTokens).toBe(true);

    // Revoking one connection does not touch the other one.
    expect(revokeAgentAccess(db, 'a1').revoked).toBe(1);
    expect(findGuestToken(db, first.token)).toBeNull();
    expect(findGuestToken(db, second.token)?.agentIds).toEqual(['a2']);
    expect(getExposure(db, 'a1')?.enabled).toBe(false);
    expect(getExposure(db, 'a2')?.hasTokens).toBe(true);
  });

  it('revoking the last scoped agent revokes the token entirely', () => {
    const { db, workspacePath } = setup();
    exposeAgent(db, { agent, workspacePath });
    const invite = createInvite(db, { agentIds: ['a1'] });
    redeemInvite(db, { token: invite.token });

    expect(revokeAgentAccess(db, 'a1').revoked).toBe(1);
    expect(findGuestToken(db, invite.token)).toBeNull();
  });
});

describe('peer columns', () => {
  it('stores the message source and keeps client run ids unique', () => {
    const { db, workspacePath, workspace } = setup();
    const session = db.createSession({
      id: 's1',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    db.addMessage(session.id, 'assistant', '来自远端', { source: 'peer', commit: true });
    expect(db.listMessages(session.id)[0]?.source).toBe('peer');

    const hidden = db.createSession({
      id: 's-peer',
      runtime: 'peer',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
      purpose: 'peer',
    });
    expect(db.listSessions(workspace.id).map((s) => s.id)).not.toContain(hidden.id);

    db.createRun({
      id: 'r1',
      sessionId: session.id,
      runtime: 'peer:corp',
      model: null,
      prompt: 'hi',
      status: 'running',
      trigger: 'peer',
      peerId: 'peer-a',
      clientRunId: 'cr1',
      remoteRunId: 'remote-1',
    });
    // The same id from another peer is a different call.
    db.createRun({
      id: 'r2',
      sessionId: session.id,
      runtime: 'peer:home',
      model: null,
      prompt: 'hi',
      status: 'running',
      trigger: 'peer',
      peerId: 'peer-b',
      clientRunId: 'cr1',
    });
    expect(() =>
      db.createRun({
        id: 'r3',
        sessionId: session.id,
        runtime: 'peer:corp',
        model: null,
        prompt: 'hi again',
        status: 'running',
        trigger: 'peer',
        peerId: 'peer-a',
        clientRunId: 'cr1',
      }),
    ).toThrow();
  });
});

describe('peer restart reconciliation', () => {
  it('cancels runs left in flight on the remote daemon', async () => {
    const { db, workspacePath, workspace } = setup();
    db.upsertPeer({
      id: 'peer-corp',
      direction: 'out',
      server_id: 'peer-corp',
      remote_agent_id: 'remote-1',
      label: '公司那台',
      base_url: 'http://peer-corp:4780',
      fingerprint: 'peer-corp',
      token_cipher: 'guest-token',
      last_seen_at: 1,
      created_at: 1,
    });
    const session = db.createSession({
      id: 's1',
      runtime: 'peer',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    db.createRun({
      id: 'r1',
      sessionId: session.id,
      runtime: 'peer:peer-corp',
      model: null,
      prompt: 'hi',
      status: 'running',
      trigger: 'peer',
      peerId: 'peer-corp',
      clientRunId: 'cr1',
      remoteRunId: 'remote-9',
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      expect(await reconcilePeerRuns(db)).toBe(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://peer-corp:4780/api/peer/runs/remote-9/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
