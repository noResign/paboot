import Foundation
import PabootProtocol

/// One row in the transcript.
struct ChatUiMessage: Equatable, Identifiable {
    enum Role: Equatable {
        case user
        case assistant
    }

    let id: String
    let role: Role
    var text: String = ""
    /// Send time (epoch ms) for a user row; 0 when an old history has none.
    var sentAt: Int64 = 0
    var blocks: [ContentBlock] = []
    var usage: UsageInfo?
    var error: String?
    var done: Bool = true
}

/// Ordered assistant content. Tool calls and questions keep their arrival order.
enum ContentBlock: Equatable {
    case text(String)
    case thinking(ThinkingBlock)
    case tool(ToolUseBlock)
    case question(QuestionBlock)
}

/// A thinking card. The runtime's reasoning text is deliberately not sent, so the
/// card is an empty, collapsible marker that spins while the block is active.
struct ThinkingBlock: Equatable {
    var active: Bool = true
}

struct ToolUseBlock: Equatable {
    var id: String
    var name: String
    var input: JSONValue?
    var result: String?
    var isError: Bool = false
    /// The run ended before the tool returned (cancel / crash / idle timeout).
    var interrupted: Bool = false
    var running: Bool = true
}

struct QuestionBlock: Equatable {
    var toolUseId: String
    var questions: [QuestionDto]
    var answered: Bool = false
}

struct UsageInfo: Equatable {
    var inputTokens: Int64?
    var outputTokens: Int64?
    var costUsd: Double?
}

/// `contextTokens` is how full the window is now; it can go down after compaction,
/// unlike `UsageInfo` which is the per-run total.
struct ContextUsage: Equatable {
    var tokens: Int64
    /// `nil` means the runtime does not report a window (Claude).
    var window: Int64?

    var percent: Int? {
        guard let window, window > 0 else { return nil }
        return min(max(Int((Double(tokens) * 100 / Double(window)).rounded()), 0), 100)
    }

    var display: String {
        if let window, window > 0 {
            return "\(Formatters.tokens(tokens)) / \(Formatters.tokens(window)) · \(percent ?? 0)%"
        }
        return "\(Formatters.tokens(tokens)) tokens"
    }
}

struct TodoItem: Equatable {
    var content: String
    var status: String
}

struct PendingPermission: Equatable {
    var permissionId: String
    var runId: String?
    var toolName: String
    var toolInput: JSONValue?
    var status: String
}

/// Parse `TodoWrite` input: `{ "todos": [{content, status}, ...] }`.
func parseTodos(_ input: JSONValue?) -> [TodoItem] {
    guard case .object(let object)? = input,
          case .array(let items)? = object["todos"] else {
        return []
    }

    return items.compactMap { item in
        guard case .object(let fields) = item,
              case .string(let content)? = fields["content"] else {
            return nil
        }
        let status: String
        if case .string(let value)? = fields["status"] {
            status = value
        } else {
            status = "pending"
        }
        return TodoItem(content: content, status: status)
    }
}
