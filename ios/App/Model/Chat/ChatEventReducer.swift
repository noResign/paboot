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
            endThinking(&message)
            appendText(event.delta, to: &message)

        case .thinkingDelta:
            // Legacy daemons still stream thinking; the card stays alive but
            // none of the text is stored.
            keepThinking(&message)

        case .thinkingStart:
            endThinking(&message)
            message.blocks.append(.thinking(ThinkingBlock(active: true)))

        case .toolUse(let event):
            endThinking(&message)
            message.blocks.append(
                .tool(ToolUseBlock(id: event.id, name: event.name, input: event.input))
            )

        case .toolResult(let event):
            endThinking(&message)
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
            // The runtime reports this at a model-turn boundary, i.e. after the
            // thinking block has finished.
            endThinking(&message)
            if let usage = parseUsage(event) {
                message.usage = usage
            }

        case .turnEnd:
            endThinking(&message)

        case .error(let event):
            endThinking(&message)
            message.error = event.message
            if event.terminal == true {
                finalize(&message)
            }

        case .permissionRequest:
            // Approvals are transient; they never belong in the transcript.
            endThinking(&message)

        case .question(let event):
            endThinking(&message)
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
        endThinking(&message)
        message.blocks = message.blocks.map { block in
            guard case .tool(var tool) = block, tool.running else { return block }
            tool.running = false
            tool.interrupted = true
            return .tool(tool)
        }
    }

    /// Stop the spinner on the trailing thinking card. Visible content (text,
    /// tools, questions, usage, a turn boundary) means thinking has finished.
    static func endThinking(_ message: inout ChatUiMessage) {
        guard let last = message.blocks.last, case .thinking(var block) = last, block.active else {
            return
        }
        block.active = false
        message.blocks[message.blocks.count - 1] = .thinking(block)
    }

    /// Keep a thinking card alive for an older daemon that still streams deltas,
    /// without keeping any of the text.
    private static func keepThinking(_ message: inout ChatUiMessage) {
        if case .thinking(var block)? = message.blocks.last {
            guard !block.active else { return }
            block.active = true
            message.blocks[message.blocks.count - 1] = .thinking(block)
        } else {
            message.blocks.append(.thinking(ThinkingBlock(active: true)))
        }
    }

    /// Fold runs of consecutive text/thinking deltas into one event each.
    ///
    /// Text still arrives token-by-token (and older daemons may stream thinking):
    /// applying each delta individually copies the whole accumulated block string
    /// once per token, so live batching and history replay merge a run first.
    static func coalesced(_ events: [NormalizedEvent]) -> [NormalizedEvent] {
        var result: [NormalizedEvent] = []
        result.reserveCapacity(min(events.count, 512))
        var kind: DeltaKind?
        var chunks: [String] = []

        func flush() {
            let pendingKind = kind
            kind = nil
            guard let pendingKind, !chunks.isEmpty else {
                chunks.removeAll(keepingCapacity: true)
                return
            }
            let merged = chunks.count == 1 ? chunks[0] : chunks.joined()
            chunks.removeAll(keepingCapacity: true)
            guard !merged.isEmpty else { return }
            switch pendingKind {
            case .text:
                result.append(.textDelta(NormalizedEvent.TextDelta(delta: merged)))
            case .thinking:
                result.append(.thinkingDelta(NormalizedEvent.ThinkingDelta(delta: merged)))
            }
        }

        for event in events {
            switch event {
            case .textDelta(let delta):
                if kind != .text {
                    flush()
                    kind = .text
                }
                if !delta.delta.isEmpty { chunks.append(delta.delta) }
            case .thinkingDelta(let delta):
                if kind != .thinking {
                    flush()
                    kind = .thinking
                }
                if !delta.delta.isEmpty { chunks.append(delta.delta) }
            default:
                flush()
                result.append(event)
            }
        }
        flush()
        return result
    }

    private enum DeltaKind: Equatable {
        case text
        case thinking
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
