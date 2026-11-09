import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { performDeviceAction } from '../capabilities/device-actions.js';
import { AdbRunner } from '../capabilities/providers/android/adb.js';
import { AndroidDeviceProvider } from '../capabilities/providers/android/index.js';
import { resolveCapabilityBindings, resolveCapabilityScope } from '../capabilities/scope.js';
import { CapabilityError, type DeviceProvider } from '../capabilities/types.js';

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

export function serialFromBinding(
  ctx: AppContext,
  session: Parameters<typeof resolveCapabilityBindings>[1],
): string | undefined {
  const binding = resolveCapabilityBindings(ctx.db, session).find(
    (item) => item.descriptor.id === 'android-device',
  );
  return typeof binding?.config['serial'] === 'string' ? binding.config['serial'] : undefined;
}

/**
 * Internal dispatch for the `paboot_capability` MCP server. The agent only
 * sends its run id; workspace/end/serial are resolved from server state.
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
    const scope = resolveCapabilityScope(ctx.db, session);
    if (!scope.workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (scope.workspace.family !== 'dev') {
      res.status(403).json({ error: 'capability is dev-only', code: 'capability_not_allowed' });
      return;
    }
    if (!scope.end) {
      res.status(409).json({ error: 'workspace has no active end', code: 'end_missing' });
      return;
    }

    const provider = providerFor(ctx);
    const action = req.params['action'] ?? '';
    const explicitSerial =
      typeof body['serial'] === 'string' ? body['serial'] : serialFromBinding(ctx, session);
    try {
      if (action === 'list') {
        res.json({ devices: await provider.list() });
        return;
      }
      const serial = await provider.resolveSerial(explicitSerial);
      const outcome = await performDeviceAction(provider, action, body, serial);
      if (outcome.audit) {
        ctx.db.audit(
          'capability_device',
          JSON.stringify({ action, runId, workspaceId: scope.workspace.id, ...outcome.audit }),
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
