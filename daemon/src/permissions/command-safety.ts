/**
 * Bash 只读命令判定。审批策略：明确只读的命令自动放行，其余（写入/删除/网络/
 * 未知）一律询问。
 *
 * 这是「白名单 + 纯净度」双保险：
 *  1. 命令含 shell 元字符（管道、重定向、`&&`、`;`、`$()`、反引号等）→ 不算只读，
 *     因为可能组合出副作用；
 *  2. 纯净命令的首词（或其版本查询/只读子命令形式）命中白名单 → 只读。
 */
const SHELL_META = /[|><;&`$]/;

const READ_ONLY_PATTERNS: RegExp[] = [
  // 文件查看 / 搜索
  /^(?:ls|ll|cat|less|more|head|tail|grep|rg|tree|wc)(?:\s|$)/,
  // 系统 / 进程信息
  /^(?:pwd|echo|printf|du|df|free|uname|date|whoami|id|hostname|env|printenv|ps|top|htop|netstat|ss|lsof|which|whereis)(?:\s|$)/,
  // 版本查询
  /^node\s+(?:--version|-v)(?:\s|$)/,
  /^(?:python|python3)\s+(?:--version|-V)(?:\s|$)/,
  /^java\s+(?:-version|--version)(?:\s|$)/,
  // 只读 git 子命令
  /^git\s+(?:status|log|diff|branch|show|remote|rev-parse|ls-files)(?:\s|$)/,
];

export function isReadOnlyBash(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || SHELL_META.test(cmd)) return false;
  return READ_ONLY_PATTERNS.some((re) => re.test(cmd));
}
