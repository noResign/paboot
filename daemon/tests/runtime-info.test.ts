import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/app/config';
import {
  HEARTBEAT_INTERVAL_MS,
  RUNTIME_INFO_FILENAME,
  STALE_AFTER_MS,
  clearRuntimeInfo,
  connectableAddress,
  runtimeInfoPath,
  startHeartbeat,
  touchRuntimeInfo,
  writeRuntimeInfo,
} from '../src/app/runtime-info';

const dirs: string[] = [];
/** Well before any heartbeat, so a touched mtime is unmistakable. */
const OLD = new Date('2020-01-01T00:00:00Z');

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-runtime-info-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return { host: '0.0.0.0', port: 4780, dataDir: tempDir(), tls: null, tokenSource: 'env', ...overrides } as unknown as Config;
}

function readFile(dataDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(runtimeInfoPath(dataDir), 'utf8')) as Record<string, unknown>;
}

function mtimeMs(file: string): number {
  return fs.statSync(file).mtimeMs;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('connectableAddress', () => {
  it('collapses a wildcard bind to loopback', () => {
    expect(connectableAddress('0.0.0.0', 4780)).toBe('127.0.0.1:4780');
    expect(connectableAddress('::', 4780)).toBe('[::1]:4780');
  });

  it('keeps an explicit bind as-is', () => {
    expect(connectableAddress('127.0.0.1', 4780)).toBe('127.0.0.1:4780');
    expect(connectableAddress('192.168.1.5', 4780)).toBe('192.168.1.5:4780');
  });

  it('brackets a literal IPv6 address', () => {
    expect(connectableAddress('::1', 4780)).toBe('[::1]:4780');
  });
});

describe('daemon runtime info file', () => {
  it('records where the daemon is, and holds no secret', () => {
    const config = fakeConfig();
    const info = writeRuntimeInfo(config, 'server-1');

    expect(info).not.toBeNull();
    const written = readFile(config.dataDir);
    expect(written).toEqual({
      pid: process.pid,
      startedAt: info?.startedAt,
      serverId: 'server-1',
      hostname: os.hostname(),
      // `listen` is dial-able; `host` is what it was bound to — the difference is
      // what tells a client whether the LAN can reach it.
      listen: '127.0.0.1:4780',
      host: '0.0.0.0',
      tls: false,
      version: expect.any(String),
      dataDir: config.dataDir,
      tokenSource: 'env',
    });
    // 秘密只在 <data-dir>/token（0600）里，这一份是可读的协调信息。
    expect(Object.keys(written)).not.toContain('token');
  });

  it('mirrors tls, so clients stop guessing the scheme', () => {
    const config = fakeConfig({ tls: { cert: 'c', key: 'k' } });
    writeRuntimeInfo(config, 'server-1');
    expect(readFile(config.dataDir).tls).toBe(true);
  });

  it('degrades to null instead of failing when the data dir is unusable', () => {
    const config = fakeConfig({ dataDir: path.join(tempDir(), 'missing', 'nested') });
    expect(writeRuntimeInfo(config, 'server-1')).toBeNull();
  });

  it('refreshes the mtime on heartbeat, without rewriting the file', () => {
    const config = fakeConfig();
    const file = runtimeInfoPath(config.dataDir);
    const info = writeRuntimeInfo(config, 'server-1');
    fs.utimesSync(file, OLD, OLD);

    touchRuntimeInfo(config.dataDir);

    expect(mtimeMs(file)).toBeGreaterThan(OLD.getTime());
    // mtime 前进而内容不变 —— 文件写一次，之后就只是被 touch。这也是为什么
    // 没有 heartbeat 字段：mtime 本身就是心跳。
    expect(readFile(config.dataDir).startedAt).toBe(info?.startedAt);
  });

  it('keeps touching until stopped, then leaves the file alone', async () => {
    const config = fakeConfig();
    const file = runtimeInfoPath(config.dataDir);
    writeRuntimeInfo(config, 'server-1');
    fs.utimesSync(file, OLD, OLD);

    const stop = startHeartbeat(config.dataDir, 10);
    await sleep(60);
    expect(mtimeMs(file)).toBeGreaterThan(OLD.getTime());

    stop();
    fs.utimesSync(file, OLD, OLD);
    await sleep(60);
    // 还在跑的话 mtime 会是「现在」，远大于 OLD + 1s。
    expect(mtimeMs(file)).toBeLessThan(OLD.getTime() + 1000);
  });

  it('removes the file, and tolerates it already being gone', () => {
    const config = fakeConfig();
    writeRuntimeInfo(config, 'server-1');
    expect(fs.existsSync(runtimeInfoPath(config.dataDir))).toBe(true);

    clearRuntimeInfo(config.dataDir);
    expect(fs.existsSync(runtimeInfoPath(config.dataDir))).toBe(false);
    expect(() => clearRuntimeInfo(config.dataDir)).not.toThrow();
  });

  it('tolerates a heartbeat against a missing file', () => {
    expect(() => touchRuntimeInfo(tempDir())).not.toThrow();
  });

  // 读者按「mtime 比现在老 STALE_AFTER_MS 以上即过期」判断崩溃 / 硬杀。
  // 钉住具体数值，让改动这个契约成为一次有意识的动作。
  it('pins the staleness contract readers rely on', () => {
    expect(RUNTIME_INFO_FILENAME).toBe('daemon_runtime.json');
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(STALE_AFTER_MS).toBe(90_000);
  });
});
