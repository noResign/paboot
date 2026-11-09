import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { performDeviceAction } from '../capabilities/device-actions.js';
import { DeviceStreamHub } from '../capabilities/device-stream.js';
import { CapabilityError, type DeviceProvider } from '../capabilities/types.js';
import type { EndRow, WorkspaceRow } from '../db/db.js';
import { authRole } from '../http/auth.js';
import { sseHeaders } from '../http/sse.js';
import type { CapabilityDeviceListDto } from '../types/api.js';
import { providerFor, sendCapabilityError } from './capability-device.js';

function requireOperator(res: Response): boolean {
  if (authRole(res) === 'operator') return true;
  res.status(403).json({ error: 'operator token required', code: 'operator_required' });
  return false;
}

function resolveEnd(
  ctx: AppContext,
  workspace: WorkspaceRow,
  requested: unknown,
): EndRow | undefined {
  if (typeof requested === 'string' && requested !== '') {
    const end = ctx.db.getEnd(requested);
    return end && end.workspace_id === workspace.id ? end : undefined;
  }
  return ctx.db.listEnds(workspace.id).find((end) => end.status === 'active');
}

function bindingSerial(ctx: AppContext, endId: string): string | undefined {
  const rows = ctx.db.listCapabilityBindings('end', endId);
  const binding = rows.find((row) => row.provider_id === 'android-device');
  if (!binding) return undefined;
  try {
    const config = JSON.parse(binding.config_json) as { serial?: unknown };
    return typeof config.serial === 'string' ? config.serial : undefined;
  } catch {
    return undefined;
  }
}

async function serialFor(
  ctx: AppContext,
  provider: DeviceProvider,
  end: EndRow,
  requested: unknown,
): Promise<string> {
  const explicit = typeof requested === 'string' ? requested : bindingSerial(ctx, end.id);
  return provider.resolveSerial(explicit);
}

/**
 * Operator-facing device routes used by the desktop device tab and the
 * `paboot-capability` CLI. These are intentionally stricter than the internal
 * MCP route: agent tokens are rejected even for GET (screenshots are sensitive).
 */
export function registerDeviceRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/workspaces/:id/device', async (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.family !== 'dev') {
      res.status(403).json({ error: 'capability is dev-only', code: 'capability_not_allowed' });
      return;
    }
    const end = resolveEnd(ctx, workspace, req.query['endId']);
    if (!end) {
      res.status(409).json({ error: 'workspace has no active end', code: 'end_missing' });
      return;
    }
    const provider = providerFor(ctx);
    try {
      const devices = await provider.list();
      const selected =
        bindingSerial(ctx, end.id) ??
        (devices.filter((device) => device.state === 'device').length === 1
          ? devices.find((device) => device.state === 'device')?.serial ?? null
          : null);
      const dto: CapabilityDeviceListDto = {
        endId: end.id,
        serial: selected,
        devices: devices.map((device) => ({
          serial: device.serial,
          state: device.state,
          ...(device.model ? { model: device.model } : {}),
          ...(device.product ? { product: device.product } : {}),
          ...(device.device ? { device: device.device } : {}),
        })),
      };
      res.json(dto);
    } catch (err) {
      if (err instanceof CapabilityError) {
        sendCapabilityError(res, err);
        return;
      }
      throw err;
    }
  });

  app.post('/api/workspaces/:id/device/select', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const end = resolveEnd(ctx, workspace, req.body?.['endId']);
    if (!end) {
      res.status(409).json({ error: 'workspace has no active end', code: 'end_missing' });
      return;
    }
    const serial = typeof req.body?.['serial'] === 'string' ? req.body['serial'] : '';
    if (!serial) {
      res.status(400).json({ error: 'serial is required', code: 'bad_request' });
      return;
    }
    ctx.db.upsertCapabilityBinding({
      scopeType: 'end',
      scopeId: end.id,
      providerId: 'android-device',
      enabled: true,
      config: { serial },
    });
    res.json({ ok: true, endId: end.id, serial });
  });

  app.get('/api/workspaces/:id/device/screenshot', async (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const end = resolveEnd(ctx, workspace, req.query['endId']);
    if (!end) {
      res.status(409).json({ error: 'workspace has no active end', code: 'end_missing' });
      return;
    }
    const provider = providerFor(ctx);
    try {
      const serial = await serialFor(ctx, provider, end, req.query['serial']);
      const shot = await provider.screenshot(serial);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(shot.png);
    } catch (err) {
      if (err instanceof CapabilityError) {
        sendCapabilityError(res, err);
        return;
      }
      throw err;
    }
  });

  app.get('/api/workspaces/:id/device/stream', async (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const end = resolveEnd(ctx, workspace, req.query['endId']);
    if (!end) {
      res.status(409).json({ error: 'workspace has no active end', code: 'end_missing' });
      return;
    }
    const provider = providerFor(ctx);
    let serial: string;
    try {
      serial = await serialFor(ctx, provider, end, req.query['serial']);
    } catch (err) {
      if (err instanceof CapabilityError) {
        sendCapabilityError(res, err);
        return;
      }
      throw err;
    }
    res.writeHead(200, sseHeaders());
    res.write(': connected\n\n');
    const hub = ctx.deviceStream ?? new DeviceStreamHub(provider);
    hub.subscribe(end.id, serial, res);
  });

  app.post('/api/workspaces/:id/device/action', async (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.family !== 'dev') {
      res.status(403).json({ error: 'capability is dev-only', code: 'capability_not_allowed' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const end = resolveEnd(ctx, workspace, body['endId']);
    if (!end) {
      res.status(409).json({ error: 'workspace has no active end', code: 'end_missing' });
      return;
    }
    const action = typeof body['action'] === 'string' ? body['action'] : '';
    if (!action) {
      res.status(400).json({ error: 'action is required', code: 'bad_request' });
      return;
    }
    const provider = providerFor(ctx);
    try {
      const serial = await serialFor(ctx, provider, end, body['serial']);
      const outcome = await performDeviceAction(provider, action, body, serial);
      if (outcome.audit) {
        ctx.db.audit(
          'capability_device',
          JSON.stringify({ action, source: 'operator', endId: end.id, ...outcome.audit }),
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
