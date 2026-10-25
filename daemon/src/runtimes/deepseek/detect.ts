import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeCapabilities, RuntimeDetection } from '../types.js';

const execFileP = promisify(execFile);

/** The npm-installed CLI, found through the daemon's PATH like `claude`/`codex`. */
export const DEEPSEEK_BIN = 'dsh';

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

async function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, { env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
      code: typeof e.code === 'number' ? e.code : null,
    };
  }
}

function parseVersion(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  return m ? m[1] : null;
}

/**
 * `RuntimeCapabilities` describes the Claude argv contract (which flags the
 * adapter may pass). DSH is an RPC peer — its knobs are ACP calls — so every
 * flag is false. Read it as "none of these apply", not "unsupported".
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
};

/** DSH's user-data root (`$DSH_HOME` or `~/.dsh`), where credentials live. */
function dshHome(env: NodeJS.ProcessEnv): string {
  const configured = env['DSH_HOME']?.trim();
  if (!configured) return join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2));
  return configured;
}

/**
 * Auth is "did the user give the default route a key", either through the
 * ambient environment or DSH's credential store (written by the web UI).
 * A missing key is reported as unknown rather than false: DSH can also be
 * configured with third-party providers or an account route.
 */
function detectAuth(env: NodeJS.ProcessEnv): boolean | null {
  if (env['DEEPSEEK_API_KEY']?.trim()) return true;
  try {
    const path = join(dshHome(env), '.credentials.yaml');
    if (existsSync(path) && /\bDEEPSEEK_API_KEY\s*:/.test(readFileSync(path, 'utf8'))) return true;
  } catch {
    // An unreadable credential store is not evidence either way.
  }
  return null;
}

/**
 * Probe the `dsh` CLI. Only `--version` decides availability — it is handled
 * by the launcher before any profile boot, so detection never initializes
 * `~/.dsh/profiles/acp` or installs plugins.
 */
export async function detectDeepSeek(bin: string, env: NodeJS.ProcessEnv): Promise<RuntimeDetection> {
  const base = { id: 'deepseek', name: 'DeepSeek Harness', bin };

  const versionRes = await run(bin, ['--version'], env);
  if (!versionRes.ok) {
    return {
      ...base,
      available: false,
      version: null,
      authed: null,
      capabilities: NO_CAPABILITIES,
      models: [],
      error:
        versionRes.stderr.trim() ||
        `dsh not found (${bin}); install with \`npm install -g @deepseek-ai/dsh\` (Node >= 24.9)`,
    };
  }

  return {
    ...base,
    available: true,
    version: parseVersion(versionRes.stdout),
    authed: detectAuth(env),
    capabilities: NO_CAPABILITIES,
    // The catalogue is static for the shipped route; Registry caches it.
    models: [],
    error: null,
  };
}
