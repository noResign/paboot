import type { DeviceProvider, DeviceSelector } from './types.js';
import { CapabilityError } from './types.js';

export interface DeviceActionOutcome {
  json: unknown;
  png?: Buffer;
  audit?: Record<string, unknown>;
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
 * Shared dispatch for the internal (MCP) and operator (desktop / CLI) device
 * routes. Serial selection and auth stay at the route boundary.
 */
export async function performDeviceAction(
  provider: DeviceProvider,
  action: string,
  body: Record<string, unknown>,
  serial: string,
): Promise<DeviceActionOutcome> {
  switch (action) {
    case 'screenshot': {
      const shot = await provider.screenshot(serial);
      return {
        json: {
          serial,
          mimeType: 'image/png',
          width: shot.width,
          height: shot.height,
          png: shot.png.toString('base64'),
        },
        png: shot.png,
      };
    }
    case 'ui-dump': {
      const dump = await provider.uiDump(serial);
      return { json: { serial, nodes: dump.nodes } };
    }
    case 'tap': {
      const x = numberField(body['x']);
      const y = numberField(body['y']);
      if (x === null || y === null) {
        throw new CapabilityError('bad_request', 'x and y are required');
      }
      await provider.tap(serial, x, y);
      return { json: { ok: true, serial, x, y }, audit: { serial, x, y } };
    }
    case 'tap-selector': {
      const selector = selectorFrom(body);
      if (Object.keys(selector).length === 0) {
        throw new CapabilityError('bad_request', 'selector is required');
      }
      const point = await provider.tapSelector(serial, selector);
      return { json: { ok: true, serial, ...point }, audit: { serial, selector, ...point } };
    }
    case 'input-text': {
      const text = typeof body['text'] === 'string' ? body['text'] : '';
      if (!text) throw new CapabilityError('bad_request', 'text is required');
      await provider.inputText(serial, text);
      return { json: { ok: true, serial }, audit: { serial, chars: text.length } };
    }
    case 'key-event': {
      const key = typeof body['key'] === 'string' ? body['key'] : '';
      if (!key) throw new CapabilityError('bad_request', 'key is required');
      await provider.keyEvent(serial, key);
      return { json: { ok: true, serial }, audit: { serial, key } };
    }
    case 'launch-app': {
      const pkg = typeof body['package'] === 'string' ? body['package'] : '';
      if (!pkg) throw new CapabilityError('bad_request', 'package is required');
      await provider.launchApp(serial, pkg);
      return { json: { ok: true, serial }, audit: { serial, package: pkg } };
    }
    case 'logcat': {
      const lines = numberField(body['lines']) ?? 200;
      return { json: { serial, text: await provider.logcat(serial, lines) } };
    }
    case 'current-activity': {
      return { json: { serial, activity: await provider.currentActivity(serial) } };
    }
    default:
      throw new CapabilityError('unknown_action', `unknown device action: ${action}`);
  }
}
