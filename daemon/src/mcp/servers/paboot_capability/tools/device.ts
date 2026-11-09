import { requireToolPermission } from '../../../gate.js';
import type { McpTool, ToolContext } from '../../../types.js';

const SERIAL = { type: 'string', description: 'Target device serial; defaults to the only online device.' };

async function callDevice(
  ctx: ToolContext,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return ctx.callDaemon('POST', `/api/internal/capability/device/${action}`, {
    runId: ctx.runId,
    ...args,
  });
}

function deviceTool(options: {
  name: string;
  action: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  gate?: boolean;
}): McpTool {
  const gate = options.gate ?? true;
  return {
    definition: {
      name: options.name,
      description: options.description,
      inputSchema: {
        type: 'object',
        properties: options.properties,
        ...(options.required ? { required: options.required } : {}),
      },
    },
    async run(args, ctx) {
      if (gate) {
        await requireToolPermission(ctx, `mcp__paboot_capability__${options.name}`, args);
      }
      return callDevice(ctx, options.action, args);
    },
  };
}

export const androidDeviceListTool = deviceTool({
  name: 'android_device_list',
  action: 'list',
  description: 'List Android devices visible to adb on the daemon host.',
  properties: {},
  gate: false,
});

export const androidScreenshotTool: McpTool = {
  definition: {
    name: 'android_screenshot',
    description: 'Capture a PNG screenshot from the Android device.',
    inputSchema: { type: 'object', properties: { serial: SERIAL } },
  },
  async run(args, ctx) {
    await requireToolPermission(ctx, 'mcp__paboot_capability__android_screenshot', args);
    const result = (await callDevice(ctx, 'screenshot', args)) as {
      png: string;
      mimeType?: string;
      width: number;
      height: number;
      serial: string;
    };
    return {
      content: [
        { type: 'image', data: result.png, mimeType: result.mimeType ?? 'image/png' },
        {
          type: 'text',
          text: `screenshot ${result.width}x${result.height} (${result.serial})`,
        },
      ],
    };
  },
};

export const androidUiDumpTool = deviceTool({
  name: 'android_ui_dump',
  action: 'ui-dump',
  description: 'Dump the visible UI hierarchy (text, resource-id, class, clickable, bounds).',
  properties: { serial: SERIAL },
});

export const androidTapTool = deviceTool({
  name: 'android_tap',
  action: 'tap',
  description: 'Tap absolute screen coordinates.',
  properties: {
    serial: SERIAL,
    x: { type: 'number', description: 'Screen x in pixels.' },
    y: { type: 'number', description: 'Screen y in pixels.' },
  },
  required: ['x', 'y'],
});

export const androidTapSelectorTool = deviceTool({
  name: 'android_tap_selector',
  action: 'tap-selector',
  description: 'Tap the center of the first node matching text / resource-id / content-desc / class.',
  properties: {
    serial: SERIAL,
    selector: {
      type: 'object',
      description: 'Fields are matched exactly; clickable matches are preferred.',
      properties: {
        text: { type: 'string' },
        resourceId: { type: 'string' },
        contentDesc: { type: 'string' },
        className: { type: 'string' },
      },
    },
  },
  required: ['selector'],
});

export const androidInputTextTool = deviceTool({
  name: 'android_input_text',
  action: 'input-text',
  description: 'Type printable ASCII into the focused field (spaces become %s).',
  properties: {
    serial: SERIAL,
    text: { type: 'string', description: 'Printable ASCII text.' },
  },
  required: ['text'],
});

export const androidKeyEventTool = deviceTool({
  name: 'android_key_event',
  action: 'key-event',
  description: 'Send a key event, e.g. HOME, BACK, ENTER, DEL or KEYCODE_*.',
  properties: {
    serial: SERIAL,
    key: { type: 'string', description: 'Key name or numeric key code.' },
  },
  required: ['key'],
});

export const androidLaunchAppTool = deviceTool({
  name: 'android_launch_app',
  action: 'launch-app',
  description: 'Launch an app by package name through its launcher intent.',
  properties: {
    serial: SERIAL,
    package: { type: 'string', description: 'Android package id.' },
  },
  required: ['package'],
});

export const androidLogcatTool = deviceTool({
  name: 'android_logcat',
  action: 'logcat',
  description: 'Read the last N lines of logcat.',
  properties: {
    serial: SERIAL,
    lines: { type: 'number', description: 'Line count (default 200, max 2000).' },
  },
  gate: false,
});

export const androidCurrentActivityTool = deviceTool({
  name: 'android_current_activity',
  action: 'current-activity',
  description: 'Report the currently focused activity.',
  properties: { serial: SERIAL },
  gate: false,
});

export const DEVICE_TOOLS: McpTool[] = [
  androidDeviceListTool,
  androidScreenshotTool,
  androidUiDumpTool,
  androidTapTool,
  androidTapSelectorTool,
  androidInputTextTool,
  androidKeyEventTool,
  androidLaunchAppTool,
  androidLogcatTool,
  androidCurrentActivityTool,
];
