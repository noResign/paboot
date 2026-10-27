import Foundation
import PabootClient
import PabootProtocol

enum WorkspaceRepositoryError: Error, Equatable {
    case notConnected
    case unauthorized
    case failed(String)
}

extension WorkspaceRepositoryError: LocalizedError {
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

/// Workspace, config and directory-browsing calls for the settings screens.
final class WorkspaceRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func health() async throws -> HealthDto {
        let client = try clientOrThrow()
        do {
            return try await client.api.health()
        } catch {
            throw map(error)
        }
    }

    func listWorkspaces() async throws -> [WorkspaceDto] {
        let client = try clientOrThrow()
        do {
            return try await client.api.workspaces().workspaces
        } catch {
            throw map(error)
        }
    }

    func config() async throws -> ConfigResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.config()
        } catch {
            throw map(error)
        }
    }

    func updateConfig(defaultPermissionMode: String) async throws -> ConfigUpdateResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.updateConfig(
                UpdateConfigRequest(defaultPermissionMode: defaultPermissionMode)
            )
        } catch {
            throw map(error)
        }
    }

    /// Creates a workspace. Returns the created workspace or an error message for the caller.
    func createWorkspace(path: String, name: String? = nil) async throws -> WorkspaceDto {
        let client = try clientOrThrow()
        do {
            let response = try await client.api.createWorkspace(
                CreateWorkspaceRequest(name: name, path: path)
            )
            guard let workspace = response.workspace else {
                throw WorkspaceRepositoryError.failed("daemon 未返回工作区信息")
            }
            return workspace
        } catch let error as WorkspaceRepositoryError {
            throw error
        } catch {
            throw map(error)
        }
    }

    func updateWorkspace(
        id: String,
        name: String? = nil,
        enabled: Bool? = nil
    ) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.updateWorkspace(
                id: id,
                body: UpdateWorkspaceRequest(name: name, enabled: enabled)
            )
        } catch {
            throw map(error)
        }
    }

    func deleteWorkspace(id: String, cascade: Bool) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.deleteWorkspace(id: id, cascade: cascade)
        } catch {
            throw map(error)
        }
    }

    func addDir(workspaceId: String, path: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.addWorkspaceDir(id: workspaceId, path: path)
        } catch {
            throw map(error)
        }
    }

    func removeDir(workspaceId: String, path: String) async throws {
        let client = try clientOrThrow()
        do {
            _ = try await client.api.removeWorkspaceDir(id: workspaceId, path: path)
        } catch {
            throw map(error)
        }
    }

    /// Returns the complete shortcut list after the change.
    func addShortcut(workspaceId: String, path: String) async throws -> [String] {
        let client = try clientOrThrow()
        do {
            return try await client.api.addWorkspaceShortcut(id: workspaceId, path: path).shortcutDirs
        } catch {
            throw map(error)
        }
    }

    /// Returns the complete shortcut list after the change.
    func removeShortcut(workspaceId: String, path: String) async throws -> [String] {
        let client = try clientOrThrow()
        do {
            return try await client.api.removeWorkspaceShortcut(id: workspaceId, path: path).shortcutDirs
        } catch {
            throw map(error)
        }
    }

    func directories(path: String?, showHidden: Bool) async throws -> DirectoriesResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.directories(path: path, showHidden: showHidden)
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
            return .failed(friendlyMessage(apiError: apiError, status: status))
        case .transport, .invalidResponse, .invalidURL, .decoding, .cancelled:
            return .failed(error.localizedDescription)
        }
    }

    private func friendlyMessage(apiError: ApiError?, status: Int) -> String {
        switch apiError?.code {
        case "workspace_exists":
            return "该目录已经是工作区"
        case "workspace_not_found":
            return "工作区不存在，可能已经被删除"
        case "workspace_is_default":
            return "最后一个工作区不能删除，请先添加另一个工作区"
        case "workspace_is_builtin":
            return "这是内置的默认工作区，不能删除或停用"
        case "workspace_not_empty":
            return "工作区里还有会话，需要选择同时删除会话"
        case "workspace_disabled":
            return "该工作区已停用"
        case "directory_not_found", "invalid_directory":
            return "目录不存在或不可访问"
        case "primary_dir":
            return "主目录不能同时作为附加目录"
        case "dir_exists":
            return "该目录已经在附加目录里"
        case "shortcut_exists":
            return "该目录已经在标签栏上"
        case "bad_request":
            return apiError?.message ?? apiError?.error ?? "请求参数不正确"
        default:
            return apiError?.message ?? apiError?.error ?? "HTTP \(status)"
        }
    }
}
