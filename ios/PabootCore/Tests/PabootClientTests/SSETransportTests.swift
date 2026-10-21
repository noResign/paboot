#if canImport(Darwin)
import Foundation
import XCTest
import PabootClient
import PabootProtocol

final class SSETransportTests: XCTestCase {
    func testPOSTDeliversReplyWhileResponseRemainsOpen() async throws {
        try await assertLiveFrames(isChat: true)
    }

    func testRunAttachDeliversReplyWhileResponseRemainsOpen() async throws {
        try await assertLiveFrames(isChat: false)
    }

    private func assertLiveFrames(isChat: Bool) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OpenSSEProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let location = DaemonLocation(baseURL: try XCTUnwrap(URL(string: "https://sse.test")), token: "test")
        let stream = PabootStream(location: location, sse: SSEClient(session: session))
        let received = expectation(description: "two frames before EOF")
        let consumer = Task {
            let source = isChat
                ? stream.chat(ChatRequest(prompt: "hello", commandId: "command-1"))
                : stream.runStream(runId: "r1", after: 0)
            var frames: [SSEFrame] = []
            for try await frame in source {
                frames.append(frame)
                if frames.count == 2 {
                    received.fulfill()
                    return frames
                }
            }
            return frames
        }
        await fulfillment(of: [received], timeout: 3)
        consumer.cancel()
        let frames = try await consumer.value
        XCTAssertEqual(frames.map(\.seq), [1, 2])
        let last = try XCTUnwrap(frames.last)
        guard case .textDelta(let delta) = last.event else {
            return XCTFail("expected text delta")
        }
        XCTAssertEqual(delta.delta, "你好")
    }
}

/// Delivers the daemon's framing but deliberately never calls urlProtocolDidFinishLoading.
/// A client that buffers until EOF or loses blank delimiters will time out in the tests.
private final class OpenSSEProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "sse.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": "text/event-stream"]) else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let wire = ": connected\n\n"
            + "id: 1\ndata: {\"runId\":\"r1\",\"seq\":1,\"event\":{\"type\":\"status\",\"label\":\"starting\"}}\n\n"
            + ": keepalive\n\n"
            + "id: 2\ndata: {\"runId\":\"r1\",\"seq\":2,\"event\":{\"type\":\"text_delta\",\"delta\":\"你好\"}}\n\n"
        let data = Data(wire.utf8)
        for offset in stride(from: 0, to: data.count, by: 7) {
            client?.urlProtocol(self, didLoad: data.subdata(in: offset..<min(offset + 7, data.count)))
        }
    }

    override func stopLoading() {}
}
#endif
