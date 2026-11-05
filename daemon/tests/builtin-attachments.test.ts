import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { AttachmentStore } from '../src/attachments/store';
import { inspectRasterImage } from '../src/attachments/image-info';
import { Db } from '../src/db/db';
import { registerAttachmentRoutes } from '../src/routes/attachments';
import type { AppContext } from '../src/app/context';
import { buildAnthropicBody } from '../src/llm/anthropic';
import { buildOpenAIBody } from '../src/llm/openai';
import {
  createAttachmentImageResolver,
  renderTranscriptMessages,
  type NativeMessage,
} from '../src/runtimes/builtin/transcript/index';

const dbs: Db[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function tempDir(prefix = 'paboot-attachment-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function openStore(): { db: Db; dataDir: string; store: AttachmentStore } {
  const dataDir = tempDir();
  const db = new Db(':memory:');
  dbs.push(db);
  return { db, dataDir, store: new AttachmentStore(db, dataDir) };
}

/** Minimal structurally valid PNG header carrying exact dimensions. */
function pngBytes(width = 3, height = 2): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

/** Minimal JPEG with an SOF0 segment. */
function jpegBytes(width = 4, height = 5): Buffer {
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(11, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 3;
  return buffer;
}

function message(width: number, height: number, attachmentId: string): NativeMessage {
  return {
    id: 1,
    threadId: 'thread-1',
    seq: 1,
    role: 'user',
    blocks: [
      { type: 'text', text: 'look' },
      {
        type: 'image',
        attachmentId,
        mediaType: 'image/png',
        bytes: 33,
        width,
        height,
      },
    ],
    source: { kind: 'user' },
    runId: 'run-1',
    step: 1,
    provider: null,
    model: null,
    usage: null,
    formatVersion: 1,
    createdAt: 1,
  };
}

describe('attachment image inspection', () => {
  it('reads png/jpeg dimensions and rejects invalid data', () => {
    expect(inspectRasterImage(pngBytes(3, 2))).toEqual({ mediaType: 'image/png', width: 3, height: 2 });
    expect(inspectRasterImage(jpegBytes(4, 5))).toEqual({ mediaType: 'image/jpeg', width: 4, height: 5 });
    expect(inspectRasterImage(Buffer.from('not an image'))).toBeNull();
  });
});

describe('AttachmentStore', () => {
  it('persists immutable image bytes and verifies checksum on read', async () => {
    const { store, dataDir } = openStore();
    const saved = await store.saveImage(pngBytes(3, 2), 'image/png');
    expect(saved).toMatchObject({
      mediaType: 'image/png',
      bytes: 33,
      width: 3,
      height: 2,
    });
    expect(fs.existsSync(saved.storagePath)).toBe(true);
    expect(saved.storagePath.startsWith(path.join(dataDir, 'attachments'))).toBe(true);

    const read = await store.readImage(saved.id);
    expect(read.data.equals(pngBytes(3, 2))).toBe(true);
    await expect(store.providerImage(saved.id, 'image/png')).resolves.toEqual({
      mediaType: 'image/png',
      data: pngBytes(3, 2).toString('base64'),
    });

    const bound = store.bind(saved.id, { sessionId: 's-1', workspaceId: 'w-1', runId: 'r-1' });
    expect(bound).toMatchObject({ sessionId: 's-1', workspaceId: 'w-1', runId: 'r-1' });
    expect((await store.delete(saved.id))).toBe(true);
    expect(fs.existsSync(saved.storagePath)).toBe(false);
    await expect(store.readImage(saved.id)).rejects.toMatchObject({ code: 'attachment_not_found' });
  });

  it('rejects declared type mismatches, oversized and invalid images', async () => {
    const { store } = openStore();
    await expect(store.saveImage(pngBytes(), 'image/jpeg')).rejects.toMatchObject({
      code: 'attachment_type_mismatch',
    });
    await expect(store.saveImage(Buffer.from('nope'))).rejects.toMatchObject({
      code: 'attachment_invalid_image',
    });
    const tiny = new AttachmentStore(openStore().db, tempDir(), { maxBytes: 10 });
    await expect(tiny.saveImage(pngBytes())).rejects.toMatchObject({
      code: 'attachment_too_large',
    });
  });

  it('detects files edited outside the store as corrupted', async () => {
    const { store } = openStore();
    const saved = await store.saveImage(pngBytes());
    fs.writeFileSync(saved.storagePath, Buffer.from('tampered'));
    await expect(store.readImage(saved.id)).rejects.toMatchObject({
      code: 'attachment_corrupted',
    });
  });
});

describe('attachment -> transcript -> provider mapping', () => {
  it('hydrates image refs into Anthropic and OpenAI request image blocks', async () => {
    const { store } = openStore();
    const saved = await store.saveImage(pngBytes(3, 2), 'image/png');
    const rendered = await renderTranscriptMessages([message(3, 2, saved.id)], {
      supportsImages: true,
      resolveImage: createAttachmentImageResolver(store),
    });
    expect(rendered[0]?.content).toContainEqual({
      type: 'image',
      mediaType: 'image/png',
      data: pngBytes(3, 2).toString('base64'),
    });

    const request = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system: '',
      messages: rendered,
      tools: [],
      signal: new AbortController().signal,
    };
    const anthropic = buildAnthropicBody(request);
    expect(anthropic['messages']).toMatchObject([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        ],
      },
    ]);
    const openai = buildOpenAIBody(request);
    expect(openai['messages']).toMatchObject([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
        ],
      },
    ]);
  });

  it('replaces historical images with a visible placeholder for non-vision models', async () => {
    const rendered = await renderTranscriptMessages([message(3, 2, 'att-1')], {
      supportsImages: false,
      resolveImage: () => {
        throw new Error('must not read image bytes');
      },
    });
    expect(rendered[0]?.content).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'text',
        text: '[image att-1 omitted: image/png, 3x2; current model does not support images]',
      },
    ]);
  });
});

describe('attachment HTTP routes', () => {
  it('uploads raw image bytes and serves them back with auth-independent route logic', async () => {
    const { db, dataDir, store } = openStore();
    const app = express();
    registerAttachmentRoutes(app, { db, attachments: store } as unknown as AppContext);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bytes = pngBytes();

    const upload = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const dto = (await upload.json()) as { id: string; mediaType: string; width: number; height: number };
    expect(dto).toMatchObject({ mediaType: 'image/png', width: 3, height: 2 });

    const fetched = await fetch(`${base}/api/attachments/${dto.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);

    const notModified = await fetch(`${base}/api/attachments/${dto.id}`, {
      headers: { 'if-none-match': `"${(await store.readImage(dto.id)).row.sha256}"` },
    });
    expect(notModified.status).toBe(304);
    expect(dataDir).toContain('paboot-attachment-');
  });

  it('rejects unsupported content types', async () => {
    const { db, dataDir, store } = openStore();
    const app = express();
    registerAttachmentRoutes(app, { db, attachments: store } as unknown as AppContext);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(response.status).toBe(415);
    expect(dataDir).toContain('paboot-attachment-');
  });
});
