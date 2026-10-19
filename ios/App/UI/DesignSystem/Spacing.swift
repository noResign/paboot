import UIKit

/// Spacing / radius / touch-target tokens from
/// `docs/ui/shared/design-principles.md` §4.3. Base grid is 4 pt.
enum Spacing {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 20
    static let xl: CGFloat = 24
}

enum Radius {
    static let card: CGFloat = 12
    static let bubble: CGFloat = 16
    static let sheet: CGFloat = 24
}

enum Layout {
    static let minTouchTarget: CGFloat = 48
}
