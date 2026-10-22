import Combine
import Foundation
import PabootProtocol
import UIKit

/// Loads a file as text, an image, or a streaming video source.
@MainActor
final class FileContentViewModel {
    enum Content {
        case text(FileContentDto)
        case image(UIImage)
        case video(url: URL, token: String)
        case unsupported(String)

        var isVideo: Bool {
            if case .video = self { return true }
            return false
        }
    }

    struct State {
        var isLoading = true
        var error: String?
        var content: Content?
    }

    @Published private(set) var state = State()

    let workspaceId: String?
    let root: String?
    let path: String

    private let repository: FilesRepository

    init(
        workspaceId: String?,
        root: String?,
        path: String,
        repository: FilesRepository = FilesRepository()
    ) {
        self.workspaceId = workspaceId
        self.root = root
        self.path = path
        self.repository = repository
    }

    func load() async {
        state.isLoading = true
        state.error = nil

        defer { state.isLoading = false }

        do {
            switch MediaKind.forPath(path) {
            case .image:
                let data = try await repository.raw(
                    workspaceId: workspaceId,
                    root: root,
                    path: path
                )
                guard let image = UIImage(data: data) else {
                    state.content = .unsupported("无法解码这张图片")
                    return
                }
                state.content = .image(image)
            case .video:
                let source = try repository.mediaSource(
                    workspaceId: workspaceId,
                    root: root,
                    path: path
                )
                state.content = .video(url: source.url, token: source.token)
            case .text:
                let content = try await repository.content(
                    workspaceId: workspaceId,
                    root: root,
                    path: path
                )
                state.content = content.binary
                    ? .unsupported("二进制文件，暂不支持预览")
                    : .text(content)
            }
        } catch {
            state.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
