/**
 * daemon error → displayable Chinese copy. Ported from `app/.../util/ApiErrors.kt`;
 * one table, shared by every surface, so the chat page and the permission dialog
 * never disagree about what a code means.
 *
 * The SSE failure path has no response object, only `(apiCode, httpCode, message)`,
 * which is why the table is keyed on those raw fields.
 *
 * `httpCode`: -1 = unreachable, -2 = other transport error, 0 = our own synthetic
 * "no response" (see main/daemon/client.ts).
 */
export function friendlyMessage(
  apiCode: string | null | undefined,
  httpCode: number | null | undefined,
  message: string,
  fallbackPrefix = '请求失败',
): string {
  switch (apiCode) {
    // workspaces
    case 'workspace_exists':
      return '该目录已经是工作区了';
    case 'workspace_not_empty':
      return '该工作区还有会话，请勾选「同时删除会话」后再删';
    case 'workspace_is_default':
      return '最后一个工作区不能删除，请先添加另一个工作区';
    case 'workspace_is_builtin':
      return '这是内置的默认工作区，不能删除或停用';
    case 'workspace_disabled':
      return '该工作区已停用';
    case 'directory_not_found':
      return '目录不存在或已被删除';
    case 'not_a_directory':
      return '所选路径不是文件夹';
    case 'directory_not_accessible':
      return '目录无法访问（权限不足）';
    case 'shortcut_exists':
      return '该目录已经在 tab 上了';
    case 'dir_exists':
      return '该目录已在本工作区的附加目录里';
    case 'primary_dir':
      return '该目录已经是工作区主目录了';

    // files & diff (codes are the daemon's `FileBrowserError` set)
    case 'directory_not_readable':
      return '目录读不了（权限不足）';
    case 'not_a_file':
      return '所选路径不是文件';
    case 'file_not_found':
      return '文件不存在或已被删除';
    case 'read_failed':
      return '读取失败，请重试';
    case 'path_outside_workspace':
      return '路径不在工作区内';

    // sessions & runtimes
    case 'runtime_unavailable':
      return '该 Agent 未安装或不在 PATH 上，请在电脑端确认';
    case 'unknown_runtime':
      return '未知的 Agent 类型';
    case 'runtime_mismatch':
      return '该会话属于另一个 Agent，不能换 Agent 继续';
    case 'session_not_found':
      return '会话不存在或已被删除';
    case 'workspace_not_found':
      return '工作区不存在或已被删除';
    case 'cwd_not_allowed':
      return '会话目录不在当前工作区内';
    case 'claude_session_not_found':
      return '找不到该 Claude 本机会话';
    case 'prompt_required':
      return '请输入内容';
    case 'internal_error':
      return 'daemon 内部错误，请查看 daemon 日志';
    case 'session_busy':
      return '该会话正在运行，请稍后再发';

    // permissions
    case 'bad_response':
      return `回答不符合要求：${message}`;
    case 'permission_resolved':
      return '该请求已经处理过了';
    case 'permission_not_found':
      return '该请求已失效，可能已超时或运行已结束';
    case 'bad_decision':
      return '无效的审批决定';

    default:
      if (httpCode === 401) return 'token 无效或未授权（401）';
      if (httpCode === -1 || httpCode === 0) return '无法连接 daemon，请检查网络与地址';
      return `${fallbackPrefix}：${message}`;
  }
}

/** Best-effort extraction of a daemon error body. */
export function apiErrorOf(data: unknown): { apiCode: string | null; message: string } {
  if (data && typeof data === 'object') {
    const record = data as { code?: unknown; error?: unknown; message?: unknown };
    const apiCode = typeof record.code === 'string' ? record.code : null;
    const message =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : 'unknown error';
    return { apiCode, message };
  }
  return { apiCode: null, message: typeof data === 'string' ? data : 'unknown error' };
}
