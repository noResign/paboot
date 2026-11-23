import { describe, expect, it } from 'vitest';
import {
  finishNotification,
  permissionNotification,
  permissionNotificationId,
  questionNotification,
  questionNotificationId,
  runNotificationId,
  summarizeTool,
} from './notifications';
import type { PendingPermission } from '../store/chat/types';

function permission(over: Partial<PendingPermission> = {}): PendingPermission {
  return {
    permissionId: 'p1',
    runId: 'r1',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf build\nnpm run build' },
    status: 'pending',
    ...over,
  };
}

describe('notification identity', () => {
  it('keys by permission, not by session', () => {
    // Two concurrent approvals in one session must not overwrite each other.
    expect(permissionNotificationId('a')).not.toBe(permissionNotificationId('b'));
    expect(runNotificationId('r1')).not.toBe(permissionNotificationId('r1'));
  });
});

describe('summarizeTool', () => {
  it('shows the first line of a command', () => {
    expect(summarizeTool(permission())).toBe('Bash: rm -rf build');
  });

  it('falls back to the file path, then to the tool name', () => {
    expect(summarizeTool(permission({ toolName: 'Write', toolInput: { file_path: '/a/b.ts' } }))).toBe('Write: /a/b.ts');
    expect(summarizeTool(permission({ toolName: 'MultiEdit', toolInput: {} }))).toBe('MultiEdit');
  });

  it('names a question prompt for what it is', () => {
    expect(summarizeTool(permission({ toolName: 'UserInput', toolInput: { kind: 'questions' } }))).toBe(
      'Agent 需要你的回答',
    );
  });
});

describe('finishNotification', () => {
  const session = { id: 's1', title: '重构下载器' };

  it('stays silent without a run id', () => {
    expect(finishNotification('finished', null, session, null)).toBeNull();
  });

  it('reports success, settle and failure distinctly', () => {
    expect(finishNotification('finished', 'r1', session, null)).toMatchObject({ title: '任务完成' });
    expect(finishNotification('settled', 'r1', session, null)).toMatchObject({ title: '任务已结束' });
    expect(finishNotification('giveup', 'r1', session, '连接已断开')).toMatchObject({
      title: '任务中断',
      body: '重构下载器 · 连接已断开',
    });
  });

  it('carries the session so a click can open it', () => {
    expect(finishNotification('finished', 'r1', session, null)?.sessionId).toBe('s1');
    expect(permissionNotification(permission(), session).sessionId).toBe('s1');
  });
});

describe('questionNotification', () => {
  const session = { id: 's1', title: '群聊' };

  it('says how many questions and quotes the first one', () => {
    const payload = questionNotification(
      'p9',
      [{ header: '部署目标', question: '部署到哪台机器？' }, { question: '什么时候？' }],
      session,
    );
    expect(payload.id).toBe('question:p9');
    expect(payload.title).toContain('2');
    expect(payload.body).toContain('部署目标');
    expect(payload.body).toContain('群聊');
    expect(payload.sessionId).toBe('s1');
  });

  it('keys the notice by permission id, so answering can retract it', () => {
    // A session-scoped id would let a finishing run overwrite the question.
    expect(questionNotificationId('p9')).toBe('question:p9');
    expect(questionNotificationId('p9')).not.toBe(permissionNotificationId('p9'));
  });

  it('falls back to a neutral line when the question has no text', () => {
    expect(questionNotification('p10', [], session).body).toContain('需要你的回答');
  });
});
