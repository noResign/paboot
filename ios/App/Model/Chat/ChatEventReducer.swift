import Foundation
import PabootProtocol

/// Folds normalized events into an assistant message. Pure, so history replay and the
/// live stream share exactly the same rules.
enum ChatEventReducer {
    static func apply(_ event: NormalizedEvent, to message: inout ChatUiMessage) {
        switch event {
        case .status(let status):
            if status.terminal == true {
                finalize(&message)
            }

        case .textDelta(let event):
            appendText(event.delta, to: &message)

        case .thinkingDelta(let event):
            appendThinking(event.delta, to: &message)

        case .thinkingStart:
            break

        case .toolUse(let event):
            message.blocks.append(
                .tool(ToolUseBlock(id: event.id, name: event.name, input: event.input))
            )

        case .toolResult(let event):
            guard let toolUseId = event.toolUseId else { return }
            for index in message.blocks.indices {
                guard case .tool(var tool) = message.blocks[index], tool.id == toolUseId else {
                    continue
                }
                tool.result = event.content
                tool.isError = event.isError == true
                tool.interrupted = event.interrupted == true
                tool.running = false
                message.blocks[index] = .tool(tool)
            }

        case .usage(let event):
            if let usage = parseUsage(event) {
                message.usage = usage
            }

        case .turnEnd:
            break

        case .error(let event):
            message.error = event.message
            if event.terminal == true {
                finalize(&message)
            }

        case .permissionRequest:
            // Approvals are transient; they never belong in the transcript.
            break

        case .question(let event):
            message.blocks.append(
                .question(
                    QuestionBlock(toolUseId: event.toolUseId, questions: event.questions)
                )
            )

        case .unknown:
            break
        }
    }

    /// Mark a message complete and close tools that never returned.
    static func finalize(_ message: inout ChatUiMessage) {
        message.done = true
        message.blocks = message.blocks.map { block in
            guard case .tool(var tool) = block, tool.running else { return block }
            tool.running = false
            tool.interrupted = true
            return .tool(tool)
        }
    }

    static func isTerminal(_ event: NormalizedEvent) -> Bool {
        switch event {
        case .status(let status):
            return status.terminal == true
        case .error(let error):
            return error.terminal == true
        default:
            return false
        }
    }

    private static func appendText(_ delta: String, to message: inout ChatUiMessage) {
        if case .text(let existing)? = message.blocks.last {
            message.blocks[message.blocks.count - 1] = .text(existing + delta)
        } else {
            message.blocks.append(.text(delta))
        }
    }

    private static func appendThinking(_ delta: String, to message: inout ChatUiMessage) {
        if case .thinking(let existing)? = message.blocks.last {
            message.blocks[message.blocks.count - 1] = .thinking(existing + delta)
        } else {
            message.blocks.append(.thinking(delta))
        }
    }

    private static func parseUsage(_ event: NormalizedEvent.Usage) -> UsageInfo? {
        var input: Int64?
        var output: Int64?

        if case .object(let object)? = event.usage {
            if let tokens = object["input_tokens"]?.intValue {
                input = Int64(tokens)
            }
            if let tokens = object["output_tokens"]?.intValue {
                output = Int64(tokens)
            }
        }

        guard input != nil || output != nil || event.costUsd != nil else {
            return nil
        }
        return UsageInfo(inputTokens: input, outputTokens: output, costUsd: event.costUsd)
    }
}
