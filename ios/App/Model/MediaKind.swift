import Foundation

/// How a file should be previewed. Decided by extension, mirroring Android's `MediaKind`.
enum MediaKind: Equatable {
    case image
    case video
    case text

    static func forPath(_ path: String) -> MediaKind {
        switch (path as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic", "heif", "tiff", "tif":
            return .image
        case "mp4", "m4v", "mov", "webm", "mkv", "3gp":
            return .video
        default:
            return .text
        }
    }
}
