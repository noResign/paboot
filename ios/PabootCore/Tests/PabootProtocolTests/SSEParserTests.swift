import XCTest
@testable import PabootProtocol

final class SSEParserTests: XCTestCase {
    private func feedAll(_ lines: [String]) -> [SSEEvent] {
        let parser = SSEParser()
        var events: [SSEEvent] = []
        for line in lines {
            if let event = parser.feed(line) {
                events.append(event)
            }
        }
        return events
    }

    func testDataFrameIsDispatchedOnBlankLine() {
        let events = feedAll(["data: {\"a\":1}", ""])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.data, "{\"a\":1}")
    }

    func testLeadingSpaceAfterColonIsStripped() {
        let events = feedAll(["data:no-space", ""])
        XCTAssertEqual(events.first?.data, "no-space")
    }

    func testMultiLineDataIsJoinedWithNewline() {
        let events = feedAll(["data: line1", "data: line2", ""])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.data, "line1\nline2")
    }

    func testCommentLineIsIgnored() {
        // The daemon sends ": connected" first and ": keepalive" every 15 seconds.
        let events = feedAll([": connected", "", ": keepalive", "", "data: x", ""])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.data, "x")
    }

    func testIdEventAndRetryFieldsAreParsed() {
        let events = feedAll(["id: 7", "event: foo", "retry: 3000", "data: payload", ""])
        let event = events.first
        XCTAssertEqual(event?.id, "7")
        XCTAssertEqual(event?.event, "foo")
        XCTAssertEqual(event?.retry, 3000)
        XCTAssertEqual(event?.data, "payload")
    }

    func testFlushEmitsPendingEventWhenStreamEndsWithoutBlankLine() {
        let parser = SSEParser()
        XCTAssertNil(parser.feed("data: tail"))
        XCTAssertEqual(parser.flush()?.data, "tail")
    }

    func testBlankLineWithNothingPendingEmitsNothing() {
        XCTAssertNil(SSEParser().feed(""))
    }

    func testCRLFInputIsAccepted() {
        let events = feedAll(["data: value\r", "\r"])
        XCTAssertEqual(events.first?.data, "value")
    }

    func testFieldWithoutColonHasEmptyValue() {
        let events = feedAll(["data", ""])
        XCTAssertEqual(events.first?.data, "")
    }
}
