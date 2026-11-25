import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { Express, Request, Response } from 'express';
import type { ServerResponse } from 'node:http';
import { getAgent } from '../agents/index.js';
import type { Agent } from '../agents/index.js';
import type { AppContext } from '../app/context.js';
import type { RunRow } from '../db/db.js';
import { resolveServerId } from '../db/server-id.js';
import { authGuest } from '../http/auth.js';
import type { GuestPrincipal } from '../http/auth.js';
import { isTerminalEvent, sseHeaders, writeSseFrame } from '../http/sse.js';
import type { RunSink } from '../runs/run-service.js';
import type { AttachmentMediaType } from '../types/attachments.js';
import {
  assertPeerInputBudget,
  createInvite,
  exposeAgent,
  findGuestCredential,
  getExposure,
  isShareableBackend,
  joinPeer,
  listPeerConnections,
  loopbackInviteHost,
  pickAdvertisedHost,
  parseStoredContract,
  PeerValidationError,
  probeConnection,
  redeemInvite,
  relayPermissionDecision,
  removePeerConnection,
  revokeAgentAccess,
  startPeerRun,
  PEER_PROTOCOL_VERSION,
} from '../peer/index.js';
import type { ExposedAgentContract, PeerMetaEvent, PeerRunHandle } from '../peer/index.js';
import { getActiveRun } from '../runtimes/active-runs.js';
import { runningRunIdsBySession } from '../runs/session-runs.js';
import type {
  NormalizedEvent,
  PeerContractDto,
  PeerExposedAgentDto,
  PeerInfoDto,
  PeerInviteDto,
  PeerRedeemDto,
  PeerSessionDto,
  SseFrame,
} from '../types/api.js';

/**
 * A-side peer surface.
 *
 * `GET /api/peer/info` is deliberately mounted before the auth gate: a peer
 * needs to see who it is about to connect to before it has a token. It exposes
 * only display names and contract versions — never dirs, tokens, or token state.
 */
export function registerPeerInfoRoute(app: Express, ctx: AppContext): void {
  app.get('/api/peer/info', (req, res) => {
    // Identity is public; the *list* is scoped to the presented token. An
    // anonymous caller learns `serverId` only — otherwise anyone on the LAN
    // could enumerate every exposed agent.
    const raw = bearer(req);
    let allowed: Set<string> | null = null;
    if (raw) {
      const credential = findGuestCredential(ctx.db, raw);
      if (!credential) {
        res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
        return;
      }
      allowed = new Set(credential.agentIds);
    }
    const agents = [];
    for (const row of allowed ? ctx.db.listExposedAgents() : []) {
      if (row.enabled !== 1 || !allowed?.has(row.agent_id)) continue;
      const agent = getAgent(ctx.db, row.agent_id);
      // A legacy exposure for Codex/DeepSeek must not be advertised; the run
      // path rejects it too, so pretending it is available would be worse.
      if (!agent || !isShareableBackend(agent.kind, agent.runtime)) continue;
      try {
        const contract = parseStoredContract(row.contract_json);
        agents.push({
          agentId: row.agent_id,
          publicName: contract.publicName,
          summary: contract.summary,
          contractVersion: contract.version,
        });
      } catch {
        // A hand-edited/broken contract is simply not advertised.
      }
    }
    const body: PeerInfoDto = {
      serverId: resolveServerId(ctx.db),
      protocolVersion: PEER_PROTOCOL_VERSION,
      agents,
    };
    res.json(body);
  });
}

export function registerPeerRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/peer/peers', (_req, res) => {
    wrap(res, () => {
      res.json({ peers: listPeerConnections(ctx) });
    });
  });

  app.post('/api/peer/peers', (req, res) => {
    void (async () => {
      try {
        const body = isRecord(req.body) ? req.body : {};
        const url = typeof body['url'] === 'string' ? body['url'] : '';
        if (!url) {
          res.status(400).json({ error: 'url is required', code: 'bad_request' });
          return;
        }
        const peer = await joinPeer(ctx, {
          url,
          workspaceId: typeof body['workspaceId'] === 'string' ? body['workspaceId'] : undefined,
          label: typeof body['label'] === 'string' ? body['label'] : undefined,
        });
        res.json(peer);
      } catch (error) {
        sendPeerError(res, error);
      }
    })();
  });

  app.delete('/api/peer/peers/:id', (req, res) => {
    wrap(res, () => {
      removePeerConnection(ctx, String(req.params['id']));
      res.status(204).end();
    });
  });

  app.post('/api/peer/peers/:id/probe', (req, res) => {
    void (async () => {
      try {
        res.json(await probeConnection(ctx, String(req.params['id'])));
      } catch (error) {
        sendPeerError(res, error);
      }
    })();
  });

  /**
   * A-side monitoring: hidden sessions a remote peer is driving, with who is
   * behind them. Read-only by contract — the exposing side watches, the guest
   * keeps control (see the `/turns` guard in routes/room).
   */
  app.get('/api/peer/sessions', (req, res) => {
    wrap(res, () => {
      const workspaceId =
        typeof req.query['workspaceId'] === 'string' && req.query['workspaceId']
          ? req.query['workspaceId']
          : undefined;
      if (workspaceId && !ctx.db.getWorkspace(workspaceId)) {
        res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
        return;
      }
      const running = runningRunIdsBySession(ctx);
      const sessions: PeerSessionDto[] = [];
      for (const session of ctx.db.listPeerSessions(workspaceId)) {
        const thread = ctx.db.getPeerThreadBySession(session.id);
        if (!thread) continue;
        const peer = ctx.db.getPeer(thread.peer_id);
        const agent = ctx.db.getAgent(thread.agent_id);
        const runningRunIds = running.get(session.id) ?? [];
        sessions.push({
          id: session.id,
          workspaceId: session.workspace_id,
          title: session.title,
          agentId: thread.agent_id,
          agentName: agent?.name ?? thread.agent_id,
          peerId: thread.peer_id,
          peerLabel: peer?.label?.trim() || peer?.server_id || thread.peer_id,
          threadKey: thread.thread_key,
          running: runningRunIds.length > 0,
          runningRunIds,
          lastActiveAt: session.last_active_at,
          createdAt: session.created_at,
        });
      }
      res.json({ sessions });
    });
  });

  app.get('/api/peer/agent', (req, res) => {
    wrap(res, () => {
      const guest = authGuest(res);
      const requested = typeof req.query.agentId === 'string' ? req.query.agentId : '';
      const agentId = requested || (guest && guest.agentIds.length === 1 ? guest.agentIds[0]! : '');
      if (!agentId) {
        res.status(400).json({ error: 'agentId is required', code: 'agent_required' });
        return;
      }
      if (guest && !guest.agentIds.includes(agentId)) {
        res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        return;
      }
      const exposure = getExposure(ctx.db, agentId);
      const agent = getAgent(ctx.db, agentId);
      if (!exposure || !exposure.enabled) {
        res.status(404).json({ error: 'agent is not shared', code: 'agent_not_exposed' });
        return;
      }
      if (!agent || !isShareableBackend(agent.kind, agent.runtime)) {
        res.status(403).json({ error: 'agent backend is not shareable', code: 'backend_not_supported' });
        return;
      }
      res.json({ enabled: true, contract: contractDto(exposure.contract) });
    });
  });

  app.post('/api/peer/redeem', (req, res) => {
    wrap(res, () => {
      const guest = authGuest(res);
      if (!guest) {
        res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
        return;
      }
      if (!guest.inviteId) {
        // Already redeemed; making it idempotent avoids a pointless re-pair.
        const body: PeerRedeemDto = { peerId: guest.peerId, agentIds: guest.agentIds };
        res.json(body);
        return;
      }
      const raw = bearer(req);
      if (!raw) {
        res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
        return;
      }
      const input = isRecord(req.body) ? req.body : {};
      const result = redeemInvite(ctx.db, {
        token: raw,
        peerId: typeof input['peerId'] === 'string' ? input['peerId'] : undefined,
        label: typeof input['label'] === 'string' ? input['label'] : undefined,
        baseUrl: typeof input['baseUrl'] === 'string' ? input['baseUrl'] : undefined,
      });
      const body: PeerRedeemDto = { peerId: result.peerId, agentIds: result.agentIds };
      res.json(body);
    });
  });

  app.post('/api/peer/runs', (req, res) => {
    void handleStartPeerRun(ctx, req, res);
  });

  app.get('/api/peer/runs/:id/stream', (req, res) => {
    wrap(res, () => {
      const guest = authGuest(res);
      const run = requireGuestRun(ctx, res, String(req.params['id']), guest);
      if (!run) return;
      const after = Number(req.query['after'] ?? 0);
      if (!Number.isInteger(after) || after < 0) {
        res.status(400).json({ error: 'invalid after cursor', code: 'bad_request' });
        return;
      }
      replayPeerStream(ctx, res, run, after);
    });
  });

  app.post('/api/peer/runs/:id/cancel', (req, res) => {
    wrap(res, () => {
      const guest = authGuest(res);
      const run = requireGuestRun(ctx, res, String(req.params['id']), guest);
      if (!run) return;
      const active = getActiveRun(run.id);
      if (!active) {
        res.status(404).json({ error: 'run not found or already finished', code: 'run_not_found' });
        return;
      }
      active.cancel('cancelled by peer');
      ctx.db.audit('cancel', run.id);
      res.json({ ok: true, runId: run.id });
    });
  });

  app.post('/api/peer/runs/:id/permission', (req, res) => {
    void (async () => {
      try {
        const body = isRecord(req.body) ? req.body : {};
        const permissionId = typeof body['permissionId'] === 'string' ? body['permissionId'] : '';
        const decision = body['decision'];
        if (!permissionId || (decision !== 'allow' && decision !== 'deny')) {
          res.status(400).json({ error: 'permissionId and decision are required', code: 'bad_request' });
          return;
        }
        const guest = authGuest(res);
        if (!guest) {
          // B side: an operator relays the decision back to the machine running
          // the agent. The permission id belongs to A, not to our PermissionManager.
          const run = ctx.db.getRun(String(req.params['id']));
          const peer = run?.peer_id ? ctx.db.getPeer(run.peer_id) : undefined;
          if (!run || !run.remote_run_id || !peer || !peer.token_cipher) {
            res.status(404).json({ error: 'run not found', code: 'run_not_found' });
            return;
          }
          await relayPermissionDecision(
            peer.base_url,
            peer.token_cipher,
            run.remote_run_id,
            permissionId,
            decision,
          );
          res.json({ ok: true });
          return;
        }
        // A side: the guest decides a permission its own run raised.
        const run = requireGuestRun(ctx, res, String(req.params['id']), guest);
        if (!run) return;
        const pending = ctx.permissions.get(permissionId);
        if (!pending || pending.runId !== run.id) {
          res.status(404).json({ error: 'permission not found', code: 'permission_not_found' });
          return;
        }
        const decided = ctx.permissions.decide(permissionId, decision, 'peer relay');
        res.json({ ok: true, status: decided?.status ?? 'pending' });
      } catch (error) {
        sendPeerError(res, error);
      }
    })();
  });

  app.get('/api/agent-profiles/:id/exposed', (req, res) => {
    wrap(res, () => {
      const exposure = getExposure(ctx.db, req.params['id'] as string);
      if (!exposure) {
        res.status(404).json({ error: 'not exposed', code: 'not_found' });
        return;
      }
      res.json(exposureDto(exposure));
    });
  });

  app.post('/api/agent-profiles/:id/exposed', (req, res) => {
    wrap(res, () => {
      const agent = requireAgent(ctx, req.params['id'] as string, res);
      if (!agent) return;
      const workspace = ctx.db.getWorkspace(agent.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: 'workspace not found', code: 'not_found' });
        return;
      }
      const body = isRecord(req.body) ? req.body : {};
      const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined;
      const exposure = exposeAgent(ctx.db, {
        agent: {
          id: agent.id,
          name: agent.name,
          summary: agent.summary,
          kind: agent.kind,
          runtime: agent.runtime,
        },
        workspacePath: workspace.path,
        patch: body,
        enabled,
      });
      res.json(exposureDto(exposure));
    });
  });

  app.post('/api/agent-profiles/:id/exposed/invites', (req, res) => {
    wrap(res, () => {
      const agent = requireAgent(ctx, req.params['id'] as string, res);
      if (!agent) return;
      const body = isRecord(req.body) ? req.body : {};
      const requested = Array.isArray(body['agentIds'])
        ? body['agentIds'].filter((id): id is string => typeof id === 'string')
        : [];
      if (requested.length > 0 && (requested.length !== 1 || requested[0] !== agent.id)) {
        res.status(400).json({
          error: 'an invite targets exactly this agent',
          code: 'single_agent_only',
        });
        return;
      }
      const agentIds = [agent.id];
      const ttlMs = typeof body['ttlMs'] === 'number' ? body['ttlMs'] : undefined;
      const invite = createInvite(ctx.db, { agentIds, ttlMs });
      const bodyDto: PeerInviteDto = {
        url: inviteUrl(req, ctx, invite.token, invite.expiresAt),
        agentIds: invite.agentIds,
        expiresAt: invite.expiresAt,
      };
      res.json(bodyDto);
    });
  });

  app.delete('/api/agent-profiles/:id/exposed/tokens', (req, res) => {
    wrap(res, () => {
      const agent = requireAgent(ctx, req.params['id'] as string, res);
      if (!agent) return;
      res.json(revokeAgentAccess(ctx.db, agent.id));
    });
  });
}

/** Used by `app/server.ts` to resolve guest bearer tokens from the DB. */
export function guestTokenResolver(ctx: AppContext) {
  return (token: string) => findGuestCredential(ctx.db, token);
}

function requireAgent(ctx: AppContext, id: string, res: Response): Agent | null {
  const agent = getAgent(ctx.db, id);
  if (!agent) {
    res.status(404).json({ error: 'agent not found', code: 'not_found' });
    return null;
  }
  return agent;
}

function exposureDto(exposure: ReturnType<typeof getExposure>): PeerExposedAgentDto {
  if (!exposure) throw new Error('exposure dto requires a value');
  return {
    agentId: exposure.agentId,
    enabled: exposure.enabled,
    contract: contractDto(exposure.contract),
    hasTokens: exposure.hasTokens,
  };
}

function contractDto(contract: ExposedAgentContract): PeerContractDto {
  return {
    agentId: contract.agentId,
    publicName: contract.publicName,
    summary: contract.summary,
    access: contract.access,
    dirs: contract.dirs,
    approvalPolicy: contract.approvalPolicy,
    maxConcurrentRuns: contract.maxConcurrentRuns,
    quota: contract.quota,
    capture: contract.capture,
    protocolVersion: contract.protocolVersion,
    version: contract.version,
  };
}

function inviteUrl(req: Request, ctx: AppContext, token: string, expiresAt: number): string {
  const header = req.get('host') ?? '';
  let headerHost = '';
  let port = String(ctx.config.port);
  if (header) {
    try {
      const parsed = new URL(`http://${header}`);
      headerHost = parsed.hostname;
      port = parsed.port || port;
    } catch {
      // Keep the config fallback; a malformed Host header is not worth a 500.
    }
  }
  // The desktop reaches us at 127.0.0.1, which is useless in an invite for
  // another machine. Prefer a real interface address in that case.
  const host =
    pickAdvertisedHost({
      hostHeader: headerHost,
      configuredHost: ctx.config.host,
      interfaces: os.networkInterfaces(),
    }) ?? loopbackInviteHost();
  const params = new URLSearchParams({
    host,
    port,
    fp: resolveServerId(ctx.db),
    t: token,
    exp: String(expiresAt),
  });
  return `paboot://join?${params.toString()}`;
}

// ── peer runs (A side) ──────────────────────────────────────────────────

const MAX_PROMPT_CHARS = 32_000;
const MAX_ROOM_CHARS = 20_000;
const MAX_IMAGES = 4;

const IMAGE_TYPES = new Set<AttachmentMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

async function handleStartPeerRun(ctx: AppContext, req: Request, res: Response): Promise<void> {
  let runId = '';
  let retryKey: { peerId: string; clientRunId: string; threadKey: string; agentId: string } | null = null;
  try {
    const guest = authGuest(res);
    if (!guest) {
      res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const agentId = readField(body, 'agentId', 128);
    const clientRunId = readField(body, 'clientRunId', 128);
    const threadKey = readField(body, 'threadKey', 128);
    const prompt = readField(body, 'prompt', MAX_PROMPT_CHARS);
    retryKey = { peerId: guest.peerId, clientRunId, threadKey, agentId };
    if (!guest.agentIds.includes(agentId)) {
      res.status(403).json({ error: 'forbidden', code: 'forbidden' });
      return;
    }
    const exposure = getExposure(ctx.db, agentId);
    if (!exposure || !exposure.enabled) {
      res.status(403).json({ error: 'agent is not shared', code: 'agent_disabled' });
      return;
    }

    const existing = ctx.db.getRunByPeerClientRun(guest.peerId, clientRunId);
    if (existing) {
      if (existing.agent_id !== agentId) {
        res.status(409).json({ error: 'clientRunId belongs to another agent', code: 'client_run_conflict' });
        return;
      }
      streamExistingPeerRun(ctx, res, existing, 0, peerMetaFor(ctx, guest, existing, threadKey, true));
      return;
    }

    const roomContext = buildRoomContext(body['room']);
    assertPeerInputBudget({
      runId: '',
      peerId: guest.peerId,
      agentId,
      clientRunId,
      threadKey,
      prompt,
      contract: exposure.contract,
      roomContext,
    });
    const attachmentIds = await savePeerImages(ctx, body['attachments']);

    const agent = getAgent(ctx.db, agentId);
    const workspace = agent ? ctx.db.getWorkspace(agent.workspaceId) : undefined;
    if (!agent || !workspace) {
      res.status(404).json({ error: 'agent not found', code: 'not_found' });
      return;
    }
    const mapping = ctx.db.getPeerThread(guest.peerId, threadKey);
    const threadResumed = Boolean(mapping && ctx.db.getSession(mapping.session_id));
    runId = `pr_${randomUUID()}`;
    const meta: PeerMetaEvent = {
      type: 'peer_meta',
      runId,
      threadKey,
      cwd: agent.cwd ?? workspace.path,
      contractVersion: exposure.contract.version,
      threadResumed,
      agent: { id: agent.id, name: agent.name },
    };

    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      res.end();
    };
    const sink: RunSink = {
      begin() {
        res.writeHead(200, sseHeaders());
        writePeerMeta(res, meta);
      },
      frame(frame: SseFrame) {
        writeSseFrame(res, frame);
        if (isTerminalEvent(frame.event)) finish();
      },
      end: finish,
    };
    let handle: PeerRunHandle;
    try {
      handle = startPeerRun(
        ctx,
        {
          runId,
          peerId: guest.peerId,
          agentId,
          clientRunId,
          threadKey,
          prompt,
          contract: exposure.contract,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(roomContext ? { roomContext } : {}),
        },
        sink,
      );
    } catch (error) {
      if (!res.headersSent) throw error;
      writePeerError(res, runId, error);
      finish();
      return;
    }
    void handle.done.finally(finish);
  } catch (error) {
    if (res.headersSent) {
      writePeerError(res, runId, error);
      res.end();
      return;
    }
    // Two concurrent identical requests can race past the pre-check; the DB
    // unique index rejects the loser. Attach it to the winner instead of 500.
    if (retryKey) {
      const existing = ctx.db.getRunByPeerClientRun(retryKey.peerId, retryKey.clientRunId);
      const guest = authGuest(res);
      if (existing && guest && existing.agent_id === retryKey.agentId) {
        streamExistingPeerRun(
          ctx,
          res,
          existing,
          0,
          peerMetaFor(ctx, guest, existing, retryKey.threadKey, true),
        );
        return;
      }
    }
    sendPeerError(res, error);
  }
}

function replayPeerStream(
  ctx: AppContext,
  res: ServerResponse,
  run: RunRow,
  after: number,
  meta?: PeerMetaEvent,
): void {
  res.writeHead(200, sseHeaders());
  let ended = false;
  let unsubscribe: (() => void) | undefined;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    res.end();
  };
  const write = (frame: SseFrame): void => {
    writeSseFrame(res, frame);
    if (isTerminalEvent(frame.event)) finish();
  };
  if (meta && after === 0) writePeerMeta(res, meta);
  for (const row of ctx.db.listReplayEvents(run.id, after)) {
    write({ runId: run.id, seq: row.seq, event: JSON.parse(row.payload) as NormalizedEvent });
    if (ended) return;
  }
  if (run.status !== 'running') {
    finish();
    return;
  }
  unsubscribe = ctx.notifier.subscribe(run.id, write);
  res.on('close', () => {
    unsubscribe?.();
  });
}

function streamExistingPeerRun(
  ctx: AppContext,
  res: Response,
  run: RunRow,
  after: number,
  meta: PeerMetaEvent,
): void {
  replayPeerStream(ctx, res, run, after, meta);
}

function peerMetaFor(
  ctx: AppContext,
  guest: GuestPrincipal,
  run: RunRow,
  threadKey: string,
  resumedFallback: boolean,
): PeerMetaEvent {
  const mapping = ctx.db.getPeerThread(guest.peerId, threadKey);
  const session = mapping ? ctx.db.getSession(mapping.session_id) : ctx.db.getSession(run.session_id);
  const agent = run.agent_id ? getAgent(ctx.db, run.agent_id) : undefined;
  const exposure = run.agent_id ? getExposure(ctx.db, run.agent_id) : null;
  return {
    type: 'peer_meta',
    runId: run.id,
    threadKey,
    cwd: session?.cwd ?? '',
    contractVersion: exposure?.contract.version ?? 0,
    threadResumed: mapping ? Boolean(session) : resumedFallback,
    agent: { id: run.agent_id ?? '', name: agent?.name ?? '' },
  };
}

function writePeerMeta(res: ServerResponse, meta: PeerMetaEvent): void {
  writeSseFrame(res, {
    runId: meta.runId,
    seq: 0,
    event: meta as unknown as NormalizedEvent,
  });
}

function writePeerError(res: ServerResponse, runId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeSseFrame(res, {
    runId,
    seq: 0,
    event: { type: 'error', message, terminal: true } as NormalizedEvent,
  });
}

function requireGuestRun(
  ctx: AppContext,
  res: Response,
  runId: string,
  guest: GuestPrincipal | undefined,
): RunRow | null {
  const run = ctx.db.getRun(runId);
  if (
    !guest ||
    !run ||
    run.trigger !== 'peer' ||
    run.peer_id !== guest.peerId ||
    !run.agent_id ||
    !guest.agentIds.includes(run.agent_id)
  ) {
    res.status(404).json({ error: 'run not found', code: 'run_not_found' });
    return null;
  }
  return run;
}

async function savePeerImages(ctx: AppContext, raw: unknown): Promise<string[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PeerValidationError('attachments must be an array', 'invalid_attachments');
  }
  if (raw.length > MAX_IMAGES) {
    throw new PeerValidationError(`at most ${MAX_IMAGES} images are allowed`, 'invalid_attachments');
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['data'] !== 'string' || typeof entry['mediaType'] !== 'string') {
      throw new PeerValidationError('each attachment needs mediaType and base64 data', 'invalid_attachments');
    }
    const mediaType = entry['mediaType'] as AttachmentMediaType;
    if (!IMAGE_TYPES.has(mediaType)) {
      throw new PeerValidationError(`unsupported media type: ${entry['mediaType']}`, 'invalid_attachments');
    }
    try {
      const row = await ctx.attachments.saveImage(Buffer.from(entry['data'], 'base64'), mediaType);
      ids.push(row.id);
    } catch (error) {
      throw new PeerValidationError(
        error instanceof Error ? error.message : 'invalid image',
        'invalid_attachments',
      );
    }
  }
  return ids;
}

function buildRoomContext(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new PeerValidationError('room must be an object', 'invalid_room');
  const text = JSON.stringify(raw);
  if (text.length > MAX_ROOM_CHARS) {
    throw new PeerValidationError('room context is too large', 'invalid_room');
  }
  return `<peer-room>\n${text}\n</peer-room>`;
}

function readField(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new PeerValidationError(`${key} must be a string`, 'bad_request');
  }
  const text = value.trim();
  if (text === '' || text.length > max) {
    throw new PeerValidationError(`${key} must be 1-${max} characters`, 'bad_request');
  }
  return text;
}

function sendPeerError(res: Response, error: unknown): void {
  if (error instanceof PeerValidationError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: 'internal error', code: 'internal_error' });
}

function bearer(req: Request): string {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wrap(res: Response, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof PeerValidationError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}
