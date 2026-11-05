import Foundation
import PabootClient
import PabootProtocol

/// K0 knowledge: auto-collected; mobile only toggles the verification marker.
final class KnowledgeRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func list(
        workspaceId: String,
        status: String? = nil,
        verified: Bool? = nil,
        query: String? = nil
    ) async throws -> [KnowledgeDocDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.knowledge(
                workspaceId: workspaceId,
                status: status,
                verified: verified,
                query: query
            ).documents
        } catch {
            throw map(error)
        }
    }

    func detail(workspaceId: String, id: String) async throws -> KnowledgeDocDetailDto {
        let client = try clientOrThrow()
        do {
            guard let document = try await client.api.knowledgeDoc(workspaceId: workspaceId, id: id).document else {
                throw WorkspaceRepositoryError.failed("daemon 未返回文档")
            }
            return document
        } catch let error as WorkspaceRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
    }

    func setVerified(workspaceId: String, id: String, verified: Bool) async throws -> KnowledgeDocDto {
        let client = try clientOrThrow()
        do {
            guard let document = try await client.api.verifyKnowledge(
                workspaceId: workspaceId,
                id: id,
                verified: verified
            ).document else {
                throw WorkspaceRepositoryError.failed("daemon 未返回文档")
            }
            return document
        } catch let error as WorkspaceRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
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
