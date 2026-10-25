import { VERSION } from '../../version.js';
import { spawnStdioRpc, type StdioRpcConnection } from '../stdio-rpc.js';
import { asRecord } from './map.js';

/**
 * Transport for `dsh acp`: newline-delimited JSON-RPC over stdio (ACP v1).
 * The generic peer plumbing lives in `../stdio-rpc.ts`; this file owns the
 * DeepSeek launch command and the ACP handshake.
 */

export const ACP_PROTOCOL_VERSION = 1;

export interface DeepSeekAcpOptions {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Spawn `dsh acp` and wrap it in a connection. Does not handshake. */
export function spawnDeepSeekAcp(options: DeepSeekAcpOptions): StdioRpcConnection {
  return spawnStdioRpc({
    command: options.bin,
    args: ['acp'],
    cwd: options.cwd,
    env: options.env,
    label: 'dsh acp',
  });
}

/**
 * The mandatory ACP handshake. A protocol-version mismatch is fatal: the
 * response is the version the agent will speak, and continuing would only
 * produce confusing method errors later.
 */
export async function initializeDeepSeekAcp(connection: StdioRpcConnection): Promise<void> {
  const result = await connection.request(
    'initialize',
    {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'paboot', version: VERSION },
      clientCapabilities: {},
    },
    30_000,
  );
  const negotiated = asRecord(result)?.['protocolVersion'];
  if (typeof negotiated === 'number' && negotiated !== ACP_PROTOCOL_VERSION) {
    throw new Error(`dsh acp speaks ACP v${negotiated}; paboot supports v${ACP_PROTOCOL_VERSION}`);
  }
}
