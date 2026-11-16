import Foundation

enum AsrServiceError: LocalizedError {
    case notConfigured
    case invalidKey
    case insufficientBalance
    case noSpeech
    case network
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "语音识别未配置，请到设置页填写 DeepSeek API Key"
        case .invalidKey:
            return "DeepSeek API Key 无效，请到设置页检查"
        case .insufficientBalance:
            return "DeepSeek 账户余额不足"
        case .noSpeech:
            return "没有识别到语音，请再说一次"
        case .network:
            return "网络错误，无法连接语音识别服务"
        case .failed(let message):
            return message
        }
    }
}

protocol AsrRepositoryProtocol {
    func transcribeAudio(_ data: Data) async throws -> String
}

/// On-device ASR call path: Keychain key → DeepSeek directly. No daemon hop.
final class AsrRepository: AsrRepositoryProtocol {
    private let client = DeepSeekAsrClient()

    func transcribeAudio(_ data: Data) async throws -> String {
        guard let key = AsrKeyStore.apiKey, !key.isEmpty else {
            throw AsrServiceError.notConfigured
        }
        do {
            let dto = try await client.transcribe(apiKey: key, wav: data)
            let text = dto.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw AsrServiceError.noSpeech }
            return text
        } catch let error as AsrServiceError {
            throw error
        } catch let error as AsrClientError {
            switch error {
            case .http(let status, _):
                switch status {
                case 400:
                    throw AsrServiceError.noSpeech
                case 401, 403:
                    throw AsrServiceError.invalidKey
                case 402:
                    throw AsrServiceError.insufficientBalance
                case 413:
                    throw AsrServiceError.failed("录音过长，请缩短后重试")
                case 429:
                    throw AsrServiceError.failed("语音识别请求过于频繁，请稍后再试")
                default:
                    throw AsrServiceError.failed("语音识别服务暂时不可用，请稍后重试")
                }
            case .transport, .invalidResponse:
                throw AsrServiceError.network
            }
        } catch {
            throw AsrServiceError.network
        }
    }
}
