import Foundation
import PabootClient
import PabootProtocol

enum SessionPermissionRepositoryError: Error, Equatable {
    case notConnected
    case unauthorized
    case failed(String)
}

extension SessionPermissionRepositoryError: LocalizedError {
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

/// Session-level permission mode and "allow all" grants.
final class SessionPermissionRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func permissions(sessionId: String) async throws -> SessionPermissionsResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.sessionPermissions(id: sessionId)
        } catch {
            throw map(error)
        }
    }

    func updateMode(sessionId: String, mode: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.updateSessionPermissions(id: sessionId, mode: mode)
        } catch {
            throw map(error)
        }
    }

    func revokeGrant(sessionId: String, toolName: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.deletePermissionGrant(sessionId: sessionId, toolName: toolName)
        } catch {
            throw map(error)
        }
    }

    func revokeAll(sessionId: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.deletePermissionGrants(sessionId: sessionId)
        } catch {
            throw map(error)
        }
    }

    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw SessionPermissionRepositoryError.notConnected
        }
        return client
    }

    private func map(_ error: Error) -> SessionPermissionRepositoryError {
        guard let error = error as? PabootError else {
            return .failed(error.localizedDescription)
        }

        switch error {
        case .http(let status, _) where status == 401 || status == 403:
            return .unauthorized
        case .http(let status, let apiError):
            if apiError?.code == "session_not_found" {
                return .failed("会话不存在，可能已经被删除")
            }
            return .failed(apiError?.message ?? apiError?.error ?? "HTTP \(status)")
        case .transport, .invalidResponse, .invalidURL, .decoding, .cancelled:
            return .failed(error.localizedDescription)
        }
    }
}
