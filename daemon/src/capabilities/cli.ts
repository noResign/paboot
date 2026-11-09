import fs from 'node:fs/promises';

export interface CapabilityCliArgs {
  command: 'android';
  action: string;
  workspace: string;
  endId?: string;
  serial?: string;
  out?: string;
  params: Record<string, unknown>;
}

const ACTIONS = new Set([
  'list',
  'screenshot',
  'ui-dump',
  'tap',
  'tap-selector',
  'input-text',
  'key-event',
  'launch-app',
  'logcat',
  'current-activity',
]);

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return [value, index + 1];
}

export function parseCapabilityArgs(argv: readonly string[]): CapabilityCliArgs {
  const [command, action, ...rest] = argv;
  if (command !== 'android') {
    throw new Error('usage: paboot-capability android <action> --workspace <id>');
  }
  if (!action || !ACTIONS.has(action)) {
    throw new Error(`unknown android action: ${action ?? ''}`);
  }
  let workspace = '';
  let endId: string | undefined;
  let serial: string | undefined;
  let out: string | undefined;
  const params: Record<string, unknown> = {};
  const selector: Record<string, string> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    switch (flag) {
      case '--workspace':
      case '--end':
      case '--serial':
      case '--out': {
        const [value, next] = takeValue(rest, index, flag);
        index = next;
        if (flag === '--workspace') workspace = value;
        if (flag === '--end') endId = value;
        if (flag === '--serial') serial = value;
        if (flag === '--out') out = value;
        break;
      }
      case '--x':
      case '--y':
      case '--lines': {
        const [value, next] = takeValue(rest, index, flag);
        index = next;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
        params[flag.slice(2)] = parsed;
        break;
      }
      case '--text':
      case '--key':
      case '--package': {
        const [value, next] = takeValue(rest, index, flag);
        index = next;
        params[flag.slice(2)] = value;
        break;
      }
      case '--selector-text':
      case '--selector-id':
      case '--selector-desc':
      case '--selector-class': {
        const [value, next] = takeValue(rest, index, flag);
        index = next;
        const key = {
          '--selector-text': 'text',
          '--selector-id': 'resourceId',
          '--selector-desc': 'contentDesc',
          '--selector-class': 'className',
        }[flag]!;
        selector[key] = value;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (Object.keys(selector).length > 0) params['selector'] = selector;
  if (!workspace) throw new Error('--workspace is required');
  return {
    command: 'android',
    action,
    workspace,
    ...(endId === undefined ? {} : { endId }),
    ...(serial === undefined ? {} : { serial }),
    ...(out === undefined ? {} : { out }),
    params,
  };
}

function daemonBase(env: NodeJS.ProcessEnv): string {
  const base = env.PABOOT_DAEMON_URL;
  if (!base) throw new Error('PABOOT_DAEMON_URL is not set');
  return base.replace(/\/+$/, '');
}

async function request(
  env: NodeJS.ProcessEnv,
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const token = env.PABOOT_TOKEN;
  if (!token) throw new Error('PABOOT_TOKEN is not set');
  const response = await fetch(`${daemonBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function runCapabilityCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  try {
    const args = parseCapabilityArgs(argv);
    const workspace = encodeURIComponent(args.workspace);
    if (args.action === 'list') {
      const query = args.endId ? `?endId=${encodeURIComponent(args.endId)}` : '';
      const result = await request(env, `/api/workspaces/${workspace}/device${query}`, {
        method: 'GET',
      });
      if (!result.ok) throw new Error(`daemon returned HTTP ${result.status}: ${result.text}`);
      stdout.write(`${JSON.stringify(parseJson(result.text), null, 2)}\n`);
      return 0;
    }

    const result = await request(env, `/api/workspaces/${workspace}/device/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: args.action,
        ...(args.endId ? { endId: args.endId } : {}),
        ...(args.serial ? { serial: args.serial } : {}),
        ...args.params,
      }),
    });
    if (!result.ok) throw new Error(`daemon returned HTTP ${result.status}: ${result.text}`);
    const parsed = parseJson(result.text) as { png?: unknown } | null;
    if (args.action === 'screenshot' && parsed && typeof parsed.png === 'string') {
      const bytes = Buffer.from(parsed.png, 'base64');
      if (args.out) {
        await fs.writeFile(args.out, bytes);
      } else {
        stdout.write(bytes);
      }
      return 0;
    }
    stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
