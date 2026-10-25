import Combine
import Foundation

/// Drives the connect screen. Navigation stays outside: `onConnected` is called after the
/// token is verified and persisted.
@MainActor
final class ConnectViewModel {
    struct State {
        var address: String
        var token: String
        var name: String
        var isConnecting: Bool
        var error: String?
        var saved: [SavedConnection]
    }

    @Published private(set) var state: State
    var onConnected: ((SavedConnection) -> Void)?

    private let repository: ConnectRepository
    private let store: ConnectionStore

    init(repository: ConnectRepository = ConnectRepository(), store: ConnectionStore = .shared) {
        self.repository = repository
        self.store = store

        let recent = store.savedConnections.first
        state = State(
            address: recent?.baseUrl ?? "",
            token: recent.flatMap { store.token(for: $0) } ?? "",
            name: recent?.name ?? "",
            isConnecting: false,
            error: nil,
            saved: store.savedConnections
        )
    }

    func updateAddress(_ value: String) {
        state.address = value
        state.error = nil
    }

    func updateToken(_ value: String) {
        state.token = value
        state.error = nil
    }

    func updateName(_ value: String) {
        state.name = value
    }

    /// Fill the form from a saved connection; does not connect by itself.
    func select(_ connection: SavedConnection) {
        state.address = connection.baseUrl
        state.name = connection.name
        state.token = store.token(for: connection) ?? ""
        state.error = nil
    }

    func token(for connection: SavedConnection) -> String {
        store.token(for: connection) ?? ""
    }

    /// Save edits to a saved connection. Does not verify the new address/token —
    /// the next connect attempt does, exactly like a fresh connection.
    @discardableResult
    func update(_ connection: SavedConnection, name: String, address: String, token: String) -> Bool {
        guard let updated = store.update(connection, name: name, rawURL: address, token: token) else {
            state.error = "保存失败：请检查地址格式，并填写 token"
            return false
        }

        state.error = nil
        state.saved = store.savedConnections

        // Editing the connection this launch is using: rebuild the client in place so
        // the new address/token takes effect without going back through connect.
        if DaemonSession.shared.connection?.id == connection.id {
            _ = DaemonSession.shared.activate(updated)
        }

        // Keep the form in sync when it is showing this entry.
        if state.address == connection.baseUrl {
            state.address = updated.baseUrl
            state.token = store.token(for: updated) ?? ""
            state.name = updated.name
        }
        return true
    }

    func forget(_ connection: SavedConnection) {
        store.forget(connection)
        state.saved = store.savedConnections
    }

    func connect() {
        guard !state.isConnecting else { return }

        let address = state.address
        let token = state.token
        let name = state.name

        state.isConnecting = true
        state.error = nil

        Task {
            defer { state.isConnecting = false }

            do {
                let result = try await repository.test(rawURL: address, token: token)
                guard let connection = store.remember(
                    name: name,
                    rawURL: address,
                    token: token,
                    serverId: result.serverId
                ) else {
                    state.error = "无法保存连接（Keychain 写入失败）"
                    return
                }

                guard DaemonSession.shared.activate(connection) != nil else {
                    state.error = "连接已保存，但无法读取 token，请重试"
                    return
                }

                state.saved = store.savedConnections
                onConnected?(connection)
            } catch {
                state.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
