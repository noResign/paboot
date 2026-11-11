import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { performDeviceAction } from '../capabilities/device-actions.js';
import { AdbRunner } from '../capabilities/providers/android/adb.js';
import { AndroidDeviceProvider } from '../capabilities/providers/android/index.js';
import {
  resolveCapabilityBindingsForEnd,
  resolveCapabilityTargetEnd,
  resolveSessionEndsScope,
} from '../capabilities/scope.js';
import { CapabilityError, type DeviceProvider } from '../capabilities/types.js';
import type { SessionRow } from '../db/db.js';

export function providerFor(ctx: AppContext): DeviceProvider {
  return ctx.deviceProvider ?? new AndroidDeviceProvider(new AdbRunner());
}

export function sendCapabilityError(res: Response, err: CapabilityError): void {
  const status =
    err.code === 'adb_missing'
      ? 503
      : err.code === 'device_offline' || err.code === 'device_ambiguous'
        ? 409
        : err.code === 'selector_not_found'
          ? 404
          : err.code === 'screenshot_invalid'
            ? 502
            : err.code === 'unknown_action'
              ? 404
              : 400;
  res.status(status).json({ error: err.message, code: err.code });
}

/** Selected serial for one end, respecting session > end > workspace override. */
export function serialFromBinding(
  ctx: AppContext,
  session: SessionRow,
  endId: string,
): string | undefined {
  const end = ctx.db.getEnd(endId);
  if (!end) return undefined;
  const binding = resolveCapabilityBindingsForEnd(ctx.db, session, end).find(
    (item) => item.descriptor.id === 'android-device',
  );
  return typeof binding?.config['serial'] === 'string' ? binding.config['serial'] : undefined;
}

/**
 * Internal dispatch for the `paboot_capability` MCP server. The agent only
 * sends its run id (and optionally an endId); workspace/end/serial are resolved
 * from server state.
 */
export function registerCapabilityDeviceRoutes(app: Express, ctx: AppContext): void {
  app.post('/api/internal/capability/device/:action', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const runId = typeof body['runId'] === 'string' ? body['runId'] : '';
    if (!runId) {
      res.status(400).json({ error: 'runId is required', code: 'bad_request' });
      return;
    }
    const run = ctx.db.getRun(runId);
    const session = run ? ctx.db.getSession(run.session_id) : undefined;
    if (!run || !session) {
      res.status(404).json({ error: 'run not found', code: 'run_not_found' });
      return;
    }
    const scope = resolveSessionEndsScope(ctx.db, session);
    if (!scope.workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (scope.workspace.family !== 'dev') {
      res.status(403).json({ error: 'capability is dev-only', code: 'capability_not_allowed' });
      return;
    }
    const provider = providerFor(ctx);
    const action = req.params['action'] ?? '';

    // Device enumeration is global to adb and needs no end.
    if (action === 'list') {
      try {
        res.json({ devices: await provider.list() });
        return;
      } catch (err) {
        if (err instanceof CapabilityError) {
          sendCapabilityError(res, err);
          return;
        }
        throw err;
      }
    }

    if (body['endId'] !== undefined && typeof body['endId'] !== 'string') {
      res.status(400).json({ error: 'endId must be a string', code: 'bad_request' });
      return;
    }
    const target = resolveCapabilityTargetEnd(ctx.db, session, 'android-device', body['endId']);
    if (!target.end) {
      const code = target.code ?? 'end_missing';
      const status = code === 'end_not_allowed' ? 403 : 409;
      const message =
        code === 'end_ambiguous'
          ? 'multiple ends provide this capability; pass endId'
          : code === 'end_not_allowed'
            ? 'end does not provide this capability in this session'
            : 'no end provides this capability';
      res.status(status).json({ error: message, code });
      return;
    }
    const end = target.end;
    const explicitSerial =
      typeof body['serial'] === 'string' ? body['serial'] : serialFromBinding(ctx, session, end.id);
    try {
      const serial = await provider.resolveSerial(explicitSerial);
      const outcome = await performDeviceAction(provider, action, body, serial);
      if (outcome.audit) {
        ctx.db.audit(
          'capability_device',
          JSON.stringify({
            action,
            runId,
            workspaceId: scope.workspace.id,
            endId: end.id,
            ...outcome.audit,
          }),
        );
      }
      res.json(outcome.json);
    } catch (err) {
      if (err instanceof CapabilityError) {
        sendCapabilityError(res, err);
        return;
      }
      throw err;
    }
  });
}
