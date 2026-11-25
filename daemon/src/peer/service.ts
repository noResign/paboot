import { randomUUID } from 'node:crypto';
import type { Db, ExposedAgentRow, PeerTokenRow } from '../db/db.js';
import {
  buildContract,
  isShareableBackend,
  parseStoredContract,
  PeerValidationError,
} from './contract.js';
import { generatePeerToken, hashPeerToken, peerTokenId } from './token.js';
import type {
  ContractAgent,
  CreatedInvite,
  ExposedAgentContract,
  ExposedAgentDto,
  GuestCredential,
  GuestTokenInfo,
} from './types.js';

const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Read one exposure and parse its contract; null when the agent was never exposed. */
export function getExposure(db: Db, agentId: string): ExposedAgentDto | null {
  const row = db.getExposedAgent(agentId);
  if (!row) return null;
  return toDto(db, row);
}

export function listExposures(db: Db): ExposedAgentDto[] {
  return db.listExposedAgents().map((row) => toDto(db, row));
}

/**
 * Create or update the contract for one agent. A re-expose bumps `version` and
 * keeps `created_at`; `enabled` defaults to true because the caller explicitly
 * asked to share.
 */
export function exposeAgent(
  db: Db,
  input: {
    agent: ContractAgent;
    workspacePath: string;
    patch?: Record<string, unknown>;
    enabled?: boolean;
    now?: number;
  },
): ExposedAgentDto {
  if (input.agent.kind === 'peer') {
    throw new PeerValidationError('a peer agent cannot be exposed again', 'cannot_expose_peer');
  }
  if (!isShareableBackend(input.agent.kind, input.agent.runtime)) {
    throw new PeerValidationError(
      'only builtin and Claude agents can be shared in v1',
      'backend_not_supported',
      400,
    );
  }
  const existing = db.getExposedAgent(input.agent.id);
  const previous = existing ? parseStoredContract(existing.contract_json) : undefined;
  const contract = buildContract({
    agent: input.agent,
    workspacePath: input.workspacePath,
    previous,
    patch: input.patch,
  });
  const now = input.now ?? Date.now();
  // Editing a contract must not silently re-open a paused share: default to the
  // previous `enabled` state, not to true.
  const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);
  db.upsertExposedAgent({
    agent_id: input.agent.id,
    contract_json: JSON.stringify(contract),
    enabled: enabled ? 1 : 0,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  return toDto(db, db.getExposedAgent(input.agent.id) as ExposedAgentRow);
}

/** Pause/resume without touching the contract body. */
export function setExposureEnabled(db: Db, agentId: string, enabled: boolean, now = Date.now()): ExposedAgentDto {
  if (!db.getExposedAgent(agentId)) {
    throw new PeerValidationError(`agent is not exposed: ${agentId}`, 'not_found', 404);
  }
  db.setExposedAgentEnabled(agentId, enabled, now);
  return toDto(db, db.getExposedAgent(agentId) as ExposedAgentRow);
}

/**
 * One-shot pairing link. The returned raw token is a guest credential: only its
 * hash is stored, and `single_use` means the link cannot be redeemed twice.
 */
export function createInvite(
  db: Db,
  input: { agentIds: string[]; ttlMs?: number; now?: number },
): CreatedInvite {
  const agentIds = [...new Set(input.agentIds)];
  if (agentIds.length !== 1) {
    // One connection authorizes one agent. Bundling agents into one invite is
    // the machine-wide model this product deliberately does not use.
    throw new PeerValidationError(
      'an invite must target exactly one agent',
      'single_agent_only',
      400,
    );
  }
  for (const agentId of agentIds) {
    const agent = db.getAgent(agentId);
    if (!agent || !isShareableBackend(agent.kind, agent.runtime)) {
      throw new PeerValidationError(
        `agent backend is not shareable: ${agentId}`,
        'backend_not_supported',
        409,
      );
    }
    const row = db.getExposedAgent(agentId);
    if (!row || row.enabled !== 1) {
      throw new PeerValidationError(`agent is not exposed and enabled: ${agentId}`, 'agent_not_exposed', 409);
    }
  }
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_INVITE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_INVITE_TTL_MS) {
    throw new PeerValidationError('ttlMs must be between 1ms and 7 days', 'invalid_ttl');
  }
  const id = randomUUID();
  const token = generatePeerToken();
  db.insertPeerInvite({
    id,
    token_hash: hashPeerToken(token),
    agent_ids: JSON.stringify(agentIds),
    expires_at: now + ttlMs,
    single_use: 1,
    consumed_at: null,
    created_at: now,
  });
  return { id, token, agentIds, expiresAt: now + ttlMs };
}

/**
 * Redeem an invite on the guest's first authenticated call.
 *
 * The invite token stays the guest token for subsequent calls; redemption just
 * binds it to an `in` peer row and materialises the `peer_tokens` entry. If the
 * guest supplies its stable `peerId` (its serverId), re-redeeming the same link
 * is rejected by `single_use`.
 */
export function redeemInvite(
  db: Db,
  input: { token: string; peerId?: string; label?: string; baseUrl?: string; now?: number },
): GuestTokenInfo {
  const hash = hashPeerToken(input.token);
  const now = input.now ?? Date.now();
  // Everything from the single-use check to the consume is one BEGIN IMMEDIATE
  // transaction: two concurrent redemptions must not both mint a token, and the
  // second one sees `consumed_at` set by the first.
  return db.transaction(() => {
    const invite = db.getPeerInviteByHash(hash);
    if (!invite) {
      throw new PeerValidationError('invite not found', 'invite_not_found', 404);
    }
    if (invite.consumed_at !== null) {
      throw new PeerValidationError('invite was already used', 'invite_consumed', 410);
    }
    if (invite.expires_at <= now) {
      throw new PeerValidationError('invite expired', 'invite_expired', 410);
    }
    const agentIds = parseStringArray(invite.agent_ids);
    const peerId = readPeerId(input.peerId);
    const existing = db.getPeer(peerId);
    if (existing && existing.direction !== 'in') {
      // The same serverId cannot be both the machine we call and a caller.
      throw new PeerValidationError('peer id already used by an outbound peer', 'peer_id_conflict', 409);
    }
    const tokenId = peerTokenId();
    if (!existing) {
      db.upsertPeer({
        id: peerId,
        direction: 'in',
        server_id: peerId,
        remote_agent_id: agentIds.length === 1 ? agentIds[0]! : null,
        label: input.label?.trim() ?? '',
        base_url: input.baseUrl?.trim() ?? '',
        fingerprint: null,
        token_cipher: null,
        last_seen_at: now,
        created_at: now,
      });
    }
    db.insertPeerToken({
      id: tokenId,
      peer_id: peerId,
      token_hash: hash,
      scopes: JSON.stringify(agentIds),
      created_at: now,
      // The invite is short-lived; the connection it establishes is not.
      // v1 has no renewal flow, so the token lives until it is revoked.
      expires_at: null,
      revoked_at: null,
      last_used_at: now,
    });
    db.consumePeerInvite(invite.id, now);
    return { tokenId, peerId, agentIds };
  });
}

function readPeerId(raw: string | undefined): string {
  const peerId = raw?.trim() ?? '';
  if (!peerId) return randomUUID();
  if (peerId.length > 128 || /\s/.test(peerId)) {
    throw new PeerValidationError('peerId must be 1-128 characters without whitespace', 'invalid_peer_id');
  }
  return peerId;
}

/** Resolve a presented guest token. Revoked/unknown tokens return null. */
export function findGuestToken(db: Db, rawToken: string, now = Date.now()): GuestTokenInfo | null {
  const row = db.getPeerTokenByHash(hashPeerToken(rawToken));
  if (!row || row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;
  // `last_used_at` is informational; writing it on every stream tick would
  // turn auth into a hot write path for no operational gain.
  if (row.last_used_at === null || now - row.last_used_at > 60_000) {
    db.touchPeerToken(row.id, now);
  }
  return { tokenId: row.id, peerId: row.peer_id, agentIds: parseStringArray(row.scopes) };
}

/**
 * Auth resolver: an issued guest token, or a valid invite that has not been
 * redeemed yet. The invite path only exists so the guest can call `/peer/redeem`
 * and perform its first probe; redemption turns it into a durable token.
 */
export function findGuestCredential(
  db: Db,
  rawToken: string,
  now = Date.now(),
): GuestCredential | null {
  const issued = findGuestToken(db, rawToken, now);
  if (issued) return issued;
  const invite = db.getPeerInviteByHash(hashPeerToken(rawToken));
  if (!invite || invite.consumed_at !== null || invite.expires_at <= now) return null;
  return {
    tokenId: '',
    peerId: '',
    agentIds: parseStringArray(invite.agent_ids),
    inviteId: invite.id,
  };
}

/**
 * Revoke every guest token that can address this agent. Tokens are shared by
 * agent scope, so a token that also names other agents keeps working for them.
 */
export function revokeAgentAccess(db: Db, agentId: string, now = Date.now()): { revoked: number } {
  let revoked = 0;
  for (const token of db.listAllPeerTokens()) {
    if (token.revoked_at !== null) continue;
    const scopes = parseStringArray(token.scopes);
    if (!scopes.includes(agentId)) continue;
    const remaining = scopes.filter((id) => id !== agentId);
    // Narrow the scope first; a token left with no agents is revoked outright.
    db.setPeerTokenScopes(token.id, JSON.stringify(remaining));
    if (remaining.length === 0) {
      db.revokePeerToken(token.id, now);
      revoked += 1;
    }
  }
  db.setExposedAgentEnabled(agentId, false, now);
  return { revoked };
}

/**
 * Drop an exposure and every credential that can address it. Called when the
 * agent itself is deleted: `agents` must not import `peer/`, so the route does
 * the cleanup at the composition point.
 */
export function removeExposure(db: Db, agentId: string, now = Date.now()): void {
  revokeAgentAccess(db, agentId, now);
  db.deleteExposedAgent(agentId);
}

function toDto(db: Db, row: ExposedAgentRow): ExposedAgentDto {
  const contract: ExposedAgentContract = parseStoredContract(row.contract_json);
  return {
    agentId: row.agent_id,
    enabled: row.enabled === 1,
    contract,
    hasTokens: db
      .listAllPeerTokens()
      .some((token: PeerTokenRow) => token.revoked_at === null && parseStringArray(token.scopes).includes(row.agent_id)),
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
