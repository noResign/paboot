import type { AgentRunContext, ToolDescriptor } from '../types.js';

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
  decide({ descriptor, agent }) {
    if (agent.permissionMode === 'bypass') return 'allow';
    if (descriptor.sideEffect === 'read' || descriptor.sideEffect === 'control') return 'allow';
    if (agent.permissionMode === 'acceptEdits' && descriptor.sideEffect === 'write') return 'allow';
    return 'ask';
  },
};
