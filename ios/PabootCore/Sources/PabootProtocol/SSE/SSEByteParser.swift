import Foundation

/// Splits the wire bytes using SSE line endings only, preserving empty event delimiters.
/// A general text-line sequence can omit blank lines and split on Unicode separators;
/// either behavior corrupts SSE framing. UTF-8 is decoded only after a whole line arrives.
public final class SSEByteParser {
    private let parser = SSEParser()
    private var line: [UInt8] = []
    private var skipLF = false
    private var firstLine = true

    public init() {}

    public func feed(_ byte: UInt8) -> SSEEvent? {
        if skipLF {
            skipLF = false
            if byte == 0x0A { return nil }
        }
        switch byte {
        case 0x0D:
            skipLF = true
            return finishLine()
        case 0x0A:
            return finishLine()
        default:
            line.append(byte)
            return nil
        }
    }

    public func flush() -> SSEEvent? {
        if !line.isEmpty { _ = finishLine() }
        return parser.flush()
    }

    private func finishLine() -> SSEEvent? {
        if firstLine {
            firstLine = false
            if line.starts(with: [0xEF, 0xBB, 0xBF]) {
                line.removeFirst(3)
            }
        }
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        return parser.feed(text)
    }
}
