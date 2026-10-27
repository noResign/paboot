import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app/context';
import { registerAgentRoutes } from '../src/routes/agent';
import { CLAUDE_MODELS } from '../src/runtimes/claude/models';
import { createRegistry } from '../src/runtimes/registry';

vi.mock('../src/runtimes/codex/models', () => ({
  listCodexModels: vi.fn(async () => [{ id: 'gpt-5', label: 'GPT-5' }]),
}));

import { listCodexModels } from '../src/runtimes/codex/models';

const servers: Server[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function api(registry: Record<string, unknown>): Promise<string> {
  const app = express();
  registerAgentRoutes(app, { registry } as unknown as AppContext);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('GET /api/agents/:id/models', () => {
  it('returns each runtime catalogue and 404s an unknown runtime', async () => {
    const base = await api({
      list: () => [
        { id: 'claude', name: 'Claude Code', bin: 'claude' },
        { id: 'codex', name: 'Codex', bin: 'codex' },
      ],
      detection: () => ({ available: true }),
      detect: async () => ({ available: true }),
      listModels: async (id: string) =>
        id === 'claude' ? CLAUDE_MODELS : id === 'codex' ? [{ id: 'gpt-5', label: 'GPT-5' }] : undefined,
    });

    const claude = await (await fetch(`${base}/api/agents/claude/models`)).json();
    expect(claude).toEqual({ models: CLAUDE_MODELS });

    const codex = await (await fetch(`${base}/api/agents/codex/models`)).json();
    expect(codex).toEqual({ models: [{ id: 'gpt-5', label: 'GPT-5' }] });

    const unknown = await fetch(`${base}/api/agents/nope/models`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'unknown_runtime' });
  });

  it('leaves the agent list endpoint untouched', async () => {
    const base = await api({
      list: () => [{ id: 'codex', name: 'Codex', bin: 'codex' }],
      detection: () => ({ available: true }),
      detect: async () => ({ available: true }),
      listModels: async () => [],
    });

    const body = await (await fetch(`${base}/api/agents`)).json();
    expect(body.agents).toEqual([
      expect.objectContaining({ id: 'codex', name: 'Codex', bin: 'codex' }),
    ]);
  });
});

describe('Registry.listModels', () => {
  it('caches a detector catalogue and shares in-flight requests', async () => {
    const registry = createRegistry();

    const [first, second] = await Promise.all([
      registry.listModels('codex', {}),
      registry.listModels('codex', {}),
    ]);
    const third = await registry.listModels('codex', {});

    expect(first).toEqual([{ id: 'gpt-5', label: 'GPT-5' }]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(listCodexModels).toHaveBeenCalledOnce();
  });

  it('returns undefined for a runtime that does not exist', async () => {
    await expect(createRegistry().listModels('nope', {})).resolves.toBeUndefined();
  });
});
