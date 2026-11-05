import Foundation
import PabootClient
import PabootProtocol

enum ProviderRepositoryError: Error, Equatable {
    case notConnected
    case unauthorized
    case failed(String)
}

extension ProviderRepositoryError: LocalizedError {
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

/// Shared LLM provider catalog management. API keys remain write-only.
final class ProviderRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func list() async throws -> [ProviderDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.providers().providers
        } catch {
            throw map(error)
        }
    }

    func create(_ body: ProviderCreateRequest) async throws -> ProviderDto {
        let client = try clientOrThrow()
        do {
            guard let provider = try await client.api.createProvider(body).provider else {
                throw ProviderRepositoryError.failed("daemon 未返回 provider")
            }
            return provider
        } catch let error as ProviderRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
    }

    func update(id: String, body: ProviderUpdateRequest) async throws -> ProviderDto {
        let client = try clientOrThrow()
        do {
            guard let provider = try await client.api.updateProvider(id: id, body: body).provider else {
                throw ProviderRepositoryError.failed("daemon 未返回 provider")
            }
            return provider
        } catch let error as ProviderRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
    }

    func delete(id: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.deleteProvider(id: id)
        } catch {
            throw map(error)
        }
    }

    func test(id: String) async throws -> ProviderTestResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.testProvider(id: id)
        } catch {
            throw map(error)
        }
    }

    func refreshModels(id: String) async throws -> ProviderDto {
        let client = try clientOrThrow()
        do {
            guard let provider = try await client.api.refreshProviderModels(id: id).provider else {
                throw ProviderRepositoryError.failed("daemon 未返回 provider")
            }
            return provider
        } catch let error as ProviderRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
    }

    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw ProviderRepositoryError.notConnected
        }
        return client
    }

    private func map(_ error: Error) -> ProviderRepositoryError {
        guard let error = error as? PabootError else {
            return .failed(error.localizedDescription)
        }
        switch error {
        case .http(let status, _) where status == 401 || status == 403:
            return .unauthorized
        case .http(let status, let apiError):
            return .failed(friendlyMessage(apiError: apiError, status: status))
        case .transport, .invalidResponse, .invalidURL, .decoding, .cancelled:
            return .failed(error.localizedDescription)
        }
    }

    private func friendlyMessage(apiError: ApiError?, status: Int) -> String {
        switch apiError?.code {
        case "provider_exists":
            return "该 Provider id 已存在"
        case "provider_is_builtin":
            return "内置 Provider 不能删除；可以清空 Key 或停用模型"
        case "provider_not_found":
            return "Provider 不存在，可能已经被删除"
        case "provider_api_key_missing":
            return "请先配置 API Key"
        case "provider_test_timeout":
            return "连接测试超时"
        case "provider_test_failed":
            return apiError?.message ?? apiError?.error ?? "Provider 连接测试失败"
        case "provider_models_empty":
            return "Provider 没有返回任何模型"
        case "bad_request":
            return apiError?.message ?? apiError?.error ?? "请求参数不正确"
        default:
            return apiError?.message ?? apiError?.error ?? "HTTP \(status)"
        }
    }
}
