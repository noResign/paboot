import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AdbExecutor, DeviceInfo } from '../../types.js';
import { CapabilityError } from '../../types.js';

type ExecFn = (
  file: string,
  args: readonly string[],
  options: {
    encoding: 'utf8' | 'buffer';
    maxBuffer: number;
    windowsHide: boolean;
    timeout: number;
  },
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

const execFileAsync = promisify(execFile) as unknown as ExecFn;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// Serial names can contain spaces (e.g. a USB camera registered with adb), so
// split on a known state token instead of the first whitespace run.
const DEVICE_STATES =
  'device|offline|unauthorized|recovery|sideload|bootloader|unknown|no permissions';

export function parseAdbDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  const linePattern = new RegExp(`^(.*?)\\s+(${DEVICE_STATES})(?:\\s+|$)(.*)$`);
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices')) continue;
    if (trimmed.startsWith('*')) continue;
    const match = trimmed.match(linePattern);
    if (!match) continue;
    const [, serial, state, tail] = match;
    if (!serial || !state) continue;
    const fields = new Map<string, string>();
    for (const part of (tail ?? '').split(/\s+/)) {
      const index = part.indexOf(':');
      if (index > 0) fields.set(part.slice(0, index), part.slice(index + 1));
    }
    devices.push({
      serial,
      state,
      ...(fields.has('model') ? { model: fields.get('model') } : {}),
      ...(fields.has('product') ? { product: fields.get('product') } : {}),
      ...(fields.has('device') ? { device: fields.get('device') } : {}),
      ...(fields.has('transport_id') ? { transport: fields.get('transport_id') } : {}),
    });
  }
  return devices;
}

/** PNG IHDR width/height live at bytes 16..23 (big endian). */
export function parsePngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new CapabilityError('screenshot_invalid', 'screencap did not return a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function adbCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];
  if (env['PABOOT_ADB_PATH']) candidates.push(env['PABOOT_ADB_PATH']);
  for (const root of [env['ANDROID_HOME'], env['ANDROID_SDK_ROOT']]) {
    if (root) candidates.push(path.join(root, 'platform-tools', exe));
  }
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'Android', 'Sdk', 'platform-tools', exe));
  } else if (platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe));
  } else {
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe));
    candidates.push(path.join('/usr/lib/android-sdk/platform-tools', exe));
  }
  candidates.push(exe);
  return [...new Set(candidates)];
}

function resolveAdb(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  for (const candidate of adbCandidates(env, platform)) {
    if (candidate === 'adb' || candidate === 'adb.exe') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'adb';
}

export class AdbRunner implements AdbExecutor {
  private binary: string | null = null;

  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      exec?: ExecFn;
      timeoutMs?: number;
    } = {},
  ) {}

  private executable(): string {
    this.binary ??= resolveAdb(this.options.env, this.options.platform);
    return this.binary;
  }

  async exec(
    args: string[],
    options: { binary?: boolean; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const run = this.options.exec ?? execFileAsync;
    try {
      const result = await run(this.executable(), args, {
        encoding: options.binary ? 'buffer' : 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        timeout: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new CapabilityError('adb_missing', 'adb binary was not found');
      }
      const stderr = (err as { stderr?: unknown }).stderr;
      const detail =
        typeof stderr === 'string'
          ? stderr.trim()
          : Buffer.isBuffer(stderr)
            ? stderr.toString('utf8').trim()
            : '';
      throw new CapabilityError(
        code === 'ETIMEDOUT' ? 'adb_timeout' : 'adb_failed',
        detail || 'adb command failed',
      );
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const output = await this.exec(['devices', '-l']);
    return parseAdbDevices(output.toString('utf8'));
  }

  /** Explicit serial wins; otherwise the single online device is used. */
  async resolveSerial(explicit?: string): Promise<string> {
    const devices = await this.listDevices();
    const online = devices.filter((device) => device.state === 'device');
    if (explicit) {
      if (online.some((device) => device.serial === explicit)) return explicit;
      throw new CapabilityError('device_offline', `device ${explicit} is not online`);
    }
    if (online.length === 1) return online[0]!.serial;
    if (online.length === 0) throw new CapabilityError('device_offline', 'no online device');
    throw new CapabilityError('device_ambiguous', 'multiple devices are online; pass a serial');
  }
}
