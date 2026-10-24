import Foundation
import PabootClient
import PabootProtocol

/// Reads and mutates scheduled tasks through the active daemon connection.
final class ScheduledTaskRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func list(workspaceId: String?, sessionId: String? = nil) async throws -> [ScheduledTaskDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.scheduledTasks(
                workspaceId: workspaceId,
                sessionId: sessionId
            ).tasks
        } catch {
            throw map(error)
        }
    }

    func detail(id: String) async throws -> ScheduledTaskDetailResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.scheduledTask(id: id)
        } catch {
            throw map(error)
        }
    }

    func startConfigSession(workspaceId: String?) async throws -> TaskConfigSessionResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.startTaskConfigSession(workspaceId: workspaceId)
        } catch {
            throw map(error)
        }
    }

    func update(id: String, body: UpdateScheduledTaskRequest) async throws -> ScheduledTaskDto {
        let client = try clientOrThrow()
        do {
            return try await client.api.updateScheduledTask(id: id, body: body).task
        } catch {
            throw map(error)
        }
    }

    func setEnabled(id: String, enabled: Bool) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.updateScheduledTask(
                id: id,
                body: UpdateScheduledTaskRequest(enabled: enabled)
            )
        } catch {
            throw map(error)
        }
    }

    func runNow(id: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.runScheduledTaskNow(id: id)
        } catch {
            throw map(error)
        }
    }

    func delete(id: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.deleteScheduledTask(id: id)
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
