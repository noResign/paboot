#if canImport(Darwin)
import Foundation
import PabootProtocol

/// One error type for the whole transport. UI-facing text is produced here so callers do not
/// each invent their own mapping.
public enum PabootError: Error, Equatable, Sendable {
    case invalidURL
    /// Connection-level failure. The message is already user-readable and never contains the token.
    case transport(String)
    case invalidResponse
    case http(status: Int, error: ApiError?)
    case decoding(String)
    case cancelled
}

extension PabootError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "地址格式不正确"
        case .transport(let message):
            return "网络请求失败：\(message)"
        case .invalidResponse:
            return "服务端返回了无法识别的响应"
        case .http(let status, let error):
            if let error {
                return error.message ?? error.error
            }
            return "HTTP \(status)"
        case .decoding(let message):
            return "解析响应失败：\(message)"
        case .cancelled:
            return "请求已取消"
        }
    }
}
#endif
