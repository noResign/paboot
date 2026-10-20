import Foundation
import PabootClient
import PabootProtocol

struct SessionListSnapshot {
    let workspaces: [WorkspaceDto]
    let sessions: [SessionDto]
}

enum SessionRepositoryError: Error, Equatable {
    case notConnected
    case unauthorized
    case failed(String)
}

extension SessionRepositoryError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "当前没有连接，请先连接 daemon"
        case .unauthorized:
            return "token 已失效，请重新连接 daemon"
        case .failed(let message):
            return message
        }
    }
}

/// Reads the session list for the active daemon and performs list mutations.
final class SessionRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func load() async throws -> SessionListSnapshot {
        let client = try clientOrThrow()

        do {
            async let workspacesRequest = client.api.workspaces()
            async let sessionsRequest = client.api.sessions()
            let workspaces = try await workspacesRequest
            let sessions = try await sessionsRequest
            return SessionListSnapshot(
                workspaces: workspaces.workspaces,
                sessions: sessions.sessions
            )
        } catch {
            throw map(error)
        }
    }

    func rename(id: String, title: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.renameSession(id: id, title: title)
        } catch {
            throw map(error)
        }
    }

    func delete(id: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.deleteSession(id: id)
        } catch {
            throw map(error)
        }
    }

    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw SessionRepositoryError.notConnected
        }
        return client
    }

    private func map(_ error: Error) -> SessionRepositoryError {
        guard let error = error as? PabootError else {
            return .failed(error.localizedDescription)
        }

        switch error {
        case .http(let status, _) where status == 401 || status == 403:
            return .unauthorized
        case .http(let status, let apiError):
            return .failed(apiError?.message ?? apiError?.error ?? "HTTP \(status)")
        case .transport, .invalidResponse, .invalidURL, .decoding, .cancelled:
            return .failed(error.localizedDescription)
        }
    }
}
