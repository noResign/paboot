import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../src/runtimes/codex/rpc', () => ({
  initializeCodexAppServer: vi.fn(async () => ({})),
  spawnCodexAppServer: vi.fn(() => ({ request: rpc.request, close: rpc.close })),
}));

import { listCodexModels } from '../src/runtimes/codex/models';

beforeEach(() => {
  rpc.request.mockReset();
  rpc.close.mockReset().mockResolvedValue(undefined);
});

describe('listCodexModels', () => {
  it('pages through model/list and maps the slug with the display name', async () => {
    rpc.request
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5',
            displayName: 'GPT-5',
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'high' },
              { reasoningEffort: 'low' },
            ],
          },
          { id: 'secret', displayName: 'Secret', hidden: true },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'row-id', model: 'o3' }],
      });

    const models = await listCodexModels('codex', {});

    expect(models).toEqual([
      {
        id: 'gpt-5',
        label: 'GPT-5',
        parameters: [
          {
            id: 'reasoningEffort',
            label: 'Reasoning effort',
            values: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High' },
            ],
            defaultId: 'low',
          },
        ],
      },
      { id: 'o3', label: 'o3' },
    ]);
    expect(rpc.request).toHaveBeenNthCalledWith(1, 'model/list', {}, 10_000);
    expect(rpc.request).toHaveBeenNthCalledWith(2, 'model/list', { cursor: 'page-2' }, 10_000);
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it('dedupes ids and stops when the server repeats a cursor', async () => {
    rpc.request
      .mockResolvedValueOnce({ data: [{ id: 'a' }, { id: 'a' }], nextCursor: 'same' })
      .mockResolvedValueOnce({ data: [{ id: 'b' }], nextCursor: 'same' });

    const models = await listCodexModels('codex', {});

    expect(models.map((model) => model.id)).toEqual(['a', 'b']);
    expect(rpc.request).toHaveBeenCalledTimes(2);
  });

  it('closes the process and rethrows when the catalogue cannot be read', async () => {
    rpc.request.mockRejectedValueOnce(new Error('model/list unavailable'));

    await expect(listCodexModels('codex', {})).rejects.toThrow('model/list unavailable');
    expect(rpc.close).toHaveBeenCalledOnce();
  });
});
