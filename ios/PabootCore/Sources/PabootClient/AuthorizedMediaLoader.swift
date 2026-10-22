#if canImport(Darwin) && canImport(AVFoundation)
import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// Streams an authenticated daemon file into `AVPlayer`.
///
/// AVFoundation only routes requests through `AVAssetResourceLoader` for schemes it does
/// not handle itself, so the asset is created with a private scheme and every request
/// (including the ranged ones AVPlayer uses while seeking) is replayed here with the
/// `Authorization` header. The token stays in memory: it never appears in a URL or on disk.
public final class AuthorizedMediaLoader: NSObject, AVAssetResourceLoaderDelegate {
    private static let scheme = "paboot-media"

    private let remoteURL: URL
    private let token: String
    /// Runs both the resource-loader and the URLSession delegate callbacks, so the
    /// in-flight map needs no locking.
    private let queue = DispatchQueue(label: "paboot.media-loader")
    private lazy var sessionDelegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "paboot.media-loader.session"
        queue.maxConcurrentOperationCount = 1
        queue.underlyingQueue = self.queue
        return queue
    }()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        // Media arrives in ranges; caching them only grows memory.
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: sessionDelegateQueue)
    }()
    private var inFlight: [Int: PendingRequest] = [:]

    private final class PendingRequest {
        let loadingRequest: AVAssetResourceLoadingRequest
        let task: URLSessionDataTask

        init(_ loadingRequest: AVAssetResourceLoadingRequest, task: URLSessionDataTask) {
            self.loadingRequest = loadingRequest
            self.task = task
        }
    }

    public init(url: URL, token: String) {
        self.remoteURL = url
        self.token = token
        super.init()
        // Create the session before any resource-loader callback can touch the
        // lazy property off the main thread.
        _ = session
    }

    /// Call once per playback session; the URLSession retains its delegate until invalidated.
    public func invalidate() {
        session.invalidateAndCancel()
    }

    /// An asset whose private-scheme URL can only be resolved by this loader.
    public func makeAsset() -> AVURLAsset {
        var components = URLComponents(url: remoteURL, resolvingAgainstBaseURL: false)
        components?.scheme = Self.scheme
        let asset = AVURLAsset(url: components?.url ?? remoteURL)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    // MARK: - AVAssetResourceLoaderDelegate

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        var request = URLRequest(url: remoteURL)
        // A content-information probe has no data request; HEAD avoids downloading bytes.
        request.httpMethod = loadingRequest.dataRequest == nil ? "HEAD" : "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let range = loadingRequest.request.value(forHTTPHeaderField: "Range") {
            request.setValue(range, forHTTPHeaderField: "Range")
        } else if let dataRequest = loadingRequest.dataRequest {
            // Some requests carry their offset only on the data request.
            let offset = dataRequest.requestedOffset
            if dataRequest.requestsAllDataToEndOfResource || dataRequest.requestedLength <= 0 {
                request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range")
            } else {
                let end = offset + Int64(dataRequest.requestedLength) - 1
                request.setValue("bytes=\(offset)-\(end)", forHTTPHeaderField: "Range")
            }
        }

        let task = session.dataTask(with: request)
        inFlight[task.taskIdentifier] = PendingRequest(loadingRequest, task: task)
        task.resume()
        return true
    }

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        guard let entry = inFlight.first(where: { $0.value.loadingRequest === loadingRequest }) else {
            return
        }
        entry.value.task.cancel()
        inFlight.removeValue(forKey: entry.key)
    }

    private static func totalLength(of response: HTTPURLResponse) -> Int64? {
        if response.statusCode == 206 {
            // A ranged response reports the full size after the slash. Without a
            // usable total, `expectedContentLength` is only the range length and
            // must not be reported as the asset size.
            guard let contentRange = response.value(forHTTPHeaderField: "Content-Range"),
                  let total = contentRange.split(separator: "/").last,
                  let value = Int64(total) else {
                return nil
            }
            return value
        }
        let length = response.expectedContentLength
        return length > 0 ? length : nil
    }
}

extension AuthorizedMediaLoader: URLSessionDataDelegate {
    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let entry = inFlight[dataTask.taskIdentifier] else {
            completionHandler(.cancel)
            return
        }
        guard let http = response as? HTTPURLResponse else {
            entry.loadingRequest.finishLoading(with: MediaLoaderError.invalidResponse)
            inFlight.removeValue(forKey: dataTask.taskIdentifier)
            completionHandler(.cancel)
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            entry.loadingRequest.finishLoading(with: MediaLoaderError.http(http.statusCode))
            inFlight.removeValue(forKey: dataTask.taskIdentifier)
            completionHandler(.cancel)
            return
        }

        if let information = entry.loadingRequest.contentInformationRequest {
            information.isByteRangeAccessSupported = http.statusCode == 206
                || http.value(forHTTPHeaderField: "Accept-Ranges")?.lowercased() == "bytes"
            if let length = Self.totalLength(of: http) {
                information.contentLength = length
            }
            if let mimeType = http.mimeType, let type = UTType(mimeType: mimeType) {
                information.contentType = type.identifier
            }
        }
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        inFlight[dataTask.taskIdentifier]?.loadingRequest.dataRequest?.respond(with: data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let entry = inFlight.removeValue(forKey: task.taskIdentifier) else { return }
        if let error {
            entry.loadingRequest.finishLoading(with: error)
        } else {
            entry.loadingRequest.finishLoading()
        }
    }
}

private enum MediaLoaderError: LocalizedError {
    case invalidResponse
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "媒体响应无效"
        case .http(let status):
            return "媒体加载失败（HTTP \(status)）"
        }
    }
}
#endif
