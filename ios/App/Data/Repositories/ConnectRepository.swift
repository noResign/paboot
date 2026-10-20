import Foundation
import PabootClient
import PabootProtocol

struct ConnectResult: Equatable {
    let serverId: String?
    let service: String?
    let version: String?
    let workspace: String?
    let sessionCount: Int
}

enum ConnectError: Error, Equatable {
    case invalidAddress
    case missingToken
    case unauthorized
    case unreachable(String)
    case failed(String)
}

extension ConnectError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .invalidAddress:
            return "地址格式不正确，例如 192.168.1.2:4780"
        case .missingToken:
            return "请填写 token"
        case .unauthorized:
            return "token 无效或已过期"
        case .unreachable(let message):
            return "连不上 daemon：\(message)"
        case .failed(let message):
            return message
        }
    }
}

/// Verifies a daemon connection end-to-end:
/// 1. `GET /api/health` — reachability + daemon identity (no auth);
/// 2. `GET /api/sessions` — token validation (Bearer auth).
final class ConnectRepository {
    func test(rawURL: String, token: String) async throws -> ConnectResult {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else { throw ConnectError.missingToken }
        guard let url = URLNormalizer.normalize(rawURL) else { throw ConnectError.invalidAddress }

        let client = PabootClient(location: DaemonLocation(baseURL: url, token: trimmedToken))

        let health: HealthDto
        do {
            health = try await client.api.health()
        } catch {
            throw map(error)
        }
        guard health.ok else {
            throw ConnectError.failed("daemon 返回异常状态（ok=false）")
        }

        let sessions: SessionsResponse
        do {
            sessions = try await client.api.sessions()
        } catch {
            throw map(error)
        }

        return ConnectResult(
            serverId: health.serverId,
            service: health.service,
            version: health.version,
            workspace: health.workspace,
            sessionCount: sessions.sessions.count
        )
    }

    private func map(_ error: Error) -> ConnectError {
        guard let error = error as? PabootError else {
            return .failed(error.localizedDescription)
        }

        switch error {
        case .http(let status, _) where status == 401 || status == 403:
            return .unauthorized
        case .http(let status, _) where status == 404:
            return .failed("这个地址不是 paboot daemon（HTTP 404）")
        case .http(let status, let apiError):
            return .failed(apiError?.message ?? apiError?.error ?? "HTTP \(status)")
        case .transport, .invalidResponse:
            return .unreachable(error.localizedDescription)
        case .invalidURL:
            return .invalidAddress
        case .decoding:
            return .failed("无法解析 daemon 响应，版本可能不兼容")
        case .cancelled:
            return .failed("连接已取消")
        }
    }
}
