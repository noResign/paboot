import UIKit

/// Semantic type roles from `docs/ui/shared/design-principles.md` §4.2.
///
/// The point sizes are the design defaults; `UIFontMetrics` scales them for Dynamic Type,
/// so screens never hard-code a size.
enum Typography {
    /// 页面标题 — 20 pt, semibold.
    static let pageTitle = scaled(size: 20, weight: .semibold, style: .title3)

    /// 列表标题 / 卡片标题 — 16 pt, semibold.
    static let cardTitle = scaled(size: 16, weight: .semibold, style: .headline)

    /// 正文 — 14 pt, regular.
    static let body = scaled(size: 14, weight: .regular, style: .body)

    /// 辅助说明 — 12 pt, regular.
    static let caption = scaled(size: 12, weight: .regular, style: .caption1)

    /// 代码 / 路径 / 命令 — 13 pt monospaced.
    static let code = UIFontMetrics(forTextStyle: .body).scaledFont(
        for: .monospacedSystemFont(ofSize: 13, weight: .regular)
    )

    private static func scaled(
        size: CGFloat,
        weight: UIFont.Weight,
        style: UIFont.TextStyle
    ) -> UIFont {
        UIFontMetrics(forTextStyle: style).scaledFont(
            for: .systemFont(ofSize: size, weight: weight)
        )
    }
}
