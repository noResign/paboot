import Foundation
import PabootProtocol

/// Recent connections and the one active in this launch.
///
/// Mirrors Android's `SettingsStore` rules:
/// - at most 5 recent connections, newest first;
/// - the same daemon reached through a different address is one entry (`serverId` dedupe);
/// - older daemons without `serverId` fall back to deduping by base URL.
final class ConnectionStore {
    static let shared = ConnectionStore()

    private let defaultsKey = "paboot.savedConnections"
    private let maxConnections = 5
    private let defaults: UserDefaults

    private(set) var savedConnections: [SavedConnection] = []
    /// Set only after a successful health + auth check in this launch.
    private(set) var active: SavedConnection?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        load()
    }

    func token(for connection: SavedConnection) -> String? {
        KeychainStore.get(connection.id)
    }

    /// Persists the token and metadata. Returns nil when the address is invalid, the token is
    /// empty, or the Keychain write fails.
    @discardableResult
    func remember(name: String, rawURL: String, token: String, serverId: String?) -> SavedConnection? {
        guard let url = URLNormalizer.normalize(rawURL) else { return nil }

        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else { return nil }

        let baseUrl = url.absoluteString
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedServerId = serverId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let storedServerId: String?
        if let trimmedServerId, !trimmedServerId.isEmpty {
            storedServerId = trimmedServerId
        } else {
            storedServerId = nil
        }
        let id = storedServerId ?? baseUrl
        let displayName = trimmedName.isEmpty ? (url.host ?? baseUrl) : trimmedName

        let connection = SavedConnection(
            id: id,
            name: displayName,
            baseUrl: baseUrl,
            serverId: storedServerId,
            lastUsedAt: Date().timeIntervalSince1970
        )

        guard KeychainStore.set(trimmedToken, for: id) else { return nil }

        savedConnections.removeAll { $0.id == id || $0.baseUrl == baseUrl }
        savedConnections.insert(connection, at: 0)
        savedConnections = Array(savedConnections.prefix(maxConnections))
        active = connection
        persist()
        return connection
    }

    func forget(_ connection: SavedConnection) {
        KeychainStore.delete(connection.id)
        savedConnections.removeAll { $0.id == connection.id }
        if active?.id == connection.id {
            active = nil
        }
        persist()
    }

    private func load() {
        guard let data = defaults.data(forKey: defaultsKey) else { return }
        savedConnections = (try? JSONDecoder().decode([SavedConnection].self, from: data)) ?? []
    }

    private func persist() {
        let data = try? JSONEncoder().encode(savedConnections)
        defaults.set(data, forKey: defaultsKey)
    }
}
