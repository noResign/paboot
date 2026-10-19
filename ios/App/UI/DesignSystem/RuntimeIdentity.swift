import UIKit

/// `runtime id → icon + tint + display name`, from `design-principles.md` §5.2.
///
/// Adding an agent is one row here; screens never branch on a runtime name.
struct RuntimeIdentity: Equatable {
    let id: String
    let displayName: String
    let symbolName: String
    let tint: UIColor

    private static let table: [String: RuntimeIdentity] = [
        "claude": RuntimeIdentity(
            id: "claude",
            displayName: "Claude Code",
            symbolName: "sparkles",
            tint: UIColor(hex: 0xD97757)
        ),
        "codex": RuntimeIdentity(
            id: "codex",
            displayName: "Codex",
            symbolName: "terminal",
            tint: UIColor(hex: 0x10A37F)
        ),
    ]

    /// Unknown ids stay neutral but keep the daemon-provided name.
    static func resolve(id: String, fallbackName: String? = nil) -> RuntimeIdentity {
        if let identity = table[id] {
            return identity
        }
        return RuntimeIdentity(
            id: id,
            displayName: fallbackName ?? id,
            symbolName: "hammer",
            tint: Theme.Colors.textSecondary
        )
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
