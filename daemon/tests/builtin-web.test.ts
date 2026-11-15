import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { LlmProvider } from '../src/llm/types';
import { createWebFetchTool } from '../src/runtimes/builtin/tools/webfetch';
import type { ToolCallContext } from '../src/runtimes/builtin/tools/types';
import {
  createProviderFetchBackend,
  providerFetchBaseUrl,
  resolveFetchBackend,
  WebFetchError,
} from '../src/runtimes/builtin/web/fetch';
import { createHttpFetchBackend } from '../src/runtimes/builtin/web/fetch-http';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface FakeServer {
  url: string;
  requests: Array<{ path: string; auth: string | undefined; body: unknown }>;
}

async function fakeServer(
  handler: (request: { path: string; auth: string | undefined; body: unknown }, res: http.ServerResponse) => void,
): Promise<FakeServer> {
  const state: FakeServer = { url: '', requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? (JSON.parse(body) as unknown) : null;
      const entry = { path: req.url ?? '', auth: req.headers.authorization, body: parsed };
      state.requests.push(entry);
      handler(entry, res);
    });
  });
  servers.push(server);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

const settings = {
  enabled: true,
  provider: 'auto' as const,
  timeoutMs: 2_000,
  baseUrl: null,
};

function context(signal = new AbortController().signal): ToolCallContext {
  return {
    callId: 'call-1',
    signal,
    agent: { eventSink: { emit: () => undefined } },
  } as unknown as ToolCallContext;
}

function fakeProvider(complete?: LlmProvider['complete']): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    stream: async function* () {},
    complete:
      complete ??
      (async () => ({ text: 'extracted', toolCalls: [], finishReason: 'stop', usage: null })),
  };
}

describe('fetch backend selection', () => {
  it('auto-selects the provider-hosted backend for any provider with a key', () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'key' },
    });
    expect(selection.backend?.id).toBe('provider');
    expect(selection.unavailableReason).toBeNull();
  });

  it('falls back to the local backend under auto when the provider has no key', () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: null },
    });
    expect(selection.backend?.id).toBe('http');
    // The switch widens reach to intranet/loopback, so it must stay reportable.
    expect(selection.fallbackFrom).toBe('provider');
    expect(selection.unavailableReason).toBeNull();
  });

  it('reports instead of falling back when the provider backend is explicit', () => {
    const selection = resolveFetchBackend({
      settings: { ...settings, provider: 'provider' },
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: null },
    });
    expect(selection.backend).toBeNull();
    expect(selection.fallbackFrom).toBeNull();
    expect(selection.unavailableReason).toContain('no API key');
  });

  it('honours an explicit override base', () => {
    const selection = resolveFetchBackend({
      settings: { ...settings, baseUrl: 'http://127.0.0.1:9' },
      provider: { kind: 'openai', baseUrl: 'https://example.test', apiKey: 'key' },
    });
    expect(selection.backend?.id).toBe('provider');
  });

  it('keeps the provider backend when auto has a key', () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'key' },
    });
    expect(selection.backend?.id).toBe('provider');
    expect(selection.fallbackFrom).toBeNull();
  });

  it('selects the local backend for provider "http" and marks no fallback', () => {
    const local = resolveFetchBackend({
      settings: { ...settings, provider: 'http' },
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'key' },
    });
    expect(local.backend?.id).toBe('http');
    expect(local.fallbackFrom).toBeNull();
    expect(local.unavailableReason).toBeNull();
  });

  it('stays silent when fetch is disabled', () => {
    const selection = resolveFetchBackend({
      settings: { ...settings, enabled: false },
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'key' },
    });
    expect(selection.backend).toBeNull();
    expect(selection.unavailableReason).toBeNull();
  });
});

/**
 * The web tools live under `<origin>/v1/tools`, not under the completions base.
 * Posting to `<completions base>/fetch` answers 404 — that is how the endpoint
 * bug shipped — so these cases pin the derivation down.
 */
describe('providerFetchBaseUrl', () => {
  it('moves a completions base under /v1/tools', () => {
    expect(providerFetchBaseUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/tools',
    );
    expect(providerFetchBaseUrl('https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/v1/tools',
    );
    expect(providerFetchBaseUrl('https://api.deepseek.com/anthropic/')).toBe(
      'https://api.deepseek.com/v1/tools',
    );
  });

  it('keeps a non-default port and scheme', () => {
    expect(providerFetchBaseUrl('http://127.0.0.1:8080/v1')).toBe(
      'http://127.0.0.1:8080/v1/tools',
    );
  });

  it('returns null for an unparseable base instead of throwing', () => {
    expect(providerFetchBaseUrl('not a url')).toBeNull();
    expect(providerFetchBaseUrl('')).toBeNull();
  });

  it('is what an un-overridden provider resolves to', () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'key' },
    });
    // Reaches /v1/tools/fetch: the request runs (and fails on the 401 that a
    // bogus key earns), instead of short-circuiting on a 404 for a bad path.
    expect(selection.backend?.id).toBe('provider');
    expect(selection.unavailableReason).toBeNull();
  });

  it('falls back to the local backend when the base cannot be derived', () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'openai', baseUrl: 'not a url', apiKey: 'key' },
    });
    expect(selection.backend?.id).toBe('http');
    expect(selection.fallbackFrom).toBe('provider');
  });

  it('drops the backend for an explicit provider backend with a bad base', () => {
    const selection = resolveFetchBackend({
      settings: { ...settings, provider: 'provider' },
      provider: { kind: 'openai', baseUrl: 'not a url', apiKey: 'key' },
    });
    expect(selection.backend).toBeNull();
  });
});

describe('Provider fetch backend', () => {
  it('posts the URL with the provider credential and returns Markdown', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: '# Hello' }));
    });
    const backend = createProviderFetchBackend({
      baseUrl: server.url,
      apiKey: 'secret',
      timeoutMs: 2_000,
    });
    await expect(backend.fetch('https://example.com/a', new AbortController().signal)).resolves.toEqual({
      content: '# Hello',
    });
    expect(server.requests[0]).toMatchObject({
      path: '/fetch',
      auth: 'Bearer secret',
      body: { url: 'https://example.com/a' },
    });
  });

  it('maps HTTP failures and malformed bodies to fetch errors', async () => {
    const failing = await fakeServer((_request, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    const backend = createProviderFetchBackend({ baseUrl: failing.url, apiKey: 'k', timeoutMs: 2_000 });
    await expect(backend.fetch('https://example.com', new AbortController().signal)).rejects.toBeInstanceOf(
      WebFetchError,
    );
    await expect(backend.fetch('https://example.com', new AbortController().signal)).rejects.toThrow(
      'HTTP 502 — bad gateway',
    );

    const malformed = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nope: true }));
    });
    const second = createProviderFetchBackend({ baseUrl: malformed.url, apiKey: 'k', timeoutMs: 2_000 });
    await expect(second.fetch('https://example.com', new AbortController().signal)).rejects.toThrow(
      'invalid response body',
    );
  });

  it('times out a slow backend', async () => {
    const slow = await fakeServer(() => {
      // never respond
    });
    const backend = createProviderFetchBackend({ baseUrl: slow.url, apiKey: 'k', timeoutMs: 50 });
    await expect(backend.fetch('https://example.com', new AbortController().signal)).rejects.toThrow(
      'timed out',
    );
  });
});

describe('WebFetch tool', () => {
  function tool(selection: ReturnType<typeof resolveFetchBackend>, provider = fakeProvider()) {
    return createWebFetchTool({
      selection,
      provider,
      model: 'm',
      maxInputTokens: 1_000,
      measure: (text) => text.length,
    });
  }

  it('describes the reach of whichever backend it got', () => {
    const providerTool = createWebFetchTool({
      selection: resolveFetchBackend({
        settings,
        provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'key' },
      }),
      provider: fakeProvider(async () => ''),
      model: 'fake-1',
      maxInputTokens: 1_000,
      measure: (text) => text.length,
    });
    expect(providerTool.descriptor.description).toContain('cannot reach intranet');

    const localTool = createWebFetchTool({
      selection: resolveFetchBackend({
        settings: { ...settings, provider: 'http' },
        provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: null },
      }),
      provider: fakeProvider(async () => ''),
      model: 'fake-1',
      maxInputTokens: 1_000,
      measure: (text) => text.length,
    });
    // The model must not be told it cannot reach what this backend can reach.
    expect(localTool.descriptor.description).toContain('can reach intranet and loopback');
    expect(localTool.descriptor.description).not.toContain('cannot reach intranet');
  });

  it('fails with the selection reason when the provider backend is explicit but unusable', async () => {
    const selection = resolveFetchBackend({
      settings: { ...settings, provider: 'provider' },
      provider: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: null },
    });
    await expect(tool(selection).call({ url: 'https://example.com' }, context())).rejects.toThrow(
      'no API key',
    );
  });

  it('describes the local backend reach when auto fell back', () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: null },
    });
    expect(selection.fallbackFrom).toBe('provider');
    expect(tool(selection).descriptor.description).toContain('can reach intranet and loopback');
  });

  it('rejects non-http URLs', async () => {
    const selection = resolveFetchBackend({
      settings,
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'key' },
    });
    await expect(tool(selection).call({ url: 'file:///etc/passwd' }, context())).rejects.toThrow(
      'only http and https',
    );
  });

  it('returns fetched text and extracts an answer when prompt is given', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: 'The answer is 42.' }));
    });
    const selection = resolveFetchBackend({
      settings: { ...settings, baseUrl: server.url },
      provider: { kind: 'openai', baseUrl: 'https://example.test', apiKey: 'key' },
    });

    const plain = await tool(selection).call({ url: 'https://example.com' }, context());
    expect(plain.isError).toBe(false);
    expect(plain.content).toContain('untrusted');
    expect(plain.content).toContain('The answer is 42.');

    let seenPrompt = '';
    const extracting = await tool(
      selection,
      fakeProvider(async (request) => {
        seenPrompt = String(request.messages[0]?.content ?? '');
        return { text: '42', toolCalls: [], finishReason: 'stop', usage: null };
      }),
    ).call({ url: 'https://example.com', prompt: 'what is the answer?' }, context());
    expect(extracting.isError).toBe(false);
    expect(extracting.content).toContain('42');
    expect(extracting.content).toContain('untrusted');
    expect(seenPrompt).toContain('what is the answer?');
    expect(seenPrompt).toContain('The answer is 42.');
  });
});

/**
 * The local backend (`provider: "http"`) is the only one that can reach this
 * machine, so its policy is tested directly: text bodies only, same-origin
 * redirects, bounded reads, no credential passthrough.
 */
describe('local HTTP fetch backend', () => {
  const local = { timeoutMs: 2_000 };

  it('returns a text body and sends no credentials', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('plain body');
    });
    const backend = createHttpFetchBackend(local);
    await expect(
      backend.fetch(`${server.url}/doc.txt`, new AbortController().signal),
    ).resolves.toEqual({ content: 'plain body' });
    // Nothing ambient is forwarded: no Authorization, no cookie.
    expect(server.requests[0]?.auth).toBeUndefined();
  });

  it('decodes JSON and XML as text', async () => {
    const server = await fakeServer((request, res) => {
      const isJson = request.path === '/data.json';
      res.writeHead(200, {
        'content-type': isJson ? 'application/json' : 'application/xml',
      });
      res.end(isJson ? '{"a":1}' : '<r><a>1</a></r>');
    });
    const backend = createHttpFetchBackend(local);
    const signal = new AbortController().signal;
    await expect(backend.fetch(`${server.url}/data.json`, signal)).resolves.toEqual({
      content: '{"a":1}',
    });
    await expect(backend.fetch(`${server.url}/data.xml`, signal)).resolves.toEqual({
      content: '<r><a>1</a></r>',
    });
  });

  it('converts an HTML body to Markdown instead of returning markup', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><script>alert(1)</script></head>' +
          '<body><h1>标题</h1><p>正文</p></body></html>',
      );
    });
    const backend = createHttpFetchBackend(local);
    const page = await backend.fetch(`${server.url}/`, new AbortController().signal);
    expect(page.content).toContain('# 标题');
    expect(page.content).toContain('正文');
    // Markup and scripts must not reach the model as prose.
    expect(page.content).not.toContain('<h1>');
    expect(page.content).not.toContain('alert');
  });

  it('refuses HTML nested past the conversion ceiling', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<div>'.repeat(600) + 'x');
    });
    const backend = createHttpFetchBackend(local);
    // Conversion is synchronous, so the guard — not the timeout — bounds it.
    await expect(
      backend.fetch(`${server.url}/`, new AbortController().signal),
    ).rejects.toThrow(/nests deeper than/);
  });

  it('refuses binary content types', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    });
    const backend = createHttpFetchBackend(local);
    await expect(
      backend.fetch(`${server.url}/a.pdf`, new AbortController().signal),
    ).rejects.toThrow(/unsupported content type/);
  });

  it('honours the declared charset', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-16le' });
      res.end(Buffer.from('你好', 'utf16le'));
    });
    const backend = createHttpFetchBackend(local);
    const page = await backend.fetch(`${server.url}/`, new AbortController().signal);
    expect(page.content).toBe('你好');
  });

  it('follows a same-origin redirect and reports the final body', async () => {
    const server = await fakeServer((request, res) => {
      if (request.path === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final body');
    });
    const backend = createHttpFetchBackend(local);
    await expect(
      backend.fetch(`${server.url}/start`, new AbortController().signal),
    ).resolves.toEqual({ content: 'final body' });
  });

  it('refuses a cross-origin redirect', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(302, { location: 'https://example.com/elsewhere' });
      res.end();
    });
    const backend = createHttpFetchBackend(local);
    await expect(
      backend.fetch(`${server.url}/start`, new AbortController().signal),
    ).rejects.toThrow(/cross-origin redirect/);
  });

  it('stops after the redirect cap', async () => {
    const server = await fakeServer((request, res) => {
      res.writeHead(302, { location: `${request.path}x` });
      res.end();
    });
    const backend = createHttpFetchBackend({ ...local, maxRedirects: 2 });
    await expect(
      backend.fetch(`${server.url}/r`, new AbortController().signal),
    ).rejects.toThrow(/maximum of 2 redirects/);
  });

  it('rejects an oversized Content-Length before reading', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' });
      res.end();
    });
    const backend = createHttpFetchBackend({ ...local, maxResponseBytes: 1024 });
    await expect(
      backend.fetch(`${server.url}/big`, new AbortController().signal),
    ).rejects.toThrow(/exceeds the maximum of 1024 bytes/);
  });

  it('cuts an under-reported body at the byte cap', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5_000));
    });
    const backend = createHttpFetchBackend({ ...local, maxResponseBytes: 100 });
    const page = await backend.fetch(`${server.url}/big`, new AbortController().signal);
    expect(page.content).toHaveLength(100);
  });

  it('caps the decoded body by character count', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('y'.repeat(500));
    });
    const backend = createHttpFetchBackend({ ...local, maxBodyChars: 50 });
    const page = await backend.fetch(`${server.url}/`, new AbortController().signal);
    expect(page.content).toHaveLength(50);
  });

  it('rejects credentials in the URL and non-http schemes', async () => {
    const backend = createHttpFetchBackend(local);
    const signal = new AbortController().signal;
    await expect(backend.fetch('https://user:secret@example.com', signal)).rejects.toThrow(
      /credentials in URLs/,
    );
    await expect(backend.fetch('file:///etc/passwd', signal)).rejects.toThrow(/only http and https/);
    await expect(backend.fetch('http://example.com/' + 'a'.repeat(3_000), signal)).rejects.toThrow(
      /maximum length/,
    );
  });

  it('times out a slow response', async () => {
    const server = await fakeServer((_request, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }, 5_000);
    });
    const backend = createHttpFetchBackend({ timeoutMs: 60 });
    await expect(
      backend.fetch(`${server.url}/slow`, new AbortController().signal),
    ).rejects.toThrow(/timed out/);
  });

  it('surfaces a non-2xx status', async () => {
    const server = await fakeServer((_request, res) => {
      res.writeHead(503);
      res.end('down');
    });
    const backend = createHttpFetchBackend(local);
    await expect(
      backend.fetch(`${server.url}/`, new AbortController().signal),
    ).rejects.toThrow(/HTTP 503/);
  });
});
