#if canImport(UIKit)
import UIKit

/// Colors and fonts supplied by the app so this module stays theme-agnostic.
public struct MarkdownUIStyle {
    public var bodyFont: UIFont
    /// H1, H2, H3, H4+ (the last font is reused for deeper levels).
    public var headingFonts: [UIFont]
    public var codeFont: UIFont
    public var textColor: UIColor
    public var secondaryTextColor: UIColor
    public var codeBackgroundColor: UIColor
    public var surfaceColor: UIColor
    public var borderColor: UIColor
    public var accentColor: UIColor

    public var codeKeywordColor: UIColor
    public var codeStringColor: UIColor
    public var codeNumberColor: UIColor
    public var codeCommentColor: UIColor

    public init(
        bodyFont: UIFont,
        headingFonts: [UIFont],
        codeFont: UIFont,
        textColor: UIColor,
        secondaryTextColor: UIColor,
        codeBackgroundColor: UIColor,
        surfaceColor: UIColor,
        borderColor: UIColor,
        accentColor: UIColor,
        codeKeywordColor: UIColor,
        codeStringColor: UIColor,
        codeNumberColor: UIColor,
        codeCommentColor: UIColor
    ) {
        self.bodyFont = bodyFont
        self.headingFonts = headingFonts
        self.codeFont = codeFont
        self.textColor = textColor
        self.secondaryTextColor = secondaryTextColor
        self.codeBackgroundColor = codeBackgroundColor
        self.surfaceColor = surfaceColor
        self.borderColor = borderColor
        self.accentColor = accentColor
        self.codeKeywordColor = codeKeywordColor
        self.codeStringColor = codeStringColor
        self.codeNumberColor = codeNumberColor
        self.codeCommentColor = codeCommentColor
    }
}
#endif
