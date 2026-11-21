import { isReadOnlyBash } from '../../../permissions/command-safety.js';
import type { AgentRunContext, ToolDescriptor } from '../types.js';
import { isRecord } from './file-utils.js';

export type ToolApprovalDecision = 'allow' | 'ask' | 'deny';

export interface ToolApprovalInput {
  descriptor: ToolDescriptor;
  input: unknown;
  agent: AgentRunContext;
}

export interface ToolApprovalPolicy {
  decide(input: ToolApprovalInput): ToolApprovalDecision;
}

/**
 * Product approval matrix. Read-only/control tools run directly; mutations
 * ask (or auto-allow under acceptEdits); bypass never asks. PathPolicy remains
 * a separate boundary and is not relaxed here except through its own mode.
 */
export const defaultToolApprovalPolicy: ToolApprovalPolicy = {
  decide({ descriptor, input, agent }) {
    // Read-only wins over every mode, including bypass: the point of a
    // read-only member is that no approval can turn it into a writer. Read,
    // control and network (search/fetch) stay available; write and execute are
    // gone, and MCP is unknown so it fails closed.
    if (agent.readOnly) {
      return descriptor.sideEffect === 'read' ||
        descriptor.sideEffect === 'control' ||
        descriptor.sideEffect === 'network'
        ? 'allow'
        : 'deny';
    }
    if (agent.permissionMode === 'bypass') return 'allow';
    // Read-only shell commands are the Bash analogue of Read/Grep.
    if (descriptor.name === 'Bash' && isRecord(input)) {
      const command = input['command'];
      if (typeof command === 'string' && isReadOnlyBash(command)) return 'allow';
    }
    if (descriptor.sideEffect === 'read' || descriptor.sideEffect === 'control') return 'allow';
    if (agent.permissionMode === 'acceptEdits' && descriptor.sideEffect === 'write') return 'allow';
    return 'ask';
  },
};
