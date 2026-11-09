import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { AdbRunner } from '../capabilities/providers/android/adb.js';
import { AndroidDeviceProvider } from '../capabilities/providers/android/index.js';
import { resolveCapabilityBindings, resolveCapabilityScope } from '../capabilities/scope.js';
import {
  CapabilityError,
  type DeviceProvider,
  type DeviceSelector,
} from '../capabilities/types.js';

function providerFor(ctx: AppContext): DeviceProvider {
  return ctx.deviceProvider ?? new AndroidDeviceProvider(new AdbRunner());
}

function sendCapabilityError(res: Response, err: CapabilityError): void {
  const status =
    err.code === 'adb_missing'
      ? 503
      : err.code === 'device_offline' || err.code === 'device_ambiguous'
        ? 409
        : err.code === 'selector_not_found'
          ? 404
          : err.code === 'screenshot_invalid'
            ? 502
            : 400;
  res.status(status).json({ error: err.message, code: err.code });
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function selectorFrom(body: Record<string, unknown>): DeviceSelector {
  const raw =
    body['selector'] && typeof body['selector'] === 'object'
      ? (body['selector'] as Record<string, unknown>)
      : body;
  const selector: DeviceSelector = {};
  for (const key of ['text', 'resourceId', 'contentDesc', 'className'] as const) {
    if (typeof raw[key] === 'string' && raw[key] !== '') selector[key] = raw[key] as string;
  }
  return selector;
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
    const binding = resolveCapabilityBindings(ctx.db, session).find(
      (item) => item.descriptor.id === 'android-device',
    );
    const configSerial =
      typeof binding?.config['serial'] === 'string' ? binding.config['serial'] : undefined;
    const explicitSerial = typeof body['serial'] === 'string' ? body['serial'] : configSerial;

    try {
      if (action === 'list') {
        res.json({ devices: await provider.list() });
        return;
      }
      const serial = await provider.resolveSerial(explicitSerial);
      switch (action) {
        case 'screenshot': {
          const shot = await provider.screenshot(serial);
          res.json({
            serial,
            mimeType: 'image/png',
            width: shot.width,
            height: shot.height,
            png: shot.png.toString('base64'),
          });
          return;
        }
        case 'ui-dump': {
          const dump = await provider.uiDump(serial);
          res.json({ serial, nodes: dump.nodes });
          return;
        }
        case 'tap': {
          const x = numberField(body['x']);
          const y = numberField(body['y']);
          if (x === null || y === null) {
            res.status(400).json({ error: 'x and y are required', code: 'bad_request' });
            return;
          }
          await provider.tap(serial, x, y);
          ctx.db.audit('capability_device', JSON.stringify({ action, runId, serial, x, y }));
          res.json({ ok: true, serial, x, y });
          return;
        }
        case 'tap-selector': {
          const selector = selectorFrom(body);
          if (Object.keys(selector).length === 0) {
            res.status(400).json({ error: 'selector is required', code: 'bad_request' });
            return;
          }
          const point = await provider.tapSelector(serial, selector);
          ctx.db.audit(
            'capability_device',
            JSON.stringify({ action, runId, serial, selector, ...point }),
          );
          res.json({ ok: true, serial, ...point });
          return;
        }
        case 'input-text': {
          const text = typeof body['text'] === 'string' ? body['text'] : '';
          if (!text) {
            res.status(400).json({ error: 'text is required', code: 'bad_request' });
            return;
          }
          await provider.inputText(serial, text);
          ctx.db.audit(
            'capability_device',
            JSON.stringify({ action, runId, serial, chars: text.length }),
          );
          res.json({ ok: true, serial });
          return;
        }
        case 'key-event': {
          const key = typeof body['key'] === 'string' ? body['key'] : '';
          if (!key) {
            res.status(400).json({ error: 'key is required', code: 'bad_request' });
            return;
          }
          await provider.keyEvent(serial, key);
          ctx.db.audit('capability_device', JSON.stringify({ action, runId, serial, key }));
          res.json({ ok: true, serial });
          return;
        }
        case 'launch-app': {
          const pkg = typeof body['package'] === 'string' ? body['package'] : '';
          if (!pkg) {
            res.status(400).json({ error: 'package is required', code: 'bad_request' });
            return;
          }
          await provider.launchApp(serial, pkg);
          ctx.db.audit('capability_device', JSON.stringify({ action, runId, serial, pkg }));
          res.json({ ok: true, serial });
          return;
        }
        case 'logcat': {
          const lines = numberField(body['lines']) ?? 200;
          res.json({ serial, text: await provider.logcat(serial, lines) });
          return;
        }
        case 'current-activity': {
          res.json({ serial, activity: await provider.currentActivity(serial) });
          return;
        }
        default:
          res.status(404).json({ error: `unknown device action: ${action}`, code: 'not_found' });
      }
    } catch (err) {
      if (err instanceof CapabilityError) {
        sendCapabilityError(res, err);
        return;
      }
      throw err;
    }
  });
}
