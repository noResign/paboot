import { runExecutable, type CommandResult } from '../../platform/executable.js';
import type { RuntimeCapabilities, RuntimeDetection } from '../types.js';

function run(bin: string, args: string[], timeoutMs = 15000): Promise<CommandResult> {
  return runExecutable(bin, args, { timeoutMs });
}

function parseVersion(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  return m ? m[1] : null;
}

/**
 * `RuntimeCapabilities` describes the Claude argv contract (which flags the
 * adapter may pass). Codex has no argv contract — its knobs are RPC params — so
 * every flag is false. Read it as "none of these apply", not "unsupported".
 */
const NO_CAPABILITIES: RuntimeCapabilities = {
  partialMessages: false,
  inputStreamJson: false,
  resume: false,
  sessionId: false,
  addDir: false,
  permissionHook: false,
  effort: false,
  mcpConfig: false,
  // Codex app-server accepts `developerInstructions` on thread start/resume.
  nativeSystemPrompt: true,
};

/**
 * Probe the `codex` CLI. Only `--version` decides availability; a failed auth
 * probe is reported as unknown rather than unavailable, because Codex is usable
 * with either a ChatGPT login or an API key and only the user can tell.
 */
export async function detectCodex(bin: string, env: NodeJS.ProcessEnv): Promise<RuntimeDetection> {
  const base = { id: 'codex', name: 'Codex', bin };

  const versionRes = await run(bin, ['--version'], 15000);
  if (!versionRes.ok) {
    return {
      ...base,
      available: false,
      version: null,
      authed: null,
      capabilities: NO_CAPABILITIES,
      models: [],
      error: versionRes.stderr.trim() || versionRes.error || `codex not found (${versionRes.code})`,
    };
  }

  const authRes = await run(bin, ['login', 'status'], 8000);
  const authed = authRes.ok
    ? !/not (?:logged|signed|authenticated) in/i.test(`${authRes.stdout}\n${authRes.stderr}`)
    : null;

  return {
    ...base,
    available: true,
    version: parseVersion(versionRes.stdout),
    authed,
    capabilities: NO_CAPABILITIES,
    // The real catalogue needs a short-lived app-server; Registry lists it
    // lazily through the detector's `listModels`, not during detection.
    models: [],
    error: null,
  };
}
