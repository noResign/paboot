import Foundation

/// Stateful line-based SSE parser (no IO, so it is directly unit-testable).
///
/// Accumulates fields and dispatches one `SSEEvent` per blank line:
/// ```
/// event: foo
/// data: {"a":1}
/// <blank>            → SSEEvent(event: "foo", data: "{\"a\":1}")
/// ```
///
/// Supports `id` / `event` / `data` / `retry`; `:` lines are comments (the daemon sends
/// `: keepalive` every 15 seconds); a line without a colon is a field with an empty value;
/// multi-line `data` is joined with `\n`.
public final class SSEParser {
    private var id: String?
    private var event: String?
    private var retry: Int?
    private var dataLines: [String] = []

    public init() {}

    /// Feed one line **without** its trailing newline. Returns an event when this line
    /// completes one, otherwise `nil`.
    public func feed(_ rawLine: String) -> SSEEvent? {
        // Accept CRLF input as well: transport code that reads bytes may hand us "\r".
        var line = rawLine
        if line.hasSuffix("\r") {
            line.removeLast()
        }

        if line.isEmpty {
            return drain()
        }
        if line.hasPrefix(":") {
            return nil
        }
        apply(line)
        return nil
    }

    /// Call at end of stream to flush an event the server did not terminate with a blank line.
    public func flush() -> SSEEvent? {
        drain()
    }

    private func apply(_ line: String) {
        let field: String
        let value: String

        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            var raw = String(line[line.index(after: colon)...])
            // Per spec, a single space immediately after the colon is not part of the value.
            if raw.hasPrefix(" ") {
                raw.removeFirst()
            }
            value = raw
        } else {
            field = line
            value = ""
        }

        switch field {
        case "data":
            dataLines.append(value)
        case "event":
            event = value
        case "id":
            id = value
        case "retry":
            retry = Int(value)
        default:
            break // unknown field: ignore
        }
    }

    private func drain() -> SSEEvent? {
        guard !dataLines.isEmpty || id != nil || event != nil || retry != nil else {
            return nil
        }

        let parsed = SSEEvent(id: id, event: event, data: dataLines.joined(separator: "\n"), retry: retry)
        id = nil
        event = nil
        retry = nil
        dataLines.removeAll(keepingCapacity: true)
        return parsed
    }
}
