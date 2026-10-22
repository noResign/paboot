import Foundation
import PabootClient
import PabootProtocol

enum FilesRepositoryError: Error, Equatable {
    case notConnected
    case unauthorized
    case failed(String)
}

extension FilesRepositoryError: LocalizedError {
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

/// Changes, diffs, directory listing and file bytes for the file tab.
protocol FileListingRepository {
    func changes(workspaceId: String?, root: String?) async throws -> ChangesResponse
    func files(workspaceId: String?, root: String?, path: String?, cursor: String?, showHidden: Bool) async throws -> FilesResponse
}

final class FilesRepository: FileListingRepository {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    func changes(workspaceId: String?, root: String?) async throws -> ChangesResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.changes(workspaceId: workspaceId, root: root)
        } catch {
            throw map(error)
        }
    }

    func diff(workspaceId: String?, root: String?, path: String) async throws -> DiffResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.changeDiff(workspaceId: workspaceId, root: root, path: path)
        } catch {
            throw map(error)
        }
    }

    func files(
        workspaceId: String?,
        root: String?,
        path: String?,
        cursor: String?,
        showHidden: Bool
    ) async throws -> FilesResponse {
        let client = try clientOrThrow()
        do {
            return try await client.api.files(
                workspaceId: workspaceId,
                root: root,
                path: path,
                cursor: cursor,
                limit: 200,
                showHidden: showHidden
            )
        } catch {
            throw map(error)
        }
    }

    func content(workspaceId: String?, root: String?, path: String) async throws -> FileContentDto {
        let client = try clientOrThrow()
        do {
            return try await client.api.fileContent(workspaceId: workspaceId, root: root, path: path)
        } catch {
            throw map(error)
        }
    }

    func raw(workspaceId: String?, root: String?, path: String) async throws -> Data {
        let client = try clientOrThrow()
        do {
            return try await client.api.fileRaw(workspaceId: workspaceId, root: root, path: path)
        } catch {
            throw map(error)
        }
    }

    /// Raw media URL plus the token used by the streaming media loader. The token
    /// travels in a request header, never in the URL.
    func mediaSource(
        workspaceId: String?,
        root: String?,
        path: String
    ) throws -> (url: URL, token: String) {
        let client = try clientOrThrow()
        var query: [URLQueryItem] = [URLQueryItem(name: "path", value: path)]
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let root, !root.isEmpty {
            query.append(URLQueryItem(name: "root", value: root))
        }
        guard var components = URLComponents(
            url: client.location.baseURL.appendingPathComponent("api/files/raw"),
            resolvingAgainstBaseURL: false
        ) else {
            throw FilesRepositoryError.failed("无法构造文件地址")
        }
        components.queryItems = query
        guard let url = components.url else {
            throw FilesRepositoryError.failed("无法构造文件地址")
        }
        return (url, client.location.token)
    }

    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw FilesRepositoryError.notConnected
        }
        return client
    }

    private func map(_ error: Error) -> FilesRepositoryError {
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
        case "workspace_not_found":
            return "工作区不存在，可能已经被删除"
        case "directory_not_found":
            return "目录不存在"
        case "file_not_found":
            return "文件不存在"
        case "not_a_directory":
            return "该路径不是目录"
        case "not_a_file":
            return "该路径不是文件"
        case "path_outside_workspace":
            return "路径必须位于当前根目录内"
        case "directory_not_readable":
            return "目录不可读"
        case "git_unavailable":
            return "daemon 所在电脑上没有可用的 git"
        case "no_checkpoint":
            return "该 run 没有可用的改动快照"
        case "file_not_changed":
            return "该文件在这个 run 中没有改动"
        default:
            return apiError?.message ?? apiError?.error ?? "HTTP \(status)"
        }
    }
}
