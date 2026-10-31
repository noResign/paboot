import PabootMarkdownUI
import UIKit

/// Design tokens from `docs/ui/shared/design-principles.md` §4.1.
///
/// Values live in `Assets.xcassets` so light/dark switching is handled by the system;
/// this type only gives them semantic names. Never hard-code a hex value in a screen.
enum Theme {
    enum Colors {
        static let background = named("Background", fallback: .systemBackground)
        static let surface = named("Surface", fallback: .secondarySystemBackground)
        static let surface2 = named("Surface2", fallback: .secondarySystemBackground)
        static let border = named("Border", fallback: .separator)
        static let textPrimary = named("TextPrimary", fallback: .label)
        static let textSecondary = named("TextSecondary", fallback: .secondaryLabel)
        static let textMuted = named("TextMuted", fallback: .tertiaryLabel)
        static let primary = named("Primary", fallback: .systemTeal)
        static let primaryDeep = named("PrimaryDeep", fallback: .systemTeal)
        static let primarySubtle = named("PrimarySubtle", fallback: .systemTeal.withAlphaComponent(0.12))
        /// Text/glyph colour on the primary fill (both light and dark themes).
        static let onPrimary = UIColor(hex: 0x06231A)
        static let success = named("Success", fallback: .systemGreen)
        static let warning = named("Warning", fallback: .systemOrange)
        static let error = named("Error", fallback: .systemRed)
        static let thinking = named("Thinking", fallback: .secondaryLabel)
        static let codeBackground = named("CodeBackground", fallback: .secondarySystemBackground)

        private static func named(_ name: String, fallback: UIColor) -> UIColor {
            UIColor(named: name) ?? fallback
        }
    }

    /// Fixed editor palette shared with Android FilesScreen.kt (independent of app theme).
    enum Editor {
        static let background = UIColor(hex: 0x1E1E1E)
        static let hunkBackground = UIColor(hex: 0x2D2D30)
        static let text = UIColor(hex: 0xD4D4D4)
        static let muted = UIColor(hex: 0x858585)
        static let added = UIColor(hex: 0x89D185)
        static let deleted = UIColor(hex: 0xF48771)
        static let hunk = UIColor(hex: 0x569CD6)
        static let divider = UIColor(hex: 0x3C3C3C)
    }

    static func tabBarAppearance() -> UITabBarAppearance {
        let appearance = UITabBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundEffect = nil
        appearance.backgroundColor = .clear
        appearance.shadowColor = .clear

        let item = UITabBarItemAppearance()
        item.normal.iconColor = Colors.textMuted
        item.normal.titleTextAttributes = [.foregroundColor: Colors.textMuted]
        item.selected.iconColor = Colors.primary
        item.selected.titleTextAttributes = [.foregroundColor: Colors.primary]
        appearance.stackedLayoutAppearance = item
        return appearance
    }

    static func navigationBarAppearance() -> UINavigationBarAppearance {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = Colors.surface
        appearance.shadowColor = Colors.border
        appearance.titleTextAttributes = [.foregroundColor: Colors.textPrimary]
        appearance.largeTitleTextAttributes = [.foregroundColor: Colors.textPrimary]
        return appearance
    }

    /// Appearance proxies for bars created later (for example pushed screens).
    static func applyGlobalAppearance() {

        let tab = tabBarAppearance()
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab

        let navigation = navigationBarAppearance()
        UINavigationBar.appearance().standardAppearance = navigation
        UINavigationBar.appearance().scrollEdgeAppearance = navigation
        UINavigationBar.appearance().compactAppearance = navigation
    }
}

/// Shared MarkdownUI styles: the chat transcript (app theme) and the dark file
/// viewer (editor palette, so a README matches the surrounding code chrome).
enum AppMarkdownStyle {
    static func transcript() -> MarkdownUIStyle {
        MarkdownUIStyle(
            bodyFont: Typography.body,
            headingFonts: [
                UIFontMetrics(forTextStyle: .title1)
                    .scaledFont(for: .systemFont(ofSize: 20, weight: .bold)),
                UIFontMetrics(forTextStyle: .title2)
                    .scaledFont(for: .systemFont(ofSize: 17, weight: .semibold)),
                UIFontMetrics(forTextStyle: .title3)
                    .scaledFont(for: .systemFont(ofSize: 15, weight: .semibold)),
                UIFontMetrics(forTextStyle: .headline)
                    .scaledFont(for: .systemFont(ofSize: 14, weight: .semibold)),
            ],
            codeFont: Typography.code,
            textColor: Theme.Colors.textPrimary,
            secondaryTextColor: Theme.Colors.textSecondary,
            codeBackgroundColor: Theme.Colors.codeBackground,
            surfaceColor: Theme.Colors.surface2,
            borderColor: Theme.Colors.border,
            accentColor: Theme.Colors.primary,
            codeKeywordColor: Theme.Colors.primary,
            codeStringColor: Theme.Colors.success,
            codeNumberColor: Theme.Colors.warning,
            codeCommentColor: Theme.Colors.textMuted
        )
    }

    static func fileContent() -> MarkdownUIStyle {
        MarkdownUIStyle(
            bodyFont: Typography.body,
            headingFonts: [
                UIFontMetrics(forTextStyle: .title1)
                    .scaledFont(for: .systemFont(ofSize: 20, weight: .bold)),
                UIFontMetrics(forTextStyle: .title2)
                    .scaledFont(for: .systemFont(ofSize: 17, weight: .semibold)),
                UIFontMetrics(forTextStyle: .title3)
                    .scaledFont(for: .systemFont(ofSize: 15, weight: .semibold)),
                UIFontMetrics(forTextStyle: .headline)
                    .scaledFont(for: .systemFont(ofSize: 14, weight: .semibold)),
            ],
            codeFont: Typography.code,
            textColor: Theme.Editor.text,
            secondaryTextColor: Theme.Editor.muted,
            codeBackgroundColor: Theme.Editor.hunkBackground,
            surfaceColor: Theme.Editor.hunkBackground,
            borderColor: Theme.Editor.divider,
            accentColor: Theme.Editor.hunk,
            codeKeywordColor: Theme.Editor.hunk,
            codeStringColor: Theme.Editor.added,
            codeNumberColor: Theme.Editor.deleted,
            codeCommentColor: Theme.Editor.muted
        )
    }
}
