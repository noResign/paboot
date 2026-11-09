import Foundation
import PabootClient
import PabootProtocol

/// Memory M0: life claims read + correct / forget. Configuration stays on desktop.
final class MemoryRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func list(workspaceId: String) async throws -> [MemoryClaimDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.memoryClaims(scope: scope(workspaceId)).claims
        } catch {
            throw map(error)
        }
    }

    func status(workspaceId: String) async throws -> MemoryStatusDto {
        let client = try clientOrThrow()
        do {
            return try await client.api.memoryStatus(scope: scope(workspaceId))
        } catch {
            throw map(error)
        }
    }

    func settings(workspaceId: String) async throws -> WorkspaceMemoryDto {
        let client = try clientOrThrow()
        do {
            return try await client.api.workspaceMemory(id: workspaceId)
        } catch {
            throw map(error)
        }
    }

    func duplicates(workspaceId: String) async throws -> [MemoryDuplicateDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.memoryDuplicates(scope: scope(workspaceId)).duplicates
        } catch {
            throw map(error)
        }
    }

    func disputes(workspaceId: String) async throws -> [MemoryDisputeDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.memoryDisputes(scope: scope(workspaceId)).disputes
        } catch {
            throw map(error)
        }
    }

    func entities(workspaceId: String) async throws -> [MemoryEntityDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.memoryEntities(scope: scope(workspaceId)).entities
        } catch {
            throw map(error)
        }
    }

    func timeline(workspaceId: String) async throws -> [MemoryTimelineItemDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.memoryTimeline(scope: scope(workspaceId)).items
        } catch {
            throw map(error)
        }
    }

    func correct(
        workspaceId: String,
        id: String,
        summary: String,
        objectText: String
    ) async throws -> MemoryClaimDto {
        let client = try clientOrThrow()
        do {
            guard let claim = try await client.api.correctMemoryClaim(
                id: id,
                scope: scope(workspaceId),
                summary: summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : summary,
                objectText: objectText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : objectText
            ).claim else {
                throw WorkspaceRepositoryError.failed("daemon 未返回记忆")
            }
            return claim
        } catch let error as WorkspaceRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
    }

    func forget(workspaceId: String, id: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.forgetMemoryClaim(id: id, scope: scope(workspaceId))
        } catch {
            throw map(error)
        }
    }

    private func scope(_ workspaceId: String) -> String {
        "workspace:\(workspaceId)"
    }

    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw WorkspaceRepositoryError.notConnected
        }
        return client
    }

    private func map(_ error: Error) -> WorkspaceRepositoryError {
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
