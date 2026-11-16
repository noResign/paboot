import Foundation

enum AsrClientError: Error {
    case transport(Error)
    case invalidResponse
    case http(status: Int, body: String)
}

/// Direct HTTPS client for DeepSeek ASR. The daemon is not involved; the key
/// comes from the user's settings and is sent only to DeepSeek.
struct DeepSeekAsrClient {
    private static let endpoint = URL(string: "https://api.deepseek.com/v1/tools/asr")!

    func transcribe(apiKey: String, wav: Data) async throws -> AsrTranscriptionDto {
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        let boundary = "PabootASR\(UUID().uuidString)"
        request.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type"
        )
        var body = Data()
        body.append(utf8("--\(boundary)\r\n"))
        body.append(utf8("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n"))
        body.append(utf8("Content-Type: audio/wav\r\n\r\n"))
        body.append(wav)
        body.append(utf8("\r\n--\(boundary)--\r\n"))
        request.httpBody = body

        let result: (Data, URLResponse)
        do {
            result = try await URLSession.shared.data(for: request)
        } catch {
            throw AsrClientError.transport(error)
        }
        let (data, response) = result
        guard let http = response as? HTTPURLResponse else {
            throw AsrClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AsrClientError.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
        do {
            return try JSONDecoder().decode(AsrTranscriptionDto.self, from: data)
        } catch {
            throw AsrClientError.invalidResponse
        }
    }

    private func utf8(_ string: String) -> Data {
        Data(string.utf8)
    }
}
