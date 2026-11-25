import fs from 'node:fs';
import path from 'node:path';
import type { PeerApprovalPolicy } from './types.js';

/**
 * One decision surface for every peer tool call, shared by the Claude/MCP
 * permission route and the builtin permission broker. Keeping it here means a
 * contract change (pause, auto_deny, data-dir deny) cannot apply to one backend
 * and silently miss the other.
 */
export type PeerToolDecision = 'allow' | 'deny' | 'ask';

/** Tools whose peer-run reads are auto-allowed after the data-dir check. */
export const PEER_READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
]);

export interface PeerToolPolicyInput {
  /** Live exposure state; a paused share denies everything. */
  enabled: boolean;
  approvalPolicy: PeerApprovalPolicy;
  dataDir: string;
  toolName: string;
  toolInput: unknown;
}

export interface PeerToolPolicyResult {
  decision: PeerToolDecision;
  reason: string;
}

export function evaluatePeerTool(input: PeerToolPolicyInput): PeerToolPolicyResult {
  if (!input.enabled) return { decision: 'deny', reason: 'peer sharing is paused' };
  if (toolTouchesDataDir(input.dataDir, input.toolInput)) {
    return { decision: 'deny', reason: 'peer run may not touch the daemon data dir' };
  }
  // Reads stay ungated for local runs; a peer run only adds the data-dir check
  // above, not a per-read approval round-trip.
  if (PEER_READ_TOOLS.has(input.toolName)) return { decision: 'allow', reason: 'peer read' };
  if (input.approvalPolicy === 'auto_deny') {
    return { decision: 'deny', reason: 'peer contract uses auto_deny' };
  }
  return { decision: 'ask', reason: '' };
}

/**
 * Best-effort check: shells make absolute sandboxing impossible at this layer.
 * It is a heuristic, not a boundary — see the trust model in the protocol doc.
 */
export function toolTouchesDataDir(dataDir: string, input: unknown): boolean {
  if (!dataDir) return false;
  if (typeof input !== 'object' || input === null) return false;
  const root = realOrSelf(dataDir);
  const record = input as Record<string, unknown>;
  const raw = [record['file_path'], record['path'], record['notebook_path'], record['command']].filter(
    (v): v is string => typeof v === 'string',
  );
  for (const value of raw) {
    const text = value.trim();
    if (!text) continue;
    if (text.includes(dataDir) || text.includes('~/.paboot') || text.includes('$HOME/.paboot')) {
      return true;
    }
    const absolute = path.resolve(text);
    if (isInside(root, absolute) || isInside(root, realOrSelf(absolute))) return true;
  }
  return false;
}

function realOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
