import path from 'node:path';
import { expandHome } from '../platform/paths.js';
import { workspaceContains } from '../workspaces/workspace-service.js';
import {
  PEER_PROTOCOL_VERSION,
  type ContractAgent,
  type ExposedAgentContract,
  type PeerApprovalPolicy,
} from './types.js';

export class PeerValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'PeerValidationError';
  }
}

export const DEFAULT_QUOTA = {
  runsPerHour: 20,
  maxInputTokensPerRun: 20_000,
  maxWallClockMs: 600_000,
} as const;

const MAX_PUBLIC_NAME = 80;
const MAX_SUMMARY = 200;
const MAX_RUNS_PER_HOUR = 10_000;
const MAX_INPUT_TOKENS = 2_000_000;
const MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_RUNS = 8;

const APPROVAL_POLICIES: readonly PeerApprovalPolicy[] = ['relay', 'local_prompt', 'auto_deny'];

/**
 * v1 only shares backends whose read path the daemon can hard-restrict.
 *
 * builtin has a path policy; Claude's peer runs add Read/Grep/Glob to the hook
 * so `~/.paboot` is denied. Codex / DeepSeek reads are outside our tool layer,
 * so exposing them would make the data-dir promise untrue.
 */
export function isShareableBackend(kind: string | undefined, runtime: string | null | undefined): boolean {
  if (kind === 'builtin') return true;
  if (kind === 'runtime') return runtime === 'claude';
  return false;
}

/**
 * Build or update the exposed-agent contract.
 *
 * v1 only supports `access='full'`; `custom` is rejected with a 400 instead of
 * being silently treated as full (a caller must know tightening is not here yet).
 */
export function buildContract(input: {
  agent: ContractAgent;
  workspacePath: string;
  previous?: ExposedAgentContract;
  patch?: Record<string, unknown>;
}): ExposedAgentContract {
  const patch = input.patch ?? {};
  const prev = input.previous;

  const requestedAccess = patch['access'] ?? prev?.access ?? 'full';
  if (requestedAccess === 'custom') {
    throw new PeerValidationError(
      'custom contracts are not supported in v1; only access=full is available',
      'custom_not_supported',
    );
  }
  if (requestedAccess !== 'full') {
    throw new PeerValidationError('access must be "full"', 'invalid_access');
  }

  const publicName = readString(patch['publicName'], prev?.publicName ?? input.agent.name, MAX_PUBLIC_NAME, 'publicName');
  const summary = readString(patch['summary'], prev?.summary ?? input.agent.summary, MAX_SUMMARY, 'summary');
  const approvalPolicy = readApprovalPolicy(patch['approvalPolicy'], prev?.approvalPolicy ?? 'relay');
  const maxConcurrentRuns = readInt(
    patch['maxConcurrentRuns'],
    prev?.maxConcurrentRuns ?? 1,
    1,
    MAX_CONCURRENT_RUNS,
    'maxConcurrentRuns',
  );
  const quota = {
    runsPerHour: readInt(
      quotaPatch(patch, 'runsPerHour'),
      prev?.quota.runsPerHour ?? DEFAULT_QUOTA.runsPerHour,
      1,
      MAX_RUNS_PER_HOUR,
      'quota.runsPerHour',
    ),
    maxInputTokensPerRun: readInt(
      quotaPatch(patch, 'maxInputTokensPerRun'),
      prev?.quota.maxInputTokensPerRun ?? DEFAULT_QUOTA.maxInputTokensPerRun,
      1_000,
      MAX_INPUT_TOKENS,
      'quota.maxInputTokensPerRun',
    ),
    maxWallClockMs: readInt(
      quotaPatch(patch, 'maxWallClockMs'),
      prev?.quota.maxWallClockMs ?? DEFAULT_QUOTA.maxWallClockMs,
      1_000,
      MAX_WALL_CLOCK_MS,
      'quota.maxWallClockMs',
    ),
  };

  const dirs = readDirs(patch['dirs'], prev?.dirs ?? [], input.workspacePath);
  const capture = readBoolean(patch['capture'], prev?.capture ?? false);
  if (capture) {
    // Keep the field for a future contract mode, but do not accept a switch
    // that the run path silently ignores.
    throw new PeerValidationError('capture is not available in v1', 'capture_not_supported');
  }

  return {
    agentId: input.agent.id,
    publicName,
    summary,
    access: 'full',
    dirs,
    approvalPolicy,
    maxConcurrentRuns,
    quota,
    capture,
    protocolVersion: PEER_PROTOCOL_VERSION,
    // `previous` is always a full stored contract, so this is a real bump.
    version: (prev?.version ?? 0) + 1,
  };
}

/** Parse a stored contract. Tolerates missing optional fields from older rows. */
export function parseStoredContract(raw: string): ExposedAgentContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PeerValidationError('stored contract is not valid JSON', 'contract_invalid', 500);
  }
  if (!isRecord(parsed) || typeof parsed['agentId'] !== 'string') {
    throw new PeerValidationError('stored contract is missing agentId', 'contract_invalid', 500);
  }
  if (parsed['access'] !== 'full' && parsed['access'] !== 'custom') {
    throw new PeerValidationError('stored contract has an invalid access mode', 'contract_invalid', 500);
  }
  const quota = isRecord(parsed['quota']) ? parsed['quota'] : {};
  const approval = parsed['approvalPolicy'];
  return {
    agentId: parsed['agentId'],
    publicName: typeof parsed['publicName'] === 'string' ? parsed['publicName'] : parsed['agentId'],
    summary: typeof parsed['summary'] === 'string' ? parsed['summary'] : '',
    access: parsed['access'],
    dirs: Array.isArray(parsed['dirs']) ? parsed['dirs'].filter((v): v is string => typeof v === 'string') : [],
    approvalPolicy: APPROVAL_POLICIES.includes(approval as PeerApprovalPolicy)
      ? (approval as PeerApprovalPolicy)
      : 'relay',
    maxConcurrentRuns: positiveInt(parsed['maxConcurrentRuns'], 1),
    quota: {
      runsPerHour: positiveInt(quota['runsPerHour'], DEFAULT_QUOTA.runsPerHour),
      maxInputTokensPerRun: positiveInt(quota['maxInputTokensPerRun'], DEFAULT_QUOTA.maxInputTokensPerRun),
      maxWallClockMs: positiveInt(quota['maxWallClockMs'], DEFAULT_QUOTA.maxWallClockMs),
    },
    capture: parsed['capture'] === true,
    protocolVersion: positiveInt(parsed['protocolVersion'], PEER_PROTOCOL_VERSION),
    version: positiveInt(parsed['version'], 1),
    ...(Array.isArray(parsed['tools'])
      ? { tools: parsed['tools'].filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof parsed['readOnly'] === 'boolean' ? { readOnly: parsed['readOnly'] } : {}),
    ...(typeof parsed['allowShell'] === 'boolean' ? { allowShell: parsed['allowShell'] } : {}),
    ...(isRecord(parsed['context']) ? { context: parsed['context'] as ExposedAgentContract['context'] } : {}),
    ...(parsed['peers'] === 'invite-only' || Array.isArray(parsed['peers'])
      ? { peers: parsed['peers'] as ExposedAgentContract['peers'] }
      : {}),
  };
}

function readString(value: unknown, fallback: string, max: number, field: string): string {
  const text = value === undefined ? fallback : value;
  if (typeof text !== 'string') throw new PeerValidationError(`${field} must be a string`, 'invalid_contract');
  const trimmed = text.trim();
  if (trimmed.length > max) {
    throw new PeerValidationError(`${field} must be at most ${max} characters`, 'invalid_contract');
  }
  return trimmed;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new PeerValidationError('capture must be a boolean', 'invalid_contract');
  return value;
}

function readApprovalPolicy(value: unknown, fallback: PeerApprovalPolicy): PeerApprovalPolicy {
  if (value === undefined) return fallback;
  if (!APPROVAL_POLICIES.includes(value as PeerApprovalPolicy)) {
    throw new PeerValidationError(
      'approvalPolicy must be relay | local_prompt | auto_deny',
      'invalid_contract',
    );
  }
  // v1 has no "ask the exposing user" path: writing local_prompt would behave
  // exactly like relay (the visitor answers), which is the wrong promise.
  if (value === 'local_prompt') {
    throw new PeerValidationError(
      'local_prompt is not available in v1; use relay or auto_deny',
      'approval_policy_not_supported',
    );
  }
  return value as PeerApprovalPolicy;
}

function readInt(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PeerValidationError(`${field} must be an integer between ${min} and ${max}`, 'invalid_contract');
  }
  return value;
}

function quotaPatch(patch: Record<string, unknown>, key: string): unknown {
  const quota = patch['quota'];
  return isRecord(quota) ? quota[key] : undefined;
}

function readDirs(value: unknown, fallback: string[], workspacePath: string): string[] {
  const raw = value === undefined ? fallback : value;
  if (!Array.isArray(raw)) throw new PeerValidationError('dirs must be an array', 'invalid_contract');
  const resolved: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new PeerValidationError('each dir must be a non-empty string', 'invalid_contract');
    }
    const expanded = expandHome(entry.trim());
    const absolute = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(workspacePath, expanded);
    if (!workspaceContains(workspacePath, absolute)) {
      throw new PeerValidationError(`dir is outside the workspace: ${entry}`, 'invalid_dir');
    }
    if (!resolved.includes(absolute)) resolved.push(absolute);
  }
  return resolved;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
