import Foundation
import PabootClient

/// The daemon connection active in this launch.
///
/// `ConnectionStore` owns persistence; this type turns the active saved connection into a
/// `PabootClient` that repositories share. It is set only after a successful connect, and
/// cleared when the user is sent back to the connect screen.
final class DaemonSession {
    static let shared = DaemonSession()

    private let store: ConnectionStore
    private(set) var connection: SavedConnection?
    private(set) var client: PabootClient?

    init(store: ConnectionStore = .shared) {
        self.store = store
    }

    @discardableResult
    func activate(_ connection: SavedConnection) -> PabootClient? {
        guard let token = store.token(for: connection),
              let url = URL(string: connection.baseUrl) else {
            deactivate()
            return nil
        }

        let client = PabootClient(location: DaemonLocation(baseURL: url, token: token))
        self.connection = connection
        self.client = client
        return client
    }

    func deactivate() {
        connection = nil
        client = nil
    }
}
