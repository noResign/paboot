#if canImport(UIKit)
import UIKit

/// A small, dependency-free syntax highlighter for chat code blocks.
///
/// It handles the tokens that actually carry meaning at transcript scale: comments,
/// strings, numbers and keywords. It is not a full parser and intentionally has no
/// semantic highlighting or syntax errors.
public enum CodeHighlighter {
    public static func highlight(
        _ code: String,
        language: String?,
        font: UIFont,
        textColor: UIColor,
        keywordColor: UIColor,
        stringColor: UIColor,
        numberColor: UIColor,
        commentColor: UIColor
    ) -> NSAttributedString {
        let result = NSMutableAttributedString(
            string: code,
            attributes: [
                .font: font,
                .foregroundColor: textColor,
            ]
        )

        let profile = LanguageProfile.forLanguage(language)
        let chars = Array(code)
        var index = 0

        func nsRange(_ start: Int, _ end: Int) -> NSRange {
            let lower = code.index(code.startIndex, offsetBy: start)
            let upper = code.index(code.startIndex, offsetBy: end)
            return NSRange(lower..<upper, in: code)
        }

        func apply(_ color: UIColor, from start: Int, to end: Int) {
            guard end > start, start >= 0, end <= chars.count else { return }
            result.addAttribute(
                .foregroundColor,
                value: color,
                range: nsRange(start, end)
            )
        }

        while index < chars.count {
            let character = chars[index]

            if let marker = profile.lineComments.first(
                where: { matches(chars, at: index, marker: $0) }
            ) {
                let end = lineEnd(chars, from: index)
                apply(commentColor, from: index, to: end)
                index = end
                continue
            }

            if let block = profile.blockComments.first(
                where: { matches(chars, at: index, marker: $0.start) }
            ) {
                let end = blockEnd(chars, from: index + block.start.count, marker: block.end)
                apply(commentColor, from: index, to: end)
                index = end
                continue
            }

            if profile.quotes.contains(character) {
                let triple = profile.tripleQuotes
                    && index + 2 < chars.count
                    && chars[index + 1] == character
                    && chars[index + 2] == character
                let delimiter = triple ? 3 : 1
                let end = stringEnd(
                    chars,
                    from: index + delimiter,
                    quote: character,
                    triple: triple
                )
                apply(stringColor, from: index, to: end)
                index = end
                continue
            }

            if character.isNumber {
                let end = numberEnd(chars, from: index)
                apply(numberColor, from: index, to: end)
                index = end
                continue
            }

            if character.isLetter || character == "_" || character == "@" {
                let end = identifierEnd(chars, from: index)
                let word = String(chars[index..<end])
                let name = word.hasPrefix("@") ? String(word.dropFirst()) : word

                if profile.keywords.contains(name)
                    || (character == "@" && profile.supportsAttributes) {
                    apply(keywordColor, from: index, to: end)
                }
                index = max(end, index + 1)
                continue
            }

            index += 1
        }

        return result
    }

    private static func matches(
        _ chars: [Character],
        at index: Int,
        marker: String
    ) -> Bool {
        let markerChars = Array(marker)
        guard !markerChars.isEmpty, index + markerChars.count <= chars.count else {
            return false
        }
        for offset in 0..<markerChars.count where chars[index + offset] != markerChars[offset] {
            return false
        }
        return true
    }

    private static func lineEnd(_ chars: [Character], from start: Int) -> Int {
        var index = start
        while index < chars.count, chars[index] != "\n" {
            index += 1
        }
        return index
    }

    private static func blockEnd(
        _ chars: [Character],
        from start: Int,
        marker: String
    ) -> Int {
        let markerChars = Array(marker)
        var index = start
        while index < chars.count {
            if matches(chars, at: index, marker: marker) {
                return index + markerChars.count
            }
            index += 1
        }
        return chars.count
    }

    private static func stringEnd(
        _ chars: [Character],
        from start: Int,
        quote: Character,
        triple: Bool
    ) -> Int {
        var index = start
        while index < chars.count {
            if triple {
                if index + 2 < chars.count,
                   chars[index] == quote,
                   chars[index + 1] == quote,
                   chars[index + 2] == quote {
                    return index + 3
                }
            } else if chars[index] == quote {
                return index + 1
            }

            if chars[index] == "\\" {
                index += 2
                continue
            }
            if chars[index] == "\n", !triple, quote != "`" {
                return index
            }
            index += 1
        }
        return chars.count
    }

    private static func numberEnd(_ chars: [Character], from start: Int) -> Int {
        var index = start

        if index + 1 < chars.count, chars[index] == "0" {
            let next = chars[index + 1]
            if next == "x" || next == "X" {
                index += 2
                while index < chars.count, chars[index].isHexDigit || chars[index] == "_" {
                    index += 1
                }
                return index
            }
            if next == "b" || next == "B" {
                index += 2
                while index < chars.count,
                      chars[index] == "0" || chars[index] == "1" || chars[index] == "_" {
                    index += 1
                }
                return index
            }
        }

        while index < chars.count, chars[index].isNumber || chars[index] == "_" {
            index += 1
        }
        if index < chars.count, chars[index] == "." {
            index += 1
            while index < chars.count, chars[index].isNumber || chars[index] == "_" {
                index += 1
            }
        }
        if index < chars.count, chars[index] == "e" || chars[index] == "E" {
            index += 1
            if index < chars.count, chars[index] == "+" || chars[index] == "-" {
                index += 1
            }
            while index < chars.count, chars[index].isNumber {
                index += 1
            }
        }
        return index
    }

    private static func identifierEnd(_ chars: [Character], from start: Int) -> Int {
        var index = start
        if chars[index] == "@" {
            index += 1
        }
        while index < chars.count,
              chars[index].isLetter || chars[index].isNumber || chars[index] == "_" {
            index += 1
        }
        return index
    }
}

private struct LanguageProfile {
    struct BlockComment {
        let start: String
        let end: String
    }

    let keywords: Set<String>
    let lineComments: [String]
    let blockComments: [BlockComment]
    let quotes: Set<Character>
    let tripleQuotes: Bool
    let supportsAttributes: Bool

    static func forLanguage(_ language: String?) -> LanguageProfile {
        switch language?.lowercased() {
        case "swift":
            return swift
        case "kotlin", "kt":
            return kotlin
        case "js", "javascript", "ts", "typescript", "jsx", "tsx":
            return javascript
        case "py", "python":
            return python
        case "sh", "bash", "shell", "zsh":
            return shell
        case "json":
            return json
        default:
            return generic
        }
    }

    private static let swift = LanguageProfile(
        keywords: [
            "actor", "any", "as", "associatedtype", "async", "await", "break", "case",
            "catch", "class", "continue", "default", "defer", "deinit", "do", "else",
            "enum", "extension", "fallthrough", "false", "fileprivate", "final", "for",
            "func", "guard", "if", "import", "in", "indirect", "init", "inout",
            "internal", "is", "let", "mutating", "nil", "nonisolated", "open",
            "operator", "override", "private", "protocol", "public", "repeat",
            "required", "rethrows", "return", "self", "Self", "some", "static",
            "struct", "subscript", "super", "switch", "throw", "throws", "true",
            "try", "typealias", "var", "where", "while", "willSet", "didSet",
        ],
        lineComments: ["//"],
        blockComments: [BlockComment(start: "/*", end: "*/")],
        quotes: ["\""],
        tripleQuotes: true,
        supportsAttributes: true
    )

    private static let kotlin = LanguageProfile(
        keywords: [
            "abstract", "actual", "annotation", "as", "break", "by", "catch", "class",
            "companion", "const", "constructor", "continue", "crossinline", "data",
            "delegate", "do", "dynamic", "else", "enum", "expect", "external", "false",
            "field", "file", "final", "finally", "for", "fun", "get", "if", "import",
            "in", "infix", "init", "inline", "inner", "interface", "internal", "is",
            "lateinit", "noinline", "null", "object", "open", "operator", "out",
            "override", "package", "param", "private", "protected", "public",
            "receiver", "reified", "return", "sealed", "set", "super", "suspend",
            "tailrec", "this", "throw", "true", "try", "typealias", "typeof", "val",
            "var", "vararg", "when", "where", "while",
        ],
        lineComments: ["//"],
        blockComments: [BlockComment(start: "/*", end: "*/")],
        quotes: ["\"", "'"],
        tripleQuotes: true,
        supportsAttributes: true
    )

    private static let javascript = LanguageProfile(
        keywords: [
            "async", "await", "break", "case", "catch", "class", "const", "continue",
            "debugger", "default", "delete", "do", "else", "export", "extends",
            "false", "finally", "for", "from", "function", "if", "implements",
            "import", "in", "instanceof", "interface", "let", "namespace", "new",
            "null", "of", "private", "protected", "public", "readonly", "return",
            "static", "super", "switch", "this", "throw", "true", "try", "type",
            "typeof", "undefined", "var", "void", "while", "with", "yield",
        ],
        lineComments: ["//"],
        blockComments: [BlockComment(start: "/*", end: "*/")],
        quotes: ["\"", "'", "`"],
        tripleQuotes: false,
        supportsAttributes: false
    )

    private static let python = LanguageProfile(
        keywords: [
            "False", "None", "True", "and", "as", "assert", "async", "await",
            "break", "class", "continue", "def", "del", "elif", "else", "except",
            "finally", "for", "from", "global", "if", "import", "in", "is",
            "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
            "while", "with", "yield",
        ],
        lineComments: ["#"],
        blockComments: [],
        quotes: ["\"", "'"],
        tripleQuotes: true,
        supportsAttributes: false
    )

    private static let shell = LanguageProfile(
        keywords: [
            "if", "then", "else", "elif", "fi", "for", "while", "until", "do",
            "done", "case", "esac", "function", "select", "time", "in", "return",
            "break", "continue", "export", "local", "readonly", "declare", "unset",
            "echo", "cd", "exit", "true", "false",
        ],
        lineComments: ["#"],
        blockComments: [],
        quotes: ["\"", "'"],
        tripleQuotes: false,
        supportsAttributes: false
    )

    private static let json = LanguageProfile(
        keywords: ["true", "false", "null"],
        lineComments: [],
        blockComments: [],
        quotes: ["\""],
        tripleQuotes: false,
        supportsAttributes: false
    )

    private static let generic = LanguageProfile(
        keywords: [
            "if", "else", "for", "while", "return", "break", "continue", "class",
            "function", "let", "var", "const", "import", "export", "true", "false",
            "null", "nil", "new", "this", "async", "await", "try", "catch", "throw",
        ],
        lineComments: ["//"],
        blockComments: [BlockComment(start: "/*", end: "*/")],
        quotes: ["\"", "'"],
        tripleQuotes: false,
        supportsAttributes: false
    )
}
#endif
