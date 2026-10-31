import Foundation

enum AddressMask {
    /// 只保留 IP 第一段，端口一并隐去：`192.168.1.5:4780` → `192.*.*.*:****`。
    /// 主机名原样返回。
    static func mask(_ value: String) -> String {
        value
            .replacingOccurrences(
                of: #"\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\b"#,
                with: "$1.*.*.*:****",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"#,
                with: "$1.*.*.*",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"\[([0-9a-fA-F]+):[0-9a-fA-F:]+\]:\d{1,5}"#,
                with: "[$1:…]:****",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"\[([0-9a-fA-F]+):[0-9a-fA-F:]+\]"#,
                with: "[$1:…]",
                options: .regularExpression
            )
    }
}

enum Formatters {
    private static let relativeDate: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter
    }()

    /// `lastActiveAt` is epoch milliseconds.
    static func relativeTime(fromMilliseconds milliseconds: Int64) -> String {
        guard milliseconds > 0 else { return "" }
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
        return relativeDate.localizedString(for: date, relativeTo: Date())
    }

    private static let messageClock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let messageDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy/M/d"
        return formatter
    }()

    /// Sent-at stamp for a user message: clock today, a date prefix before that.
    /// Unlike `relativeTime`, it answers "几点发的" once a transcript spans days.
    static func messageTime(fromMilliseconds milliseconds: Int64) -> String {
        guard milliseconds > 0 else { return "" }
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
        let calendar = Calendar(identifier: .gregorian)
        let time = messageClock.string(from: date)
        if calendar.isDateInToday(date) { return time }
        if calendar.isDateInYesterday(date) { return "昨天 \(time)" }
        let now = Date()
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            let month = calendar.component(.month, from: date)
            let day = calendar.component(.day, from: date)
            return "\(month)月\(day)日 \(time)"
        }
        return "\(messageDate.string(from: date)) \(time)"
    }

    /// `1234` → `1.2k`, `1_234_567` → `1.2M`.
    static func tokens(_ value: Int64) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fk", Double(value) / 1_000)
        }
        return "\(value)"
    }
}
