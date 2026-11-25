import { randomUUID } from 'node:crypto';
import {
  adoptLeader,
  createAgent,
  defaultAgentFor,
  getLeader,
  listAgents,
  listSessionAgents,
  removeAgent,
  updateAgent,
} from '../agents/index.js';
import type { Agent } from '../agents/index.js';
import type { AppContext } from '../app/context.js';
import { resolveServerId } from '../db/server-id.js';
import type { WorkspaceRow } from '../db/db.js';
import type { PeerConnectionDto } from '../types/api.js';
import { parseInvite, probePeer, redeemPeer } from './client.js';
import { PeerValidationError } from './contract.js';

/**
 * B-side ("we joined them"): probe the invite, redeem it once, store the
 * outbound peer, and project every exposed agent into the chosen workspace.
 */
export async function joinPeer(
  ctx: AppContext,
  input: { url: string; workspaceId?: string; label?: string },
): Promise<PeerConnectionDto> {
  const invite = parseInvite(input.url);
  if (invite.expiresAt !== null && invite.expiresAt <= Date.now()) {
    throw new PeerValidationError('invite expired', 'invite_expired', 410);
  }
  const workspace = resolveWorkspace(ctx, input.workspaceId);
  const info = await probePeer(invite.baseUrl, invite.token);
  if (info.protocolVersion !== 1) {
    throw new PeerValidationError(
      `unsupported peer protocol ${info.protocolVersion}`,
      'protocol_mismatch',
      409,
    );
  }
  if (invite.fingerprint && invite.fingerprint !== info.serverId) {
    throw new PeerValidationError(
      'this machine is not the one the invite named',
      'fingerprint_mismatch',
      409,
    );
  }
  const serverId = resolveServerId(ctx.db);
  if (info.serverId === serverId) {
    // A self-peer makes every "remote" run a loop through the same daemon and
    // confuses the room's writer/attribution rules. Use the local agent instead.
    throw new PeerValidationError(
      'this invite points at the same daemon; use the local assistant directly',
      'self_connection',
      400,
    );
  }
  const redeemed = await redeemPeer(invite.baseUrl, invite.token, {
    peerId: serverId,
    label: input.label?.trim() || invite.baseUrl,
  });
  // The token is scoped to one agent; `/peer/info` above returns only that one.
  if (info.agents.length !== 1 || redeemed.agentIds.length !== 1) {
    throw new PeerValidationError(
      'an invite must resolve to exactly one remote agent',
      'single_agent_only',
      409,
    );
  }
  const remote = info.agents[0]!;
  const remoteAgentId = redeemed.agentIds[0]!;
  if (remote.agentId !== remoteAgentId) {
    throw new PeerValidationError('invite agent mismatch', 'invite_mismatch', 409);
  }

  const existing = ctx.db.findOutboundPeer(info.serverId, remoteAgentId);
  const connectionId = existing?.id ?? `peer_${randomUUID()}`;
  const now = Date.now();
  ctx.db.upsertPeer({
    id: connectionId,
    direction: 'out',
    server_id: info.serverId,
    remote_agent_id: remoteAgentId,
    label: input.label?.trim() || remote.publicName || invite.baseUrl,
    base_url: invite.baseUrl,
    fingerprint: info.serverId,
    token_cipher: invite.token,
    last_seen_at: now,
    created_at: existing?.created_at ?? now,
  });

  const current = listAgents(ctx.db, workspace.id).find(
    (agent) =>
      agent.kind === 'peer' &&
      agent.peerId === connectionId &&
      agent.remoteAgentId === remoteAgentId,
  );
  if (current) {
    updateRemoteAgent(ctx.db, workspace, current, remote.publicName, remote.summary);
  } else {
    createRemoteAgent(
      ctx.db,
      workspace,
      connectionId,
      remoteAgentId,
      remote.publicName,
      remote.summary,
    );
  }
  return toConnection(ctx, connectionId)!;
}

export function listPeerConnections(ctx: AppContext): PeerConnectionDto[] {
  return ctx.db
    .listPeers('out')
    .map((peer) => toConnection(ctx, peer.id))
    .filter((peer): peer is PeerConnectionDto => peer !== null);
}

export function removePeerConnection(ctx: AppContext, peerId: string): void {
  for (const workspace of ctx.db.listWorkspaces()) {
    for (const agent of listAgents(ctx.db, workspace.id)) {
      if (agent.kind !== 'peer' || agent.peerId !== peerId) continue;
      // A peer may lead its own 1:1 session. Hand that room to a local member
      // (or the workspace default) before removing it, otherwise `removeAgent`
      // refuses forever and the connection is left pointing at nothing.
      for (const sessionId of ctx.db.listSessionsForAgent(agent.id)) {
        if (getLeader(ctx.db, sessionId)?.id !== agent.id) continue;
        const members = listSessionAgents(ctx.db, sessionId)
          .map((row) => row.agent)
          .filter((member) => member.id !== agent.id);
        const fallback =
          members.find((member) => member.kind !== 'peer' && !member.readOnly) ??
          members.find((member) => member.kind !== 'peer') ??
          defaultAgentFor(ctx.db, workspace.id) ??
          members[0];
        if (fallback) {
          adoptLeader(ctx.db, { id: sessionId, workspaceId: workspace.id }, fallback);
        } else {
          ctx.db.deleteSession(sessionId);
        }
      }
      // One connection owns exactly one assistant; disconnecting removes it.
      // History keeps the deleted speaker's name via the message's agent id.
      try {
        removeAgent(ctx.db, agent.id);
      } catch {
        // A partially deleted room should not block tearing the connection down.
      }
    }
  }
  ctx.db.deletePeer(peerId);
}

/** Manual probe: touches `last_seen_at` and reports whether it answered. */
export async function probeConnection(ctx: AppContext, peerId: string): Promise<{ online: boolean }> {
  const peer = ctx.db.getPeer(peerId);
  if (!peer) throw new PeerValidationError('peer not found', 'not_found', 404);
  try {
    await probePeer(peer.base_url, peer.token_cipher ?? undefined);
    ctx.db.touchPeer(peerId, Date.now());
    return { online: true };
  } catch {
    return { online: false };
  }
}

function toConnection(ctx: AppContext, peerId: string): PeerConnectionDto | null {
  const peer = ctx.db.getPeer(peerId);
  if (!peer || peer.direction !== 'out') return null;
  const agents = ctx.db.listWorkspaces().flatMap((workspace) =>
    listAgents(ctx.db, workspace.id)
      .filter((agent) => agent.kind === 'peer' && agent.peerId === peerId)
      .map((agent) => ({
        localAgentId: agent.id,
        remoteAgentId: agent.remoteAgentId ?? '',
        name: agent.name,
        summary: agent.summary || agent.name,
        enabled: agent.enabled,
      })),
  );
  return {
    id: peer.id,
    label: peer.label || peer.base_url,
    baseUrl: peer.base_url,
    online: peer.last_seen_at !== null && Date.now() - peer.last_seen_at < 5 * 60 * 1000,
    lastSeenAt: peer.last_seen_at,
    agents,
  };
}

function resolveWorkspace(ctx: AppContext, workspaceId: string | undefined): WorkspaceRow {
  const workspace = workspaceId
    ? ctx.db.getWorkspace(workspaceId)
    : (ctx.db.getDefaultWorkspace() ?? ctx.db.listWorkspaces()[0]);
  if (!workspace) throw new PeerValidationError('workspace not found', 'workspace_missing', 404);
  return workspace;
}

function createRemoteAgent(
  db: AppContext['db'],
  workspace: WorkspaceRow,
  peerId: string,
  remoteAgentId: string,
  publicName: string,
  summary: string,
): void {
  const base = publicName.trim() || '远端助手';
  for (const name of [base, `${base}·远端`]) {
    try {
      createAgent(db, workspace, {
        workspaceId: workspace.id,
        name,
        summary,
        kind: 'peer',
        peerId,
        remoteAgentId,
      });
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'name_taken') throw error;
    }
  }
  throw new PeerValidationError(
    `a local agent named "${base}" already exists; rename it before joining`,
    'name_taken',
    409,
  );
}

function updateRemoteAgent(
  db: AppContext['db'],
  workspace: WorkspaceRow,
  agent: Agent,
  name: string,
  summary: string,
): void {
  try {
    updateAgent(db, workspace, agent.id, {
      name: name.trim() || agent.name,
      summary,
      enabled: true,
    });
  } catch (error) {
    // A rename that collides locally must not break re-joining the same machine.
    if ((error as { code?: string }).code !== 'name_taken') throw error;
  }
}
