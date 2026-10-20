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

    static func tabBarAppearance() -> UITabBarAppearance {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = Colors.surface

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
