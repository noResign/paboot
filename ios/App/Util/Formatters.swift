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
}
