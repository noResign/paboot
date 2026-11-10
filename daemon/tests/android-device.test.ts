import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import {
  adbCandidates,
  AdbRunner,
  parseAdbDevices,
  parsePngSize,
} from '../src/capabilities/providers/android/adb';
import { AndroidDeviceProvider } from '../src/capabilities/providers/android/index';
import { findNode, nodeCenter, parseUiDump } from '../src/capabilities/providers/android/ui-dump';
import {
  CapabilityError,
  type AdbExecutor,
  type DeviceProvider,
} from '../src/capabilities/types';
import { Db } from '../src/db/db';
import { registerCapabilityDeviceRoutes } from '../src/routes/capability-device';

const dbs: Db[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-android-${name}-`));
  dirs.push(dir);
  return dir;
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

class FakeAdb implements AdbExecutor {
  readonly calls: string[][] = [];
  constructor(private readonly handler: (args: string[]) => Buffer | string) {}
  async exec(args: string[]): Promise<Buffer> {
    this.calls.push(args);
    const output = this.handler(args);
    return Buffer.isBuffer(output) ? output : Buffer.from(output);
  }
}

const XML = `<?xml version="1.0"?><hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">
    <node text="登录" resource-id="com.example:id/login" content-desc="" class="android.widget.Button" clickable="true" bounds="[100,200][500,300]" />
    <node text="说明" resource-id="com.example:id/hint" class="android.widget.TextView" clickable="false" bounds="[100,350][900,420]" />
  </node>
</hierarchy>`;

describe('android provider', () => {
  it('parses devices and resolves a single online serial', async () => {
    const adb = new FakeAdb(() =>
      'List of devices attached\nemulator-5554 device product:sdk model:Pixel transport_id:1\n',
    );
    const provider = new AndroidDeviceProvider(adb);
    expect(parseAdbDevices((await adb.exec(['devices', '-l'])).toString('utf8'))).toEqual([
      expect.objectContaining({ serial: 'emulator-5554', state: 'device', model: 'Pixel' }),
    ]);
    expect(await provider.resolveSerial()).toBe('emulator-5554');
  });

  it('keeps serials with spaces and multi-word states intact', () => {
    const parsed = parseAdbDevices(
      [
        'List of devices attached',
        'UGREEN Camera 2K       no permissions (missing udev rules?)',
        'J4K6R22906007718       device usb:1-7 product:GOT-W09 model:GOT_W09 transport_id:4',
      ].join('\n'),
    );
    expect(parsed).toEqual([
      expect.objectContaining({ serial: 'UGREEN Camera 2K', state: 'no permissions' }),
      expect.objectContaining({
        serial: 'J4K6R22906007718',
        state: 'device',
        model: 'GOT_W09',
      }),
    ]);
  });

  it('rejects ambiguous and offline devices', async () => {
    const ambiguous = new AndroidDeviceProvider(
      new FakeAdb(() => 'a device\nb device\n'),
    );
    await expect(ambiguous.resolveSerial()).rejects.toMatchObject({ code: 'device_ambiguous' });

    const offline = new AndroidDeviceProvider(new FakeAdb(() => 'a offline\n'));
    await expect(offline.resolveSerial()).rejects.toMatchObject({ code: 'device_offline' });
    expect((await offline.list()).length).toBe(1);
  });

  it('reads a screenshot and validates the PNG header', async () => {
    const provider = new AndroidDeviceProvider(
      new FakeAdb(() => png(1080, 1920)),
    );
    expect(await provider.screenshot('s')).toMatchObject({ width: 1080, height: 1920 });
    expect(parsePngSize(png(1, 2))).toEqual({ width: 1, height: 2 });

    const broken = new AndroidDeviceProvider(new FakeAdb(() => Buffer.from('nope')));
    await expect(broken.screenshot('s')).rejects.toBeInstanceOf(CapabilityError);
  });

  it('parses ui dumps and taps the clickable match', async () => {
    expect(parseUiDump(XML)).toHaveLength(3);
    const nodes = parseUiDump(XML);
    const button = findNode(nodes, { text: '登录' });
    expect(nodeCenter(button)).toEqual({ x: 300, y: 250 });

    const adb = new FakeAdb((args) =>
      args.includes('uiautomator') ? '' : args.at(-1) === '/sdcard/paboot-window.xml' ? XML : '',
    );
    const provider = new AndroidDeviceProvider(adb);
    expect(await provider.tapSelector('s', { text: '登录' })).toEqual({ x: 300, y: 250 });
    expect(adb.calls.some((args) => args.includes('tap'))).toBe(true);
  });

  it('guards input text and maps key aliases', async () => {
    const adb = new FakeAdb(() => '');
    const provider = new AndroidDeviceProvider(adb);
    await provider.inputText('s', 'hello world');
    expect(adb.calls.some((args) => args.at(-1) === 'hello%sworld')).toBe(true);
    await expect(provider.inputText('s', '你好')).rejects.toMatchObject({
      code: 'input_text_unsupported',
    });
    await provider.keyEvent('s', 'home');
    expect(adb.calls.some((args) => args.at(-1) === 'KEYCODE_HOME')).toBe(true);
  });

  it('reads the current activity from dumpsys window', async () => {
    const provider = new AndroidDeviceProvider(
      new FakeAdb(() =>
        'mCurrentFocus=Window{123 u0 com.example/com.example.MainActivity}',
      ),
    );
    expect(await provider.currentActivity('s')).toBe('com.example/com.example.MainActivity');
  });

  it('prefers PABOOT_ADB_PATH over platform defaults', () => {
    expect(adbCandidates({ PABOOT_ADB_PATH: '/custom/adb' }, 'linux')[0]).toBe('/custom/adb');
    expect(adbCandidates({}, 'win32').some((value) => value.endsWith('adb.exe'))).toBe(true);
  });

  it('reports a missing adb binary as adb_missing', async () => {
    const runner = new AdbRunner({
      exec: async () => {
        throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(runner.listDevices()).rejects.toMatchObject({ code: 'adb_missing' });
  });
});

describe('capability device route', () => {
  const fakeProvider: DeviceProvider = {
    async list() {
      return [{ serial: 's', state: 'device' }];
    },
    async resolveSerial(explicit) {
      return explicit ?? 's';
    },
    async screenshot() {
      return { png: png(1080, 1920), width: 1080, height: 1920 };
    },
    async uiDump() {
      return { xml: XML, nodes: parseUiDump(XML) };
    },
    async tap() {},
    async tapSelector() {
      return { x: 300, y: 250 };
    },
    async inputText() {},
    async keyEvent() {},
    async launchApp() {},
    async logcat() {
      return 'log line';
    },
    async currentActivity() {
      return 'pkg/.Main';
    },
  };

  async function boot(family: 'dev' | 'life', withEnd: boolean) {
    const db = new Db(':memory:');
    dbs.push(db);
    const root = tmpDir(family);
    const workspace = db.createWorkspace({ name: family, path: root, family });
    const session = db.createSession({
      id: `s-${family}`,
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: root,
    });
    if (withEnd) {
      const end = db.createEnd({
        workspaceId: workspace.id,
        family,
        kind: 'android',
        name: 'Pixel',
        status: 'active',
      });
      db.addEndRoot(end.id, root);
    }
    db.createRun({
      id: `r-${family}`,
      sessionId: session.id,
      runtime: 'claude',
      model: null,
      prompt: 'hello',
      status: 'running',
    });
    const app = express();
    app.use(express.json());
    registerCapabilityDeviceRoutes(app, {
      db,
      deviceProvider: fakeProvider,
    } as unknown as AppContext);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  async function call(url: string, action: string, body: Record<string, unknown>) {
    return fetch(`${url}/api/internal/capability/device/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns screenshot bytes and dispatches taps', async () => {
    const url = await boot('dev', true);
    const shot = await call(url, 'screenshot', { runId: 'r-dev' });
    expect(shot.status).toBe(200);
    const body = (await shot.json()) as { png: string; width: number; height: number };
    expect(body).toMatchObject({ width: 1080, height: 1920 });
    expect(Buffer.from(body.png, 'base64').length).toBeGreaterThan(0);

    const tap = await call(url, 'tap', { runId: 'r-dev', x: 10, y: 20 });
    expect(tap.status).toBe(200);
    expect(await tap.json()).toMatchObject({ ok: true, x: 10, y: 20 });
  });

  it('rejects life workspaces and workspaces without an end', async () => {
    const life = await boot('life', true);
    const lifeResponse = await call(life, 'screenshot', { runId: 'r-life' });
    expect(lifeResponse.status).toBe(403);

    const noEnd = await boot('dev', false);
    const noEndResponse = await call(noEnd, 'screenshot', { runId: 'r-dev' });
    expect(noEndResponse.status).toBe(409);
    expect(((await noEndResponse.json()) as { code: string }).code).toBe('end_missing');
  });
});
