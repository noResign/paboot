import { runExecutable, type CommandResult } from '../../platform/executable.js';
import type { RuntimeCapabilities, RuntimeDetection } from '../types.js';
import { CLAUDE_MODELS } from './models.js';

function run(bin: string, args: string[], timeoutMs = 15000): Promise<CommandResult> {
  return runExecutable(bin, args, { timeoutMs });
}

function parseVersion(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  return m ? m[1] : null;
}

function probeCapabilities(help: string): RuntimeCapabilities {
  return {
    partialMessages: help.includes('--include-partial-messages'),
    inputStreamJson: help.includes('--input-format'),
    resume: help.includes('--resume'),
    sessionId: help.includes('--session-id'),
    addDir: help.includes('--add-dir'),
    permissionHook: help.includes('--settings'),
    effort: help.includes('--effort'),
    mcpConfig: help.includes('--mcp-config'),
    nativeSystemPrompt: help.includes('--append-system-prompt'),
    // No dedicated flag exists; the stream-json user frame carries image blocks.
    imageInput: help.includes('--input-format'),
  };
}

const FALLBACK_CAPS: RuntimeCapabilities = {
  partialMessages: false,
  inputStreamJson: true,
  resume: true,
  sessionId: true,
  addDir: false,
  permissionHook: false,
  effort: false,
  mcpConfig: false,
  nativeSystemPrompt: false,
  imageInput: true,
};

/**
 * Probe the `claude` CLI: version, auth status, and the capability flags the
 * adapter is allowed to pass. Flag probing is done against the actual `--help`
 * output so an older or forked build never receives an unknown option (the
 * reference project gates `--include-partial-messages` the same way).
 */
export async function detectClaude(bin: string, env: NodeJS.ProcessEnv): Promise<RuntimeDetection> {
  const base = { id: 'claude', name: 'Claude Code', bin };

  const versionRes = await run(bin, ['--version']);
  if (!versionRes.ok) {
    return {
      ...base,
      available: false,
      version: null,
      authed: null,
      capabilities: FALLBACK_CAPS,
      models: [],
      error: versionRes.stderr.trim() || versionRes.error || `claude not found (${versionRes.code})`,
    };
  }
  const version = parseVersion(versionRes.stdout);

  const [authRes, helpRes] = await Promise.all([
    run(bin, ['auth', 'status'], 8000),
    run(bin, ['-p', '--help'], 15000),
  ]);

  const authed = authRes.ok
    ? !/not (?:logged|signed|authenticated) in/i.test(`${authRes.stdout}\n${authRes.stderr}`)
    : null;
  const capabilities = helpRes.ok ? probeCapabilities(helpRes.stdout) : FALLBACK_CAPS;
  // Only advertise the effort knob when this build actually accepts the flag.
  const models = capabilities.effort
    ? CLAUDE_MODELS
    : CLAUDE_MODELS.map((option) => ({ id: option.id, label: option.label }));

  return { ...base, available: true, version, authed, capabilities, models, error: null };
}
