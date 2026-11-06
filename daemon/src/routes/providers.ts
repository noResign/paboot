import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { parseModelPrice, type ProviderModel, type RealProviderKind } from '../llm/catalog.js';
import { LlmError } from '../llm/types.js';
import { ProviderManagerError, type ProviderCreateInput, type ProviderUpdateInput } from '../providers/provider-manager.js';

export function registerProviderRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/providers', async (_req, res) => {
    try {
      res.json({ providers: await ctx.providers.list() });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post('/api/providers', async (req, res) => {
    try {
      const input = parseCreate(req.body);
      const provider = await ctx.providers.create(input);
      ctx.registry.invalidate('builtin');
      res.status(201).json({ ok: true, provider });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.patch('/api/providers/:id', async (req, res) => {
    try {
      const input = parseUpdate(req.body);
      if (Object.keys(input).length === 0) {
        throw new ProviderManagerError('at least one field is required', 'bad_request', 400);
      }
      const provider = await ctx.providers.update(req.params.id, input);
      ctx.registry.invalidate('builtin');
      res.json({ ok: true, provider });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.delete('/api/providers/:id', async (req, res) => {
    try {
      await ctx.providers.delete(req.params.id);
      ctx.registry.invalidate('builtin');
      res.json({ ok: true, id: req.params.id });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post('/api/providers/:id/test', async (req, res) => {
    try {
      const result = await ctx.providers.test(req.params.id);
      res.json(result);
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post('/api/providers/:id/models/refresh', async (req, res) => {
    try {
      const provider = await ctx.providers.refreshModels(req.params.id);
      ctx.registry.invalidate('builtin');
      res.json({ ok: true, provider });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

function parseCreate(body: unknown): ProviderCreateInput {
  const record = asRecord(body);
  if (!record) throw bad('request body must be an object');
  const id = requireString(record, 'id');
  const kind = parseKind(record['kind']);
  const baseUrl = requireString(record, 'baseUrl');
  const input: ProviderCreateInput = {
    id,
    kind,
    baseUrl,
    ...(record['label'] === undefined ? {} : { label: requireString(record, 'label') }),
    ...(record['apiKeyEnv'] === undefined
      ? {}
      : { apiKeyEnv: nullableString(record['apiKeyEnv'], 'apiKeyEnv') }),
    ...(record['apiKey'] === undefined ? {} : { apiKey: nullableString(record['apiKey'], 'apiKey') }),
    ...(record['models'] === undefined ? {} : { models: parseModels(record['models']) }),
  };
  return input;
}

function parseUpdate(body: unknown): ProviderUpdateInput {
  const record = asRecord(body);
  if (!record) throw bad('request body must be an object');
  const input: ProviderUpdateInput = {};
  if (record['kind'] !== undefined) input.kind = parseKind(record['kind']);
  if (record['label'] !== undefined) input.label = requireString(record, 'label');
  if (record['baseUrl'] !== undefined) input.baseUrl = requireString(record, 'baseUrl');
  if (record['apiKey'] !== undefined) input.apiKey = nullableString(record['apiKey'], 'apiKey');
  if (record['apiKeyEnv'] !== undefined) {
    input.apiKeyEnv = nullableString(record['apiKeyEnv'], 'apiKeyEnv');
  }
  if (record['models'] !== undefined) input.models = parseModels(record['models']);
  return input;
}

function parseModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) throw bad('models must be an array');
  return value.map((item, index) => {
    const record = asRecord(item);
    if (!record) throw bad(`models[${index}] must be an object`);
    const model: ProviderModel = { id: requireString(record, 'id') };
    if (record['label'] !== undefined) model.label = requireString(record, 'label');
    for (const key of ['contextWindow', 'maxOutput'] as const) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== 'number' || !Number.isInteger(record[key]) || record[key] <= 0) {
          throw bad(`${key} must be a positive integer`);
        }
        model[key] = record[key];
      }
    }
    for (const key of ['supportsTools', 'supportsImages', 'enabled'] as const) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== 'boolean') throw bad(`${key} must be boolean`);
        model[key] = record[key];
      }
    }
    if (record['price'] !== undefined) {
      model.price = parseModelPrice(record['price'], `models[${index}]`);
    }
    return model;
  });
}

function parseKind(value: unknown): RealProviderKind {
  if (value !== 'anthropic' && value !== 'openai') {
    throw bad('kind must be anthropic or openai');
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw bad(`${key} must be a non-empty string`);
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw bad(`${field} must be a string or null`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bad(message: string): ProviderManagerError {
  return new ProviderManagerError(message, 'bad_request', 400);
}

function sendProviderError(res: Response, error: unknown): void {
  if (error instanceof ProviderManagerError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof LlmError) {
    res.status(400).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
    code: 'provider_internal_error',
  });
}
