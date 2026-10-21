import Foundation
import XCTest
@testable import PabootProtocol

final class SSEByteParserTests: XCTestCase {
    private func feed(_ text: String, into parser: SSEByteParser) -> [SSEEvent] {
        text.utf8.compactMap { parser.feed($0) }
    }

    func testDaemonFramesAreDeliveredBeforeConnectionCloses() throws {
        let parser = SSEByteParser()
        let wire = ": connected\n\n"
            + "id: 1\ndata: {\"runId\":\"r1\",\"seq\":1,\"event\":{\"type\":\"status\",\"label\":\"starting\"}}\n\n"
            + ": keepalive\n\n"
            + "id: 2\ndata: {\"runId\":\"r1\",\"seq\":2,\"event\":{\"type\":\"text_delta\",\"delta\":\"你好\"}}\n\n"
        // Do not call flush: live replies must arrive while the socket remains open.
        let events = feed(wire, into: parser)
        XCTAssertEqual(events.count, 2)
        let frames = try events.map {
            try JSONDecoder().decode(SSEFrame.self, from: Data($0.data.utf8))
        }
        XCTAssertEqual(frames.map(\.seq), [1, 2])
        let last = try XCTUnwrap(frames.last)
        guard case .textDelta(let delta) = last.event else {
            return XCTFail("expected live text delta")
        }
        XCTAssertEqual(delta.delta, "你好")
    }

    func testAllNetworkSplitPositionsPreserveUTF8AndFrameBoundaries() {
        let wire = Array("data: 你好🌍\n\ndata: next\n\n".utf8)
        for split in 0...wire.count {
            let parser = SSEByteParser()
            let first = wire[..<split].compactMap { parser.feed($0) }
            let second = wire[split...].compactMap { parser.feed($0) }
            XCTAssertEqual((first + second).map(\.data), ["你好🌍", "next"], "split: \(split)")
        }
    }

    func testCRLFAndLoneCRPreserveEmptyLines() {
        for newline in ["\n", "\r\n", "\r"] {
            let parser = SSEByteParser()
            let wire = "data: one" + newline + newline + "data: two" + newline + newline
            XCTAssertEqual(feed(wire, into: parser).map(\.data), ["one", "two"])
        }
    }

    func testCRLFSplitAcrossPacketsDoesNotDispatchAnExtraEvent() {
        let parser = SSEByteParser()
        XCTAssertTrue(feed("data: one\r", into: parser).isEmpty)
        XCTAssertTrue(feed("\n", into: parser).isEmpty)
        XCTAssertEqual(feed("\r", into: parser).map(\.data), ["one"])
        XCTAssertTrue(feed("\n", into: parser).isEmpty)
    }

    func testUnicodeSeparatorsInsideJSONArePreserved() throws {
        let parser = SSEByteParser()
        let payload = "{\"text\":\"a\u{2028}b\u{2029}c\u{0085}d\"}"
        let events = feed("data: \(payload)\n\n", into: parser)
        XCTAssertEqual(events.first?.data, payload)
        let event = try XCTUnwrap(events.first)
        XCTAssertNoThrow(try JSONDecoder().decode(JSONValue.self, from: Data(event.data.utf8)))
    }

    func testInitialBOMAndMultilineData() {
        let parser = SSEByteParser()
        let events = feed("\u{FEFF}data: one\ndata: two\n\n", into: parser)
        XCTAssertEqual(events.map(\.data), ["one\ntwo"])
    }

    func testFlushHandlesAnUnterminatedLastLineExactlyOnce() {
        let parser = SSEByteParser()
        XCTAssertTrue(feed("data: tail", into: parser).isEmpty)
        XCTAssertEqual(parser.flush()?.data, "tail")
        XCTAssertNil(parser.flush())
    }
}
