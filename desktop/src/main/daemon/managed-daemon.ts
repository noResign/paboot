import { resolveBundledEntry } from './bundled-entry';
import { ensureManagedToken } from './managed-token';
import { resolveDaemonCommand, type DaemonSupervisor, type StartResult } from './supervisor';

/**
 * The one call the UI needs to start a daemon we own: token, command resolution,
 * spawn, readiness — in that order, and every step returning a code the UI can
 * explain instead of throwing.
 *
 * Kept apart from the supervisor so the *decision* logic ("is there anything to
 * run?", "can we get a token?") is testable without spawning anything.
 */
export interface StartManagedInput {
  dataDir: string;
  /** The agent's writable root. Comes from a directory picker — never guessed (§2). */
  workspace: string;
  port: number;
  host?: string;
  /** `userSetting.daemonCommand`, the documented escape hatch. */
  userCommand?: { command: string; args?: string[] } | null;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  execPath: string;
}

export type ManagedStart =
  | { ok: true; pid: number; listen: string | null; token: string }
  | { ok: false; code: string; message: string };

export async function startManagedDaemon(
  supervisor: DaemonSupervisor,
  input: StartManagedInput,
): Promise<ManagedStart> {
  // The token first: without one the daemon would come up unreachable, and that
  // is a worse failure than not starting it at all.
  const token = ensureManagedToken(input.dataDir);
  if (!token) {
    return { ok: false, code: 'no_token', message: `无法在 ${input.dataDir} 创建 token 文件` };
  }

  const bundledEntry = resolveBundledEntry({
    isPackaged: input.isPackaged,
    appPath: input.appPath,
    resourcesPath: input.resourcesPath,
  });
  const command = resolveDaemonCommand({
    userCommand: input.userCommand ?? null,
    bundledEntry,
    execPath: input.execPath,
    isPackaged: input.isPackaged,
  });
  if (!command) {
    return {
      ok: false,
      code: 'no_daemon',
      message: '这个安装里没有可启动的 daemon（也没有配置自定义命令）',
    };
  }

  const started: StartResult = await supervisor.start(command, {
    workspace: input.workspace,
    port: input.port,
    host: input.host,
  });
  if (!started.ok) return started;

  return { ok: true, pid: started.pid, listen: started.listen, token };
}
