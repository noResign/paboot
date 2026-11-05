import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { AnthropicProvider, buildAnthropicBody } from '../src/llm/anthropic';
import { LlmRequestError } from '../src/llm/errors';
import { aggregateCompletion } from '../src/llm/complete';
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
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
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
    maxTokens: 512,
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

const anthropicFrames = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"Read","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"src/a.ts\\"}"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

describe('Anthropic provider', () => {
  it('streams text, tool deltas, usage and finish; complete() aggregates the same stream', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders: http.IncomingHttpHeaders | null = null;
    const baseUrl = await listen((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        capturedBody = JSON.parse(body) as Record<string, unknown>;
        capturedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const frame of anthropicFrames) {
          const middle = Math.floor(frame.length / 2);
          res.write(frame.slice(0, middle));
          res.write(frame.slice(middle));
        }
        res.end();
      });
    });
    const provider = new AnthropicProvider({
      id: 'anthropic',
      baseUrl,
      apiKey: 'sk-ant-test',
      retry: { sleep: async () => undefined },
    });

    const chunks = await collect(provider.stream(request()));
    expect(chunks).toContainEqual({ type: 'text_delta', text: 'hello ' });
    expect(chunks).toContainEqual({
      type: 'tool_call_start',
      index: 1,
      id: 'tool-1',
      name: 'Read',
    });
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 9, cacheReadTokens: 3 },
      contextTokens: 15,
    });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: 'tool_use' });

    expect(capturedHeaders).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    expect(capturedBody).toMatchObject({
      model: 'claude-sonnet-4-6',
      system: 'You are paboot.',
      max_tokens: 512,
      stream: true,
      tools: [
        {
          name: 'Read',
          description: 'Read a text file',
          input_schema: expect.any(Object),
        },
      ],
    });

    const completion = await provider.complete(request());
    expect(completion.text).toBe('hello ');
    expect(completion.finishReason).toBe('tool_use');
    expect(completion.toolCalls).toEqual<LlmToolCall[]>([
      { id: 'tool-1', name: 'Read', arguments: '{"file_path":"src/a.ts"}' },
    ]);
    expect(completion.usage).toMatchObject({ inputTokens: 12, outputTokens: 9 });
  });

  it('classifies auth failures and never retries them', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key sk-ant-secret-12345678' } }));
    });
    const provider = new AnthropicProvider({
      id: 'anthropic',
      baseUrl,
      apiKey: 'sk-ant-test',
      retry: { sleep: async () => undefined },
    });

    const error = await collect(provider.stream(request())).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({ code: 'auth', retryable: false });
    expect(String((error as Error).message)).not.toContain('sk-ant-secret');
    expect(calls).toBe(1);
  });

  it('retries a retryable failure only before any chunk is emitted', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'temporary' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(anthropicFrames.join(''));
    });
    const provider = new AnthropicProvider({
      id: 'anthropic',
      baseUrl,
      apiKey: 'sk-ant-test',
      retry: { sleep: async () => undefined, maxAttempts: 2 },
    });

    const chunks = await collect(provider.stream(request()));
    expect(calls).toBe(2);
    expect(chunks.some((chunk) => chunk.type === 'text_delta')).toBe(true);
  });

  it('fails a stream that ends before message_stop', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(anthropicFrames.slice(0, 3).join(''));
    });
    const provider = new AnthropicProvider({
      id: 'anthropic',
      baseUrl,
      apiKey: 'sk-ant-test',
      retry: { sleep: async () => undefined },
    });

    await expect(collect(provider.stream(request()))).rejects.toMatchObject({
      code: 'stream_incomplete',
    });
  });

  it('renders image and tool-result neutral blocks into Anthropic messages', () => {
    const signal = new AbortController().signal;
    const body = buildAnthropicBody({
      ...request(signal),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tool-1', content: 'file body', isError: false },
          ],
        },
      ],
    });

    expect(body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body' }],
      },
    ]);
  });

  it('aggregates a hand-built chunk stream', async () => {
    async function* chunks(): AsyncIterable<LlmChunk> {
      yield { type: 'reasoning_delta', text: 'think' };
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'finish', reason: 'stop' };
    }
    await expect(aggregateCompletion(chunks())).resolves.toMatchObject({
      text: 'answer',
      reasoning: 'think',
      finishReason: 'stop',
      toolCalls: [],
    });
  });
});
