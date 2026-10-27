import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { PermissionDecision, PermissionRequest } from '../permissions/permissions.js';
import type { PermissionDto } from '../types/api.js';
import { isReadOnlyBash } from '../permissions/command-safety.js';
import { grantKeyCandidates, toGrantKey } from '../permissions/tool-grants.js';

function toDto(p: PermissionRequest): PermissionDto {
  return {
    id: p.id,
    runId: p.runId,
    sessionId: p.sessionId,
    toolName: p.toolName,
    toolInput: p.toolInput,
    status: p.status,
    decisionReason: p.decisionReason,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
  };
}

/**
 * Tool-permission endpoints.
 *
 * Client-facing: `POST /api/permissions/:id/decision` — the remote operator
 * answers allow/deny.
 *
 * Internal (used by the PreToolUse hook subprocess): `create` registers a
 * pending request and broadcasts it to the owning run's SSE stream; `status`
 * is polled by the hook until the request resolves.
 *
 * Reads (`Read`/`Grep`) are not gated at all — the matcher in the chat route
 * leaves them out, so no request for them ever arrives here.
 */
export function registerPermissionRoutes(app: Express, ctx: AppContext): void {
  app.post('/api/permissions/:id/decision', (req, res) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as { decision?: string; reason?: string; response?: unknown };
    const raw = body.decision;

    const pending = ctx.permissions.get(id);
    if (pending?.toolName === 'UserInput') {
      if (pending.status !== 'pending') {
        res.status(409).json({ error: 'request already resolved', code: 'permission_resolved' });
        return;
      }
      // A question cannot be "always allowed" — there is no answer to remember,
      // and remembering one would invent an answer the user never gave.
      if (raw === 'allow_all') {
        res.status(400).json({ error: 'user input cannot be granted automatically', code: 'bad_decision' });
        return;
      }
      const invalid = raw === 'allow' ? pending.validateResponse?.(body.response) : null;
      if (invalid) {
        res.status(400).json({ error: invalid, code: 'bad_response' });
        return;
      }
    }

    if (raw === 'allow_all') {
      const p = ctx.permissions.get(id);
      if (!p) {
        res.status(404).json({ error: 'permission not found', code: 'permission_not_found' });
        return;
      }
      if (p.status !== 'pending') {
        res.status(409).json({ error: 'permission already resolved', code: 'permission_resolved' });
        return;
      }
      const grantKey = toGrantKey(p.toolName);
      ctx.db.addPermissionGrant(p.sessionId, grantKey);
      ctx.permissions.allowAll(p.sessionId, grantKey);
      ctx.db.audit('permission_decision', JSON.stringify({ id, decision: 'allow_all', toolName: p.toolName, grantKey, sessionId: p.sessionId }));
      res.json({ ok: true, permission: toDto(p) });
      return;
    }

    const decision: PermissionDecision | undefined = raw === 'allow' || raw === 'deny' ? raw : undefined;
    if (!decision) {
      res.status(400).json({ error: 'decision must be "allow", "deny", or "allow_all"', code: 'bad_decision' });
      return;
    }
    const p = ctx.permissions.decide(id, decision, typeof body.reason === 'string' ? body.reason : undefined, body.response);
    if (!p) {
      res.status(404).json({ error: 'permission not found', code: 'permission_not_found' });
      return;
    }
    ctx.db.audit('permission_decision', JSON.stringify({ id, decision, toolName: p.toolName }));
    res.json({ ok: true, permission: toDto(p) });
  });

  app.post('/api/internal/permissions/create', (req, res) => {
    const body = (req.body ?? {}) as { runId?: string; toolName?: string; toolInput?: unknown };
    const runId = typeof body.runId === 'string' ? body.runId : '';
    const toolName = typeof body.toolName === 'string' ? body.toolName : '';
    if (!runId || !toolName) {
      res.status(400).json({ error: 'runId and toolName are required', code: 'bad_request' });
      return;
    }
    const sessionId = ctx.db.getRun(runId)?.session_id ?? runId;
    const p = ctx.permissions.create(runId, sessionId, toolName, body.toolInput ?? null);
    // An MCP call is covered either by a server-wide grant or by an exact one
    // (grants written before allowances were widened to the whole server).
    if (grantKeyCandidates(toolName).some((key) => ctx.db.hasPermissionGrant(sessionId, key))) {
      // Already granted for this session: resolve immediately, don't bother the client.
      ctx.permissions.decide(p.id, 'allow', 'auto-allowed');
      res.json({ id: p.id });
      return;
    }
    // Read-only Bash commands (ls, cat, node --version, …) are auto-allowed.
    if (toolName === 'Bash') {
      const input = body.toolInput;
      const command =
        input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string'
          ? (input as { command: string }).command
          : undefined;
      if (command !== undefined && isReadOnlyBash(command)) {
        ctx.permissions.decide(p.id, 'allow', 'read-only command');
        res.json({ id: p.id });
        return;
      }
    }
    // Broadcast to the owning run's SSE stream (no-op if it is already gone —
    // the MCP server will then time out and deny). Remember whether clients saw
    // this pending request: only then does a later resolution need to be pushed.
    p.announced = ctx.notifier.emit(runId, {
      type: 'permission_request',
      permissionId: p.id,
      toolName: p.toolName,
      toolInput: p.toolInput,
      status: p.status,
    });
    res.json({ id: p.id });
  });

  app.get('/api/internal/permissions/:id/status', (req, res) => {
    const p = ctx.permissions.get(req.params.id);
    if (!p) {
      res.status(404).json({ error: 'permission not found', code: 'permission_not_found' });
      return;
    }
    res.json({ status: p.status, decisionReason: p.decisionReason });
  });
}
