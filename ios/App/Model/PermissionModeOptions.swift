import Foundation

/// Permission-mode copy, which depends on the runtime: the same saved mode means
/// different things in Claude Code and Codex.
enum PermissionModeOptions {
    struct Option {
        let mode: String
        let title: String
        let detail: String
    }

    static func options(runtime: String?, bypassAllowed: Bool = true) -> [Option] {
        let all = buildOptions(runtime: runtime)
        return bypassAllowed ? all : all.filter { $0.mode != "bypass" }
    }

    /// A server-strict daemon silently downgrades bypass; mirror that in the UI.
    static func clamp(_ mode: String, bypassAllowed: Bool) -> String {
        !bypassAllowed && mode == "bypass" ? "acceptEdits" : mode
    }

    static func label(for mode: String) -> String {
        switch mode {
        case "ask": return "询问"
        case "acceptEdits": return "自动接受编辑"
        case "bypass": return "绕过审批"
        default: return mode
        }
    }

    private static func buildOptions(runtime: String?) -> [Option] {
        switch runtime {
        case "codex":
            return [
                Option(
                    mode: "ask",
                    title: "询问",
                    detail: "工作区沙箱；不受信任的命令需要审批，工作区编辑可能自动执行"
                ),
                Option(
                    mode: "acceptEdits",
                    title: "自动接受编辑",
                    detail: "工作区沙箱内的命令和编辑可自动执行；提权由 Codex 请求审批"
                ),
                Option(
                    mode: "bypass",
                    title: "绕过审批",
                    detail: "关闭沙箱并跳过工具审批（高风险）"
                ),
            ]
        case "deepseek":
            return [
                Option(mode: "ask", title: "询问", detail: "只读沙箱；写文件或提权命令需要审批"),
                Option(mode: "acceptEdits", title: "自动接受编辑", detail: "工作区可写；越出工作区的操作需要审批"),
                Option(mode: "bypass", title: "绕过审批", detail: "关闭沙箱并跳过工具审批（高风险）"),
            ]
        case "claude":
            return [
                Option(mode: "ask", title: "询问", detail: "修改类操作询问"),
                Option(mode: "acceptEdits", title: "自动接受编辑", detail: "编辑自动放行，Bash 仍询问"),
                Option(mode: "bypass", title: "绕过审批", detail: "全部通过（高风险）"),
            ]
        case "builtin":
            return [
                Option(mode: "ask", title: "询问", detail: "Read 自动；写入、命令和 MCP 工具需要审批"),
                Option(mode: "acceptEdits", title: "自动接受编辑", detail: "工作区内写入自动；命令和 MCP 工具仍需审批"),
                Option(mode: "bypass", title: "绕过审批", detail: "全路径读写且跳过审批（极高风险）"),
            ]
        default:
            return [
                Option(
                    mode: "ask",
                    title: "询问",
                    detail: "按 Agent 默认规则审批，具体范围见新建会话页"
                ),
                Option(
                    mode: "acceptEdits",
                    title: "自动接受编辑",
                    detail: "减少审批；部分 Agent 也会自动执行命令"
                ),
                Option(mode: "bypass", title: "绕过审批", detail: "跳过工具审批（高风险）"),
            ]
        }
    }

    static func title(for mode: String) -> String {
        options(runtime: nil).first(where: { $0.mode == mode })?.title ?? mode
    }
}
