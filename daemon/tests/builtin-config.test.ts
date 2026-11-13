import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveContextBudget } from '../src/runtimes/builtin/budget';
import {
  DEFAULT_BUILTIN_CONFIG,
  builtinConfigPath,
  loadBuiltinConfig,
  parseBuiltinConfig,
} from '../src/runtimes/builtin/config';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-builtin-config-'));
  dirs.push(dir);
  return dir;
}

describe('builtin config', () => {
  it('uses defaults when the file is missing', async () => {
    const dataDir = tempDir();
    const loaded = await loadBuiltinConfig(dataDir);

    expect(loaded.path).toBe(builtinConfigPath(dataDir));
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config).toEqual(DEFAULT_BUILTIN_CONFIG);
  });

  it('keeps local and server bypass switches independent', () => {
    const defaults = parseBuiltinConfig({}).config;
    expect(defaults.allowLocalBypass).toBe(true);
    expect(defaults.allowServerBypass).toBe(false);

    const serverOn = parseBuiltinConfig({
      securityProfile: 'server-strict',
      allowServerBypass: true,
    }).config;
    expect(serverOn.allowLocalBypass).toBe(true);
    expect(serverOn.allowServerBypass).toBe(true);

    const localOff = parseBuiltinConfig({
      securityProfile: 'local',
      allowLocalBypass: false,
    }).config;
    expect(localOff.allowLocalBypass).toBe(false);
    expect(localOff.allowServerBypass).toBe(false);
  });

  it('maps the deprecated allowBypass flag to both switches', () => {
    const { config, warnings } = parseBuiltinConfig({
      allowBypass: false,
      allowServerBypass: true,
    });
    expect(config.allowLocalBypass).toBe(false);
    expect(config.allowServerBypass).toBe(true);
    expect(warnings.join('\n')).toContain('allowBypass');
  });

  it('accepts the deprecated fsProfile alias with a warning', () => {
    const { config, warnings } = parseBuiltinConfig({ fsProfile: 'server-strict' });
    expect(config.securityProfile).toBe('server-strict');
    expect(config.allowLocalBypass).toBe(true);
    expect(config.allowServerBypass).toBe(false);
    expect(warnings.join('\n')).toContain('fsProfile');
  });

  it('deep-merges partial overrides over the defaults', async () => {
    const dataDir = tempDir();
    fs.writeFileSync(
      path.join(dataDir, 'builtin.json'),
      JSON.stringify({
        securityProfile: 'server-strict',
        allowServerBypass: true,
        context: { runtimeContextRatio: 0.2 },
        tools: {
          read: { defaultLimit: 10, maxLimit: 10 },
          write: { maxFileBytes: 2048 },
          edit: { maxFileBytes: 1024 },
          bash: {
            defaultTimeoutMs: 5000,
            maxTimeoutMs: 6000,
            maxOutputBytes: 2048,
            envAllow: ['FOO'],
          },
          spill: { retentionDays: 3 },
          grep: { maxResults: 50, maxFileBytes: 1024, maxLineChars: 100 },
          glob: { maxResults: 25 },
        },
      }),
    );

    const loaded = await loadBuiltinConfig(dataDir);

    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.securityProfile).toBe('server-strict');
    expect(loaded.config.allowServerBypass).toBe(true);
    expect(loaded.config.context.runtimeContextRatio).toBe(0.2);
    expect(loaded.config.context.systemPromptRatio).toBe(
      DEFAULT_BUILTIN_CONFIG.context.systemPromptRatio,
    );
    expect(loaded.config.tools.read.defaultLimit).toBe(10);
    expect(loaded.config.tools.read.maxFileBytes).toBe(
      DEFAULT_BUILTIN_CONFIG.tools.read.maxFileBytes,
    );
    expect(loaded.config.tools.write.maxFileBytes).toBe(2048);
    expect(loaded.config.tools.edit.maxFileBytes).toBe(1024);
    expect(loaded.config.tools.bash.defaultTimeoutMs).toBe(5000);
    expect(loaded.config.tools.bash.envAllow).toEqual(['FOO']);
    expect(loaded.config.tools.spill.retentionDays).toBe(3);
    expect(loaded.config.tools.grep.maxResults).toBe(50);
    expect(loaded.config.tools.grep.maxLineChars).toBe(100);
    expect(loaded.config.tools.glob.maxResults).toBe(25);
  });

  it('warns and falls back per field for invalid values', () => {
    const { config, warnings } = parseBuiltinConfig({
      version: 1,
      context: { systemPromptRatio: 2, runtimeContextRatio: 'lots' },
      tools: {
        read: { defaultLimit: 10, maxLimit: 5 },
        write: { maxFileBytes: 0 },
        bash: { defaultTimeoutMs: 10, maxTimeoutMs: 5, envAllow: 'nope' },
      },
      unknown: true,
    });

    expect(config.context.systemPromptRatio).toBe(
      DEFAULT_BUILTIN_CONFIG.context.systemPromptRatio,
    );
    expect(config.context.runtimeContextRatio).toBe(
      DEFAULT_BUILTIN_CONFIG.context.runtimeContextRatio,
    );
    expect(config.tools.read.defaultLimit).toBe(DEFAULT_BUILTIN_CONFIG.tools.read.defaultLimit);
    expect(config.tools.read.maxLimit).toBe(DEFAULT_BUILTIN_CONFIG.tools.read.maxLimit);
    expect(warnings.join('\n')).toContain('context.systemPromptRatio');
    expect(warnings.join('\n')).toContain('context.runtimeContextRatio');
    expect(config.tools.write.maxFileBytes).toBe(
      DEFAULT_BUILTIN_CONFIG.tools.write.maxFileBytes,
    );
    expect(config.tools.bash.defaultTimeoutMs).toBe(
      DEFAULT_BUILTIN_CONFIG.tools.bash.defaultTimeoutMs,
    );
    expect(config.tools.bash.envAllow).toEqual([]);
    expect(warnings.join('\n')).toContain('defaultLimit must not exceed maxLimit');
    expect(warnings.join('\n')).toContain('tools.write.maxFileBytes');
    expect(warnings.join('\n')).toContain('defaultTimeoutMs must not exceed maxTimeoutMs');
    expect(warnings.join('\n')).toContain('envAllow must be a string array');
    expect(warnings.join('\n')).toContain('unknown key "unknown"');
  });

  it('refuses an unsupported version and malformed JSON', async () => {
    const unsupported = parseBuiltinConfig({ version: 2, fsProfile: 'local' });
    expect(unsupported.config).toEqual(DEFAULT_BUILTIN_CONFIG);
    expect(unsupported.warnings.join('\n')).toContain('unsupported builtin config version');

    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'builtin.json'), '{not json');
    const loaded = await loadBuiltinConfig(dataDir);
    expect(loaded.config).toEqual(DEFAULT_BUILTIN_CONFIG);
    expect(loaded.warnings.join('\n')).toContain('not valid JSON');
  });
});

describe('builtin context budget derivation', () => {
  it('derives budget from the model window with caps', () => {
    const at128k = resolveContextBudget(DEFAULT_BUILTIN_CONFIG, 128_000);
    expect(at128k.contextWindowTokens).toBe(128_000);
    expect(at128k.systemPromptTokens).toBe(5_120);
    expect(at128k.runtimeContextTokens).toBe(12_800);
    expect(at128k.projectDocsTokens).toBe(6_400);
    expect(at128k.maxResultTokens).toBe(8_000);

    const at200k = resolveContextBudget(DEFAULT_BUILTIN_CONFIG, 200_000);
    expect(at200k.systemPromptTokens).toBe(8_000);
    expect(at200k.runtimeContextTokens).toBe(20_000);
    expect(at200k.projectDocsTokens).toBe(10_000);

    const at1m = resolveContextBudget(DEFAULT_BUILTIN_CONFIG, 1_000_000);
    expect(at1m.systemPromptTokens).toBe(8_000);
    expect(at1m.runtimeContextTokens).toBe(24_000);
    expect(at1m.projectDocsTokens).toBe(12_000);
  });

  it('falls back to the configured window when the catalogue has none', () => {
    const budget = resolveContextBudget(DEFAULT_BUILTIN_CONFIG, undefined);
    expect(budget.contextWindowTokens).toBe(DEFAULT_BUILTIN_CONFIG.context.fallbackWindowTokens);
    expect(budget.runtimeContextTokens).toBe(12_800);
  });
});
