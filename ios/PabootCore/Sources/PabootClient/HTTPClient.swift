#if canImport(Darwin)
import Foundation
import PabootProtocol

/// Thin `URLSession` wrapper: status validation, error-body decoding, JSON decoding.
public final class HTTPClient {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, _) = try await send(request)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw PabootError.decoding(String(describing: error))
        }
    }

    /// Sends the request and returns a 2xx body. Non-2xx responses become `.http` with the
    /// daemon's `{error, code, message}` body when it parses.
    @discardableResult
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw PabootError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                let apiError = try? JSONDecoder().decode(ApiError.self, from: data)
                throw PabootError.http(status: http.statusCode, error: apiError)
            }
            return (data, http)
        } catch let error as PabootError {
            throw error
        } catch let error as URLError where error.code == .cancelled {
            throw PabootError.cancelled
        } catch {
            throw PabootError.transport(error.localizedDescription)
        }
    }
}
#endif
