import { CAPABILITY_TOOL_SERVER, TASK_TOOL_SERVER } from '../mcp/injection.js';

export type CapabilityFamily = 'dev' | 'life';
export type CapabilityScopeType = 'workspace' | 'end' | 'session';

/**
 * One capability family (not one server). `paboot_tasks` and
 * `paboot_capability` stay separate MCP servers (D26); this table is what the
 * daemon uses to resolve scope and decide which servers a run should mount.
 */
export interface CapabilityDescriptor {
  id: string;
  name: string;
  families: readonly CapabilityFamily[];
  scope: CapabilityScopeType;
  server: string;
  approval: 'hook-exact' | 'server-gate';
  tools: readonly string[];
  surfaces: readonly ('desktop' | 'mobile')[];
}

const ANDROID_DEVICE_TOOLS = [
  'android_device_list',
  'android_screenshot',
  'android_ui_dump',
  'android_tap',
  'android_tap_selector',
  'android_input_text',
  'android_key_event',
  'android_launch_app',
  'android_logcat',
  'android_current_activity',
] as const;

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    id: 'tasks',
    name: '定时任务',
    families: ['dev', 'life'],
    scope: 'workspace',
    server: TASK_TOOL_SERVER,
    approval: 'hook-exact',
    tools: ['schedule_task', 'list_scheduled_tasks', 'list_sessions', 'cancel_scheduled_task'],
    surfaces: ['desktop', 'mobile'],
  },
  {
    id: 'android-device',
    name: 'Android 设备',
    families: ['dev'],
    scope: 'end',
    server: CAPABILITY_TOOL_SERVER,
    approval: 'server-gate',
    tools: ANDROID_DEVICE_TOOLS,
    surfaces: ['desktop', 'mobile'],
  },
  {
    id: 'mock',
    name: 'Mock API',
    families: ['dev'],
    scope: 'workspace',
    server: CAPABILITY_TOOL_SERVER,
    approval: 'server-gate',
    tools: [],
    surfaces: ['desktop'],
  },
];

export function capabilityById(id: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}
