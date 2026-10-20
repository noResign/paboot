import Foundation
import PabootClient
import PabootProtocol

enum ChatRepositoryError: Error, Equatable {
    case notConnected
    case unauthorized
    case failed(String)
}

extension ChatRepositoryError: LocalizedError {
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

/// Everything the chat screen needs from the daemon.
final class ChatRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func sessionDetail(id: String) async throws -> SessionDetailResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.session(id: id)
        } catch {
            throw map(error)
        }
    }

    func runEvents(runId: String, after: Int64? = nil) async throws -> [SSEFrame] {
        let client = try clientOrThrow()
        do {
            return try await client.api.runEvents(id: runId, after: after).events
        } catch {
            throw map(error)
        }
    }

    /// `nil` means the probe itself failed (daemon unreachable): keep retrying.
    func isRunActive(runId: String) async -> Bool? {
        guard let client = session.client else { return nil }
        do {
            let response = try await client.api.runs()
            return response.runs.contains { $0.id == runId }
        } catch {
            return nil
        }
    }

    func chat(_ request: ChatRequest) -> AsyncThrowingStream<SSEFrame, Error> {
        guard let client = session.client else {
            return failedStream(ChatRepositoryError.notConnected)
        }
        return client.stream.chat(request)
    }

    func runStream(runId: String, after: Int64?) -> AsyncThrowingStream<SSEFrame, Error> {
        guard let client = session.client else {
            return failedStream(ChatRepositoryError.notConnected)
        }
        return client.stream.runStream(runId: runId, after: after)
    }

    func cancelRun(id: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.cancelRun(id: id)
        } catch {
            throw map(error)
        }
    }

    func decidePermission(id: String, decision: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.decidePermission(id: id, decision: decision)
        } catch {
            throw map(error)
        }
    }

    func updateModel(
        sessionId: String,
        model: String?,
        parameters: [String: String]?
    ) async throws -> SessionDto? {
        let client = try clientOrThrow()
        do {
            let response = try await client.api.updateSessionModel(
                id: sessionId,
                body: UpdateSessionModelRequest(model: model, modelParameters: parameters)
            )
            return response.session
        } catch {
            throw map(error)
        }
    }

    func updatePermissionMode(sessionId: String, mode: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.updateSessionPermissions(id: sessionId, mode: mode)
        } catch {
            throw map(error)
        }
    }

    func models(agentId: String) async throws -> [ModelOptionDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.models(agentId: agentId).models
        } catch {
            throw map(error)
        }
    }

    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw ChatRepositoryError.notConnected
        }
        return client
    }

    private func failedStream(_ error: Error) -> AsyncThrowingStream<SSEFrame, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: error)
        }
    }

    private func map(_ error: Error) -> ChatRepositoryError {
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
