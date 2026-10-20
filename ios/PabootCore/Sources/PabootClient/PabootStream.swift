#if canImport(Darwin)
import Foundation
import PabootProtocol

/// SSE streams: the initial chat request and the replay/attach stream for an existing run.
///
/// A run survives a dropped connection. After losing either stream, callers reconnect with
/// `runStream(runId:after:)` using the last `seq` they saw. If the connection died before the
/// first frame (so no `runId` is known), re-send the same `ChatRequest` with the same
/// `commandId` — the daemon replays the run it already started instead of creating a new one.
public final class PabootStream {
    private let location: DaemonLocation
    private let sse: SSEClient

    public init(location: DaemonLocation, sse: SSEClient = SSEClient()) {
        self.location = location
        self.sse = sse
    }

    public func chat(_ request: ChatRequest) -> AsyncThrowingStream<SSEFrame, Error> {
        do {
            var urlRequest = try makeRequest(method: "POST", path: "api/chat")
            urlRequest.httpBody = try JSONEncoder().encode(request)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            return frames(from: urlRequest)
        } catch {
            return failedStream(error)
        }
    }

    public func runStream(runId: String, after: Int64? = nil) -> AsyncThrowingStream<SSEFrame, Error> {
        var query: [URLQueryItem] = []
        if let after {
            query.append(URLQueryItem(name: "after", value: String(after)))
        }
        do {
            let request = try makeRequest(
                method: "GET",
                path: "api/runs/\(runId)/stream",
                query: query
            )
            return frames(from: request)
        } catch {
            return failedStream(error)
        }
    }

    private func makeRequest(
        method: String,
        path: String,
        query: [URLQueryItem] = []
    ) throws -> URLRequest {
        guard var components = URLComponents(
            url: location.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw PabootError.invalidURL
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else {
            throw PabootError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(location.token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return request
    }

    private func frames(from request: URLRequest) -> AsyncThrowingStream<SSEFrame, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let decoder = JSONDecoder()
                do {
                    for try await event in sse.stream(request) {
                        guard let data = event.data.data(using: .utf8) else { continue }
                        // A malformed frame is skipped rather than killing the whole stream.
                        guard let frame = try? decoder.decode(SSEFrame.self, from: data) else { continue }
                        continuation.yield(frame)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private func failedStream(_ error: Error) -> AsyncThrowingStream<SSEFrame, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: error)
        }
    }
}
#endif
