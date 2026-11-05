import type { PermissionStatus } from '../../../types/api.js';
import { grantKeyCandidates } from '../../../permissions/tool-grants.js';
import type { PermissionBroker, ToolPermissionDecision, ToolPermissionRequest } from '../types.js';

export interface PermissionBrokerBackend {
  create(
    runId: string,
    sessionId: string,
    toolName: string,
    toolInput: unknown,
  ): { id: string; announced: boolean; toolName: string; toolInput: unknown; status: PermissionStatus };
  wait(id: string): Promise<{ status: PermissionStatus }>;
}

export interface PermissionBrokerNotifier {
  emit(
    runId: string,
    event: {
      type: 'permission_request';
      permissionId: string;
      toolName: string;
      toolInput: unknown;
      status: PermissionStatus;
    },
  ): boolean;
}

export interface PermissionBrokerGrants {
  hasPermissionGrant(sessionId: string, toolName: string): boolean;
}

/**
 * Adapt PermissionManager / RunNotifier / session grants to the builtin kernel.
 * Existing "allow all" grants are checked before creating a new ask; an
 * unannounced request still waits, so a disconnected client cannot silently
 * approve anything.
 */
export function createPermissionBroker(input: {
  permissions: PermissionBrokerBackend;
  notifier: PermissionBrokerNotifier;
  grants: PermissionBrokerGrants;
}): PermissionBroker {
  return {
    async request(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
      if (!request.sessionId) {
        return { status: 'denied', reason: 'no session for approval' };
      }
      if (grantKeyCandidates(request.toolName).some((key) => input.grants.hasPermissionGrant(request.sessionId!, key))) {
        return { status: 'allowed', reason: 'session grant' };
      }
      const pending = input.permissions.create(
        request.runId,
        request.sessionId,
        request.toolName,
        request.toolInput,
      );
      pending.announced = input.notifier.emit(request.runId, {
        type: 'permission_request',
        permissionId: pending.id,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
        status: pending.status,
      });
      const decided = await input.permissions.wait(pending.id);
      const status =
        decided.status === 'allowed' || decided.status === 'timed_out'
          ? decided.status
          : 'denied';
      return {
        status,
        reason: status === 'allowed' ? null : 'permission not granted',
      };
    },
  };
}
