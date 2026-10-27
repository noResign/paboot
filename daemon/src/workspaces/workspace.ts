import path from 'node:path';
import { expandHome } from '../platform/paths.js';

/**
 * Resolve `raw` to an absolute path and check it is inside a given workspace
 * root (the root itself or a descendant). Returns the canonical absolute path,
 * or `null` when it is outside that workspace.
 *
 * 这是「Session cwd 是否属于该 Workspace」的安全边界：所有 cwd（新建 / 续接 / 导入
 * Claude 会话）都必须通过它（deny-by-default）。
 */
export function resolveWorkspaceCwd(raw: string, root: string): string | null {
  const target = path.resolve(expandHome(raw));
  const r = path.resolve(root);
  if (target === r || target.startsWith(r + path.sep)) {
    return target;
  }
  return null;
}
