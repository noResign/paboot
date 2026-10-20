import Foundation

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
