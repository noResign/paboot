import Foundation

/// Turns a single-file unified patch into rows that can be laid out side by side.
///
/// Consecutive removed and added lines are paired in order, so a replacement occupies one
/// row instead of two. Meta lines (diff headers, `\ No newline`) and hunk headers become
/// full-width rows.
public enum SplitDiff {
    public enum Kind: Equatable, Sendable {
        case hunk
        case meta
        case lines
    }

    public struct Row: Equatable, Sendable {
        public let kind: Kind
        public let oldLineNumber: Int?
        public let newLineNumber: Int?
        public let oldText: String?
        public let newText: String?
        /// Set for `.hunk` / `.meta` rows.
        public let fullText: String?

        public init(
            kind: Kind = .lines,
            oldLineNumber: Int? = nil,
            newLineNumber: Int? = nil,
            oldText: String? = nil,
            newText: String? = nil,
            fullText: String? = nil
        ) {
            self.kind = kind
            self.oldLineNumber = oldLineNumber
            self.newLineNumber = newLineNumber
            self.oldText = oldText
            self.newText = newText
            self.fullText = fullText
        }
    }

    private static let hunkPattern = #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$"#
    private static let hunkRegex = try? NSRegularExpression(pattern: hunkPattern)

    public static func parse(_ patch: String) -> [Row] {
        guard !patch.isEmpty else { return [] }

        var rows: [Row] = []
        var oldLine = 0
        var newLine = 0
        var inHunk = false
        var pendingOld: [(number: Int, text: String)] = []
        var pendingNew: [(number: Int, text: String)] = []

        func flushPending() {
            let count = max(pendingOld.count, pendingNew.count)
            guard count > 0 else { return }

            for index in 0..<count {
                let old = index < pendingOld.count ? pendingOld[index] : nil
                let new = index < pendingNew.count ? pendingNew[index] : nil
                rows.append(
                    Row(
                        kind: .lines,
                        oldLineNumber: old?.number,
                        newLineNumber: new?.number,
                        oldText: old?.text,
                        newText: new?.text
                    )
                )
            }
            pendingOld.removeAll()
            pendingNew.removeAll()
        }

        var lines = patch.components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" {
            lines.removeLast()
        }

        for rawLine in lines {
            if let start = hunkStart(rawLine) {
                flushPending()
                oldLine = start.old
                newLine = start.new
                inHunk = true
                rows.append(Row(kind: .hunk, fullText: rawLine))
                continue
            }

            if rawLine.hasPrefix("\\ No newline") {
                flushPending()
                rows.append(Row(kind: .meta, fullText: rawLine))
                continue
            }

            if !inHunk {
                rows.append(Row(kind: .meta, fullText: rawLine))
                continue
            }

            if rawLine.hasPrefix("+") {
                pendingNew.append((number: newLine, text: String(rawLine.dropFirst())))
                newLine += 1
            } else if rawLine.hasPrefix("-") {
                pendingOld.append((number: oldLine, text: String(rawLine.dropFirst())))
                oldLine += 1
            } else if rawLine.hasPrefix(" ") {
                flushPending()
                let text = String(rawLine.dropFirst())
                rows.append(
                    Row(
                        kind: .lines,
                        oldLineNumber: oldLine,
                        newLineNumber: newLine,
                        oldText: text,
                        newText: text
                    )
                )
                oldLine += 1
                newLine += 1
            } else if rawLine.isEmpty {
                flushPending()
                rows.append(
                    Row(
                        kind: .lines,
                        oldLineNumber: oldLine,
                        newLineNumber: newLine,
                        oldText: "",
                        newText: ""
                    )
                )
                oldLine += 1
                newLine += 1
            } else {
                flushPending()
                rows.append(Row(kind: .meta, fullText: rawLine))
            }
        }

        flushPending()
        return rows
    }

    private static func hunkStart(_ line: String) -> (old: Int, new: Int)? {
        guard line.hasPrefix("@@") else { return nil }

        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let regex = hunkRegex, let match = regex.firstMatch(in: line, range: range) else {
            return nil
        }

        func group(_ index: Int) -> Int? {
            let groupRange = match.range(at: index)
            guard groupRange.location != NSNotFound,
                  let swiftRange = Range(groupRange, in: line) else {
                return nil
            }
            return Int(line[swiftRange])
        }

        guard let old = group(1), let new = group(3) else { return nil }
        return (old, new)
    }
}
