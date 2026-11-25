/**
 * Wire + storage shapes for cross-machine agent sharing (P3).
 *
 * v1 only implements `access='full'`: the peer's run sees whatever the exposed
 * agent sees locally. The `custom` fields are kept on the type so tightening
 * the contract later is a validation/UI change, not a protocol migration.
 */

export const PEER_PROTOCOL_VERSION = 1;

export type PeerAccess = 'full' | 'custom';

/** Who answers a write-class tool call. `relay` is the v1 default. */
export type PeerApprovalPolicy = 'relay' | 'local_prompt' | 'auto_deny';

export type PeerRoomHistory = 'none' | 'turn' | 'summary';

export interface ExposedAgentContract {
  agentId: string;
  /** Display name on the other machine; defaults to the local name. */
  publicName: string;
  /** One-line description shown in the peer's agent picker. */
  summary: string;

  access: PeerAccess;

  /**
   * Recommended working directories. In `full` this is a hint for prompts and
   * audits, **not** a read boundary; the `~/.paboot` deny is separate.
   */
  dirs: string[];
  approvalPolicy: PeerApprovalPolicy;
  maxConcurrentRuns: number;
  quota: {
    runsPerHour: number;
    maxInputTokensPerRun: number;
    maxWallClockMs: number;
  };
  /** Whether a peer-triggered run may write into this machine's memory. */
  capture: boolean;

  protocolVersion: number;
  /** Bumped on every edit; B uses it to notice a changed contract. */
  version: number;

  // ── custom mode only; retained but never honoured in v1 ──────────────
  tools?: string[];
  readOnly?: boolean;
  allowShell?: boolean;
  context?: {
    ends?: boolean;
    memory?: boolean;
    knowledge?: boolean;
    projectDocs?: boolean;
    environment?: 'minimal' | 'full';
    roomHistory?: PeerRoomHistory;
  };
  peers?: 'invite-only' | string[];
}

/** The subset of an agent a contract needs. Keeps peer/ free of the agents module. */
export interface ContractAgent {
  id: string;
  name: string;
  summary: string;
  /** `peer` agents cannot be re-exposed (no chaining). */
  kind?: string;
  /** `kind='runtime'` only; v1 shares builtin and Claude. */
  runtime?: string | null;
}

export interface ContractDefaults {
  quota?: Partial<ExposedAgentContract['quota']>;
  approvalPolicy?: PeerApprovalPolicy;
  maxConcurrentRuns?: number;
  dirs?: string[];
  capture?: boolean;
  publicName?: string;
  summary?: string;
}

export interface ExposedAgentDto {
  agentId: string;
  enabled: boolean;
  contract: ExposedAgentContract;
  hasTokens: boolean;
}

export interface CreatedInvite {
  id: string;
  /** Raw one-time token. Only the hash is stored. */
  token: string;
  agentIds: string[];
  expiresAt: number;
}

export interface GuestTokenInfo {
  tokenId: string;
  peerId: string;
  agentIds: string[];
}

/** What auth can resolve: an issued token, or a not-yet-redeemed invite. */
export interface GuestCredential extends GuestTokenInfo {
  inviteId?: string;
}

/** The first SSE frame of a peer run; tells B what it is attached to. */
export interface PeerMetaEvent {
  type: 'peer_meta';
  /** A-side run id. B stores it as `remote_run_id` for cancel/reconcile. */
  runId: string;
  threadKey: string;
  cwd: string;
  contractVersion: number;
  threadResumed: boolean;
  agent: { id: string; name: string };
}
