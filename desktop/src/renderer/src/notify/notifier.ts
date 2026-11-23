import {
  finishNotification,
  permissionNotification,
  permissionNotificationId,
  questionNotification,
  questionNotificationId,
  type FinishedOutcome,
} from './notifications';
import type { PendingPermission } from '../store/chat/types';

/**
 * Thin side-effecting wrapper over `notifications.ts`. The store calls these;
 * the pure builders stay testable.
 */
interface SessionRef {
  id: string | null;
  title: string | null;
}

/**
 * Whether to bother the user is decided in the main process, which is the only
 * place that can see every window (`shared/notifyDecision.ts`). The renderer
 * just reports; main drops what would be redundant.
 */
export function notifyPermission(permission: PendingPermission, session: SessionRef): void {
  void window.paboot.notify(permissionNotification(permission, session));
}

/**
 * Retract a decided approval's notification. Without this the notification
 * centre keeps requests that no longer exist — and on a busy session they pile
 * up faster than anyone clears them.
 */
export function closePermissionNotification(permissionId: string): void {
  void window.paboot.notifyClose(permissionNotificationId(permissionId));
}

export function notifyRunFinished(
  outcome: FinishedOutcome,
  runId: string | null,
  session: SessionRef,
  error: string | null,
): void {
  const payload = finishNotification(outcome, runId, session, error);
  if (payload) void window.paboot.notify(payload);
}

/**
 * Announce a blocking question. Main drops it when this session is already on
 * screen (`shouldNotify`), so it only reaches a user who is looking elsewhere.
 */
export function notifyQuestion(
  permissionId: string,
  questions: readonly { header?: string; question: string }[],
  session: SessionRef,
): void {
  void window.paboot.notify(questionNotification(permissionId, questions, session));
}

export function closeQuestionNotification(permissionId: string): void {
  void window.paboot.notifyClose(questionNotificationId(permissionId));
}
