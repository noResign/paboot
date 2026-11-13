import fs from 'node:fs/promises';
import path from 'node:path';

import { log } from '../../platform/log.js';

/**
 * Central configuration for the builtin runtime. Everything is optional in
 * `<dataDir>/builtin.json`; these defaults are the product settings and should
 * be enough for normal use. No environment variables.
 */
export interface BuiltinRuntimeConfig {
  version: 1;
  /**
   * Daemon-wide security posture. `local` is the single-user machine profile;
   * `server-strict` restricts all runtimes and path access for deployment.
   */
  securityProfile: 'local' | 'server-strict';
  /** Whether `permissionMode=bypass` is honored while `securityProfile=local`. */
  allowLocalBypass: boolean;
  /** Whether `permissionMode=bypass` is honored while `securityProfile=server-strict`. */
  allowServerBypass: boolean;
  context: {
    /** Window used when the provider catalogue has no contextWindow. */
    fallbackWindowTokens: number;
    /** Fraction of the model window reserved for the system prompt. */
    systemPromptRatio: number;
    maxSystemPromptTokens: number;
    /** Fraction of the model window reserved for the runtime-context channel. */
    runtimeContextRatio: number;
    maxRuntimeContextTokens: number;
  };
  projectDocs: {
    /** Share of the runtime-context budget project docs may occupy. */
    shareOfRuntimeContext: number;
    maxTokens: number;
    /** Per-file I/O safety cap (bytes), independent of the token budget. */
    maxFileBytes: number;
  };
  tools: {
    /** Every tool result is truncated to this many tokens before it is stored/broadcast. */
    maxResultTokens: number;
    read: {
      maxFileBytes: number;
      defaultLimit: number;
      maxLimit: number;
      maxLineChars: number;
    };
    write: {
      maxFileBytes: number;
    };
    edit: {
      maxFileBytes: number;
    };
    bash: {
      defaultTimeoutMs: number;
      maxTimeoutMs: number;
      maxOutputBytes: number;
      /** Extra env vars passed to shell commands (default: none beyond the base set). */
      envAllow: string[];
    };
    spill: {
      retentionDays: number;
    };
    grep: {
      maxResults: number;
      maxFileBytes: number;
      maxLineChars: number;
    };
    glob: {
      maxResults: number;
    };
  };
  skills: {
    maxFileBytes: number;
    catalogDescriptionChars: number;
  };
  agent: {
    maxSteps: number;
    maxToolCalls: number;
  };
}

export const DEFAULT_BUILTIN_CONFIG: BuiltinRuntimeConfig = {
  version: 1,
  securityProfile: 'local',
  allowLocalBypass: true,
  allowServerBypass: false,
  context: {
    fallbackWindowTokens: 128_000,
    systemPromptRatio: 0.04,
    maxSystemPromptTokens: 8_000,
    runtimeContextRatio: 0.1,
    maxRuntimeContextTokens: 24_000,
  },
  projectDocs: {
    shareOfRuntimeContext: 0.5,
    maxTokens: 16_000,
    maxFileBytes: 32 * 1024,
  },
  tools: {
    maxResultTokens: 8_000,
    read: {
      maxFileBytes: 8 * 1024 * 1024,
      defaultLimit: 2_000,
      maxLimit: 2_000,
      maxLineChars: 4_000,
    },
    write: {
      maxFileBytes: 8 * 1024 * 1024,
    },
    edit: {
      maxFileBytes: 8 * 1024 * 1024,
    },
    bash: {
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      maxOutputBytes: 32 * 1024,
      envAllow: [],
    },
    spill: {
      retentionDays: 7,
    },
    grep: {
      maxResults: 1_000,
      maxFileBytes: 8 * 1024 * 1024,
      maxLineChars: 500,
    },
    glob: {
      maxResults: 2_000,
    },
  },
  skills: {
    maxFileBytes: 256 * 1024,
    catalogDescriptionChars: 500,
  },
  agent: {
    maxSteps: 100,
    maxToolCalls: 200,
  },
};

export interface LoadedBuiltinConfig {
  config: BuiltinRuntimeConfig;
  warnings: string[];
  path: string;
}

export function builtinConfigPath(dataDir: string): string {
  return path.join(dataDir, 'builtin.json');
}

/** Missing file means defaults; malformed/partial files warn and fall back per field. */
export async function loadBuiltinConfig(dataDir: string): Promise<LoadedBuiltinConfig> {
  const filePath = builtinConfigPath(dataDir);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: cloneDefault(), warnings: [], path: filePath };
    }
    return {
      config: cloneDefault(),
      warnings: [`could not read ${path.basename(filePath)}; using defaults`],
      path: filePath,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      config: cloneDefault(),
      warnings: [`${path.basename(filePath)} is not valid JSON; using defaults`],
      path: filePath,
    };
  }
  return { ...parseBuiltinConfig(raw), path: filePath };
}

export function parseBuiltinConfig(raw: unknown): {
  config: BuiltinRuntimeConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    warnings.push('builtin config must be a JSON object; using defaults');
    return { config: cloneDefault(), warnings };
  }

  const version = raw['version'];
  if (version !== undefined && version !== 1) {
    warnings.push(`unsupported builtin config version "${String(version)}"; using defaults`);
    return { config: cloneDefault(), warnings };
  }
  warnUnknown(
    raw,
    [
      'version',
      'securityProfile',
      'allowLocalBypass',
      'allowServerBypass',
      'allowBypass',
      'fsProfile',
      'context',
      'projectDocs',
      'tools',
      'skills',
      'agent',
    ],
    '',
    warnings,
  );

  const config = cloneDefault();
  if (raw['fsProfile'] !== undefined) {
    warnings.push('"fsProfile" is deprecated; use "securityProfile"');
  }
  if (raw['securityProfile'] !== undefined && raw['fsProfile'] !== undefined
    && raw['securityProfile'] !== raw['fsProfile']) {
    warnings.push('both "securityProfile" and "fsProfile" are set; using "securityProfile"');
  }
  config.securityProfile = enumField(
    raw['securityProfile'] ?? raw['fsProfile'],
    'securityProfile',
    ['server-strict', 'local'],
    config.securityProfile,
    warnings,
  );
  // Legacy single flag: apply it to both profiles, then let the split fields
  // override individually. The two flags stay independent so switching the
  // active profile does not lose the other profile's setting.
  const legacyBypass = raw['allowBypass'];
  if (legacyBypass !== undefined) {
    warnings.push('"allowBypass" is deprecated; use "allowLocalBypass"/"allowServerBypass"');
  }
  const legacyBypassValue =
    typeof legacyBypass === 'boolean' ? legacyBypass : undefined;
  if (legacyBypass !== undefined && legacyBypassValue === undefined) {
    warnings.push('allowBypass must be a boolean');
  }
  config.allowLocalBypass = boolField(
    raw['allowLocalBypass'],
    'allowLocalBypass',
    legacyBypassValue ?? config.allowLocalBypass,
    warnings,
  );
  config.allowServerBypass = boolField(
    raw['allowServerBypass'],
    'allowServerBypass',
    legacyBypassValue ?? config.allowServerBypass,
    warnings,
  );

  const context = section(raw['context'], 'context', warnings);
  if (context) {
    warnUnknown(
      context,
      [
        'fallbackWindowTokens',
        'systemPromptRatio',
        'maxSystemPromptTokens',
        'runtimeContextRatio',
        'maxRuntimeContextTokens',
      ],
      'context',
      warnings,
    );
    config.context.fallbackWindowTokens = intField(
      context['fallbackWindowTokens'],
      'context.fallbackWindowTokens',
      1_024,
      config.context.fallbackWindowTokens,
      warnings,
    );
    config.context.systemPromptRatio = ratioField(
      context['systemPromptRatio'],
      'context.systemPromptRatio',
      config.context.systemPromptRatio,
      warnings,
    );
    config.context.maxSystemPromptTokens = intField(
      context['maxSystemPromptTokens'],
      'context.maxSystemPromptTokens',
      256,
      config.context.maxSystemPromptTokens,
      warnings,
    );
    config.context.runtimeContextRatio = ratioField(
      context['runtimeContextRatio'],
      'context.runtimeContextRatio',
      config.context.runtimeContextRatio,
      warnings,
    );
    config.context.maxRuntimeContextTokens = intField(
      context['maxRuntimeContextTokens'],
      'context.maxRuntimeContextTokens',
      256,
      config.context.maxRuntimeContextTokens,
      warnings,
    );
  }

  const projectDocs = section(raw['projectDocs'], 'projectDocs', warnings);
  if (projectDocs) {
    warnUnknown(
      projectDocs,
      ['shareOfRuntimeContext', 'maxTokens', 'maxFileBytes'],
      'projectDocs',
      warnings,
    );
    config.projectDocs.shareOfRuntimeContext = ratioField(
      projectDocs['shareOfRuntimeContext'],
      'projectDocs.shareOfRuntimeContext',
      config.projectDocs.shareOfRuntimeContext,
      warnings,
    );
    config.projectDocs.maxTokens = intField(
      projectDocs['maxTokens'],
      'projectDocs.maxTokens',
      256,
      config.projectDocs.maxTokens,
      warnings,
    );
    config.projectDocs.maxFileBytes = intField(
      projectDocs['maxFileBytes'],
      'projectDocs.maxFileBytes',
      1_024,
      config.projectDocs.maxFileBytes,
      warnings,
    );
  }

  const tools = section(raw['tools'], 'tools', warnings);
  if (tools) {
    warnUnknown(
      tools,
      ['maxResultTokens', 'read', 'write', 'edit', 'bash', 'spill', 'grep', 'glob'],
      'tools',
      warnings,
    );
    config.tools.maxResultTokens = intField(
      tools['maxResultTokens'],
      'tools.maxResultTokens',
      256,
      config.tools.maxResultTokens,
      warnings,
    );
    const read = section(tools['read'], 'tools.read', warnings);
    if (read) {
      warnUnknown(
        read,
        ['maxFileBytes', 'defaultLimit', 'maxLimit', 'maxLineChars'],
        'tools.read',
        warnings,
      );
      config.tools.read.maxFileBytes = intField(
        read['maxFileBytes'],
        'tools.read.maxFileBytes',
        1_024,
        config.tools.read.maxFileBytes,
        warnings,
      );
      config.tools.read.defaultLimit = intField(
        read['defaultLimit'],
        'tools.read.defaultLimit',
        1,
        config.tools.read.defaultLimit,
        warnings,
      );
      config.tools.read.maxLimit = intField(
        read['maxLimit'],
        'tools.read.maxLimit',
        1,
        config.tools.read.maxLimit,
        warnings,
      );
      config.tools.read.maxLineChars = intField(
        read['maxLineChars'],
        'tools.read.maxLineChars',
        100,
        config.tools.read.maxLineChars,
        warnings,
      );
      if (config.tools.read.defaultLimit > config.tools.read.maxLimit) {
        warnings.push('tools.read.defaultLimit must not exceed maxLimit; using defaults');
        config.tools.read.defaultLimit = DEFAULT_BUILTIN_CONFIG.tools.read.defaultLimit;
        config.tools.read.maxLimit = DEFAULT_BUILTIN_CONFIG.tools.read.maxLimit;
      }
    }
    const write = section(tools['write'], 'tools.write', warnings);
    if (write) {
      warnUnknown(write, ['maxFileBytes'], 'tools.write', warnings);
      config.tools.write.maxFileBytes = intField(
        write['maxFileBytes'],
        'tools.write.maxFileBytes',
        1_024,
        config.tools.write.maxFileBytes,
        warnings,
      );
    }
    const edit = section(tools['edit'], 'tools.edit', warnings);
    if (edit) {
      warnUnknown(edit, ['maxFileBytes'], 'tools.edit', warnings);
      config.tools.edit.maxFileBytes = intField(
        edit['maxFileBytes'],
        'tools.edit.maxFileBytes',
        1_024,
        config.tools.edit.maxFileBytes,
        warnings,
      );
    }
    const bash = section(tools['bash'], 'tools.bash', warnings);
    if (bash) {
      warnUnknown(
        bash,
        ['defaultTimeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'envAllow'],
        'tools.bash',
        warnings,
      );
      config.tools.bash.defaultTimeoutMs = intField(
        bash['defaultTimeoutMs'],
        'tools.bash.defaultTimeoutMs',
        1,
        config.tools.bash.defaultTimeoutMs,
        warnings,
      );
      config.tools.bash.maxTimeoutMs = intField(
        bash['maxTimeoutMs'],
        'tools.bash.maxTimeoutMs',
        1,
        config.tools.bash.maxTimeoutMs,
        warnings,
      );
      config.tools.bash.maxOutputBytes = intField(
        bash['maxOutputBytes'],
        'tools.bash.maxOutputBytes',
        1_024,
        config.tools.bash.maxOutputBytes,
        warnings,
      );
      if (config.tools.bash.defaultTimeoutMs > config.tools.bash.maxTimeoutMs) {
        warnings.push('tools.bash.defaultTimeoutMs must not exceed maxTimeoutMs; using defaults');
        config.tools.bash.defaultTimeoutMs = DEFAULT_BUILTIN_CONFIG.tools.bash.defaultTimeoutMs;
        config.tools.bash.maxTimeoutMs = DEFAULT_BUILTIN_CONFIG.tools.bash.maxTimeoutMs;
      }
      const envAllow = bash['envAllow'];
      if (envAllow !== undefined) {
        if (!Array.isArray(envAllow) || envAllow.some((item) => typeof item !== 'string')) {
          warnings.push('tools.bash.envAllow must be a string array');
        } else {
          config.tools.bash.envAllow = envAllow as string[];
        }
      }
    }
    const spill = section(tools['spill'], 'tools.spill', warnings);
    if (spill) {
      warnUnknown(spill, ['retentionDays'], 'tools.spill', warnings);
      config.tools.spill.retentionDays = intField(
        spill['retentionDays'],
        'tools.spill.retentionDays',
        1,
        config.tools.spill.retentionDays,
        warnings,
      );
    }
    const grep = section(tools['grep'], 'tools.grep', warnings);
    if (grep) {
      warnUnknown(grep, ['maxResults', 'maxFileBytes', 'maxLineChars'], 'tools.grep', warnings);
      config.tools.grep.maxResults = intField(
        grep['maxResults'],
        'tools.grep.maxResults',
        1,
        config.tools.grep.maxResults,
        warnings,
      );
      config.tools.grep.maxFileBytes = intField(
        grep['maxFileBytes'],
        'tools.grep.maxFileBytes',
        1_024,
        config.tools.grep.maxFileBytes,
        warnings,
      );
      config.tools.grep.maxLineChars = intField(
        grep['maxLineChars'],
        'tools.grep.maxLineChars',
        20,
        config.tools.grep.maxLineChars,
        warnings,
      );
    }
    const glob = section(tools['glob'], 'tools.glob', warnings);
    if (glob) {
      warnUnknown(glob, ['maxResults'], 'tools.glob', warnings);
      config.tools.glob.maxResults = intField(
        glob['maxResults'],
        'tools.glob.maxResults',
        1,
        config.tools.glob.maxResults,
        warnings,
      );
    }
  }

  const skills = section(raw['skills'], 'skills', warnings);
  if (skills) {
    warnUnknown(skills, ['maxFileBytes', 'catalogDescriptionChars'], 'skills', warnings);
    config.skills.maxFileBytes = intField(
      skills['maxFileBytes'],
      'skills.maxFileBytes',
      1_024,
      config.skills.maxFileBytes,
      warnings,
    );
    config.skills.catalogDescriptionChars = intField(
      skills['catalogDescriptionChars'],
      'skills.catalogDescriptionChars',
      20,
      config.skills.catalogDescriptionChars,
      warnings,
    );
  }

  const agent = section(raw['agent'], 'agent', warnings);
  if (agent) {
    warnUnknown(agent, ['maxSteps', 'maxToolCalls'], 'agent', warnings);
    config.agent.maxSteps = intField(
      agent['maxSteps'],
      'agent.maxSteps',
      1,
      config.agent.maxSteps,
      warnings,
    );
    config.agent.maxToolCalls = intField(
      agent['maxToolCalls'],
      'agent.maxToolCalls',
      1,
      config.agent.maxToolCalls,
      warnings,
    );
  }

  return { config, warnings };
}

/** Log once at startup; the daemon reads this file only on boot. */
export function logBuiltinConfigWarnings(loaded: LoadedBuiltinConfig): void {
  for (const warning of loaded.warnings) log.warn(`builtin config: ${warning}`);
}

function cloneDefault(): BuiltinRuntimeConfig {
  return {
    ...DEFAULT_BUILTIN_CONFIG,
    context: { ...DEFAULT_BUILTIN_CONFIG.context },
    projectDocs: { ...DEFAULT_BUILTIN_CONFIG.projectDocs },
    tools: {
      ...DEFAULT_BUILTIN_CONFIG.tools,
      read: { ...DEFAULT_BUILTIN_CONFIG.tools.read },
      write: { ...DEFAULT_BUILTIN_CONFIG.tools.write },
      edit: { ...DEFAULT_BUILTIN_CONFIG.tools.edit },
      bash: {
        ...DEFAULT_BUILTIN_CONFIG.tools.bash,
        envAllow: [...DEFAULT_BUILTIN_CONFIG.tools.bash.envAllow],
      },
      spill: { ...DEFAULT_BUILTIN_CONFIG.tools.spill },
      grep: { ...DEFAULT_BUILTIN_CONFIG.tools.grep },
      glob: { ...DEFAULT_BUILTIN_CONFIG.tools.glob },
    },
    skills: { ...DEFAULT_BUILTIN_CONFIG.skills },
    agent: { ...DEFAULT_BUILTIN_CONFIG.agent },
  };
}

function section(
  value: unknown,
  label: string,
  warnings: string[],
): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    warnings.push(`${label} must be an object; using defaults`);
    return null;
  }
  return value;
}

function warnUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  warnings: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      warnings.push(`unknown key "${prefix ? `${prefix}.` : ''}${key}" ignored`);
    }
  }
}

function intField(
  value: unknown,
  label: string,
  minimum: number,
  fallback: number,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    warnings.push(`${label} must be an integer >= ${minimum}; using ${fallback}`);
    return fallback;
  }
  return value;
}

function ratioField(
  value: unknown,
  label: string,
  fallback: number,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    warnings.push(`${label} must be in (0, 1]; using ${fallback}`);
    return fallback;
  }
  return value;
}

function boolField(
  value: unknown,
  label: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    warnings.push(`${label} must be a boolean; using ${fallback}`);
    return fallback;
  }
  return value;
}

function enumField<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    warnings.push(`${label} must be one of ${allowed.join(', ')}; using ${fallback}`);
    return fallback;
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
