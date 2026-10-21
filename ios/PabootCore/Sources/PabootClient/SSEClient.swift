#if canImport(Darwin)
import Foundation
import PabootProtocol

/// Streams raw SSE bytes from `URLSession`, preserving blank event delimiters.
///
/// Cancelling the returned stream cancels the underlying task/connection. That only closes
/// the stream — it does **not** cancel the run on the daemon; use `POST /api/runs/:id/cancel`.
public final class SSEClient {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
            return
        }
        let configuration = URLSessionConfiguration.default
        // The daemon sends `: keepalive` every 15s, so 60s without a byte means a dead link.
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60 * 60 * 24 * 7
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
    }

    public func stream(_ request: URLRequest) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw PabootError.invalidResponse
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        let data = try await Self.collect(bytes, limit: 64 * 1024)
                        let apiError = try? JSONDecoder().decode(ApiError.self, from: data)
                        throw PabootError.http(status: http.statusCode, error: apiError)
                    }

                    let parser = SSEByteParser()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if let event = parser.feed(byte) {
                            continuation.yield(event)
                        }
                    }
                    if let event = parser.flush() {
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: PabootError.cancelled)
                } catch let error as PabootError {
                    continuation.finish(throwing: error)
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish(throwing: PabootError.cancelled)
                } catch {
                    continuation.finish(throwing: PabootError.transport(error.localizedDescription))
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Read a bounded error body so a 409 can still surface its `{error, code}` payload.
    private static func collect(_ bytes: URLSession.AsyncBytes, limit: Int) async throws -> Data {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= limit {
                break
            }
        }
        return data
    }
}
#endif
