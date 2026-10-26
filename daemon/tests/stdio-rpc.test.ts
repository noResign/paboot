import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnStdioRpc } from '../src/runtimes/stdio-rpc';

/**
 * A minimal peer that only answers frames carrying the JSON-RPC 2.0 version
 * field. ACP (dsh acp) silently ignores envelopes without it, which is exactly
 * the failure this test guards against.
 */
const PEER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'ping') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { framed: message.jsonrpc === '2.0', method: message.method },
      }) + '\\n');
    } else if (message.method === 'note') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'seen',
        params: { framed: message.jsonrpc === '2.0' },
      }) + '\\n');
    } else if (message.method === 'fail') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: { details: 'mcp-client(paboot_tasks): initial connection or tool synchronization failed' },
        },
      }) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

describe('stdio JSON-RPC transport', () => {
  it('frames requests and notifications as JSON-RPC 2.0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paboot-rpc-'));
    const peer = join(dir, 'peer.mjs');
    writeFileSync(peer, PEER);

    const connection = spawnStdioRpc({ command: process.execPath, args: [peer], label: 'test-peer' });
    try {
      const seen = new Promise<unknown>((resolve) => {
        connection.onNotification((method, params) => {
          if (method === 'seen') resolve(params);
        });
      });
      connection.notify('note', {});

      await expect(connection.request('ping', {}, 5_000)).resolves.toEqual({
        framed: true,
        method: 'ping',
      });
      await expect(seen).resolves.toEqual({ framed: true });
      // ACP's actionable cause lives in error.data.details; hiding it leaves
      // the operator with a useless "Internal error".
      await expect(connection.request('fail', {}, 5_000)).rejects.toThrow(
        'Internal error: mcp-client(paboot_tasks): initial connection or tool synchronization failed',
      );
    } finally {
      await connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
