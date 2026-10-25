import Foundation

/// Non-secret metadata for a daemon we have connected to. The token lives in the Keychain,
/// under `id`.
struct SavedConnection: Codable, Equatable {
    /// `serverId` when the daemon reports one, otherwise the normalized base URL.
    let id: String
    let name: String
    let baseUrl: String
    let serverId: String?
    let lastUsedAt: TimeInterval

    var displayName: String {
        let raw = name.isEmpty ? (URL(string: baseUrl)?.host ?? baseUrl) : name
        return AddressMask.mask(raw)
    }
}
