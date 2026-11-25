/**
 * `peer/` — cross-machine agent sharing.
 *
 * Everything outside this folder imports *this file only*. The internal split
 * (contract / store / token / service) is free to change. The module owns the
 * A-side authorization model; it must not import `routes/`, and `agents/` must
 * never import it (agents describe who runs, peer decides who may reach them).
 */
export {
  buildContract,
  DEFAULT_QUOTA,
  isShareableBackend,
  parseStoredContract,
  PeerValidationError,
} from './contract.js';

export {
  createInvite,
  exposeAgent,
  findGuestCredential,
  findGuestToken,
  getExposure,
  listExposures,
  redeemInvite,
  removeExposure,
  revokeAgentAccess,
  setExposureEnabled,
} from './service.js';

export { generatePeerToken, hashPeerToken, peerTokenId } from './token.js';

export {
  evaluatePeerTool,
  PEER_READ_TOOLS,
  toolTouchesDataDir,
  type PeerToolDecision,
  type PeerToolPolicyInput,
  type PeerToolPolicyResult,
} from './tool-policy.js';

export {
  cancelPeerRun,
  openPeerRun,
  parseInvite,
  probePeer,
  readPeerFrames,
  redeemPeer,
  relayPermissionDecision,
} from './client.js';
export { joinPeer, listPeerConnections, probeConnection, removePeerConnection } from './join.js';
export {
  startPeerTaskRun,
  type PeerTaskRunHandle,
  type PeerTaskRunInput,
} from './backend.js';
export { reconcilePeerRuns } from './reconcile.js';

export {
  assertPeerInputBudget,
  PEER_BOUNDARY_PROMPT,
  resetPeerQuotaForTests,
  startPeerRun,
  type PeerRunHandle,
  type PeerRunRequest,
} from './runs.js';

export type {
  ContractAgent,
  ContractDefaults,
  CreatedInvite,
  ExposedAgentContract,
  ExposedAgentDto,
  GuestCredential,
  GuestTokenInfo,
  PeerMetaEvent,
  PeerAccess,
  PeerApprovalPolicy,
  PeerRoomHistory,
} from './types.js';

export { PEER_PROTOCOL_VERSION } from './types.js';
