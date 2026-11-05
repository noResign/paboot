import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOpenAIBody, OpenAIProvider } from '../src/llm/openai';
import type { LlmChunk, LlmRequest, LlmToolCall } from '../src/llm/types';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function request(signal = new AbortController().signal): LlmRequest {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    system: 'You are paboot.',
    messages: [{ role: 'user', content: 'read the file' }],
    tools: [
      {
        name: 'Read',
        description: 'Read a text file',
        inputSchema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ],
    maxTokens: 256,
    signal,
  };
}

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const openAIFrames = [
  'data: {"choices":[{"delta":{"content":"Hi "},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"file"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"x\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
  'data: [DONE]\n\n',
];

describe('OpenAI-compatible provider', () => {
  it('streams text, tool call arguments, usage and finish; complete() aggregates the same stream', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedAuth: string | undefined;
    const baseUrl = await listen((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        capturedBody = JSON.parse(body) as Record<string, unknown>;
        capturedAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const frame of openAIFrames) {
          const middle = Math.floor(frame.length / 3);
          res.write(frame.slice(0, middle));
          res.write(frame.slice(middle, middle * 2));
          res.write(frame.slice(middle * 2));
        }
        res.end();
      });
    });
    const provider = new OpenAIProvider({
      id: 'deepseek',
      baseUrl,
      apiKey: 'sk-test',
    });

    const chunks = await collect(provider.stream(request()));
    expect(chunks).toContainEqual({ type: 'text_delta', text: 'Hi ' });
    expect(chunks).toContainEqual({
      type: 'tool_call_start',
      index: 0,
      id: 'call_1',
      name: 'Read',
    });
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 8, outputTokens: 4, cacheReadTokens: 2 },
      contextTokens: 10,
    });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: 'tool_use' });
    expect(capturedAuth).toBe('Bearer sk-test');
    expect(capturedBody).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      max_tokens: 256,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: { name: 'Read', description: 'Read a text file' },
        },
      ],
    });

    const completion = await provider.complete(request());
    expect(completion.text).toBe('Hi ');
    expect(completion.finishReason).toBe('tool_use');
    expect(completion.toolCalls).toEqual<LlmToolCall[]>([
      { id: 'call_1', name: 'Read', arguments: '{"file_path":"x"}' },
    ]);
    expect(completion.usage).toMatchObject({ inputTokens: 8, outputTokens: 4 });
  });

  it('renders system, image, assistant tool_calls and tool results', () => {
    const body = buildOpenAIBody(
      {
        ...request(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', mediaType: 'image/jpeg', data: '/9j/' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              { type: 'tool_use', id: 'call_9', name: 'Read', input: { file_path: 'a.ts' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'call_9', content: 'file body' }],
          },
        ],
      },
      { maxTokensField: 'max_completion_tokens' },
    );

    expect(body['max_completion_tokens']).toBe(256);
    expect(body['messages']).toEqual([
      { role: 'system', content: 'You are paboot.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } },
        ],
      },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          {
            id: 'call_9',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_9', content: 'file body' },
    ]);
  });

  it('can disable stream usage for stricter compatible gateways', () => {
    const body = buildOpenAIBody(request(), { includeStreamUsage: false });
    expect(body).not.toHaveProperty('stream_options');
  });

  it('does not retry after a text chunk was emitted', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    });
    const provider = new OpenAIProvider({
      id: 'deepseek',
      baseUrl,
      apiKey: 'sk-test',
      retry: { sleep: async () => undefined, maxAttempts: 3 },
    });

    await expect(collect(provider.stream(request()))).rejects.toMatchObject({
      code: 'stream_incomplete',
    });
    expect(calls).toBe(1);
  });

  it('retries a server error before the first chunk', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'busy' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });
    const provider = new OpenAIProvider({
      id: 'deepseek',
      baseUrl,
      apiKey: 'sk-test',
      retry: { sleep: async () => undefined, maxAttempts: 2 },
    });

    const chunks = await collect(provider.stream(request()));
    expect(calls).toBe(2);
    expect(chunks).toContainEqual({ type: 'text_delta', text: 'ok' });
  });
});
