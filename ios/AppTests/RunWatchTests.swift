import Foundation
import PabootProtocol
import XCTest
@testable import paboot

@MainActor
final class RunWatchTests: XCTestCase {
    func testApprovalsDeduplicateResolveAndReportCompletion() async throws {
        let repository = NotificationRepository()
        let sink = NotificationSink()
        let watcher = RunWatchCenter(repository: repository, sink: sink)
        let started = expectation(description: "independent stream")
        repository.onStream = { started.fulfill() }
        watcher.setActive(true)
        watcher.watch(runId: "r1", sessionId: "s1", title: "My task")
        await fulfillment(of: [started], timeout: 2)
        let done = expectation(description: "terminal result")
        sink.onResult = { done.fulfill() }
        let source = try XCTUnwrap(repository.streams.first)
        source.yield(try frame(1, #"{"type":"permission_request","permissionId":"p1","toolName":"Bash"}"#))
        source.yield(try frame(2, #"{"type":"permission_request","permissionId":"p1","toolName":"Bash"}"#))
        source.yield(try frame(3, #"{"type":"permission_request","permissionId":"p1","toolName":"Bash","status":"allowed"}"#))
        source.yield(try frame(4, #"{"type":"status","label":"succeeded","terminal":true}"#))
        await fulfillment(of: [done], timeout: 2)
        XCTAssertEqual(sink.approvals, ["p1"])
        XCTAssertEqual(sink.resolved, ["p1"])
        XCTAssertEqual(sink.results, ["succeeded"])
        XCTAssertEqual(sink.lastRun?.sessionId, "s1")
        XCTAssertEqual(sink.lastRun?.title, "My task")
        // A late registration from the chat stream must not replay a completed run.
        watcher.watch(runId: "r1", sessionId: "s1", title: "My task")
        watcher.reset()
    }

    func testPauseResumesCursorAndKeepsApprovalDeduplication() async throws {
        let repository = NotificationRepository()
        let sink = NotificationSink()
        let watcher = RunWatchCenter(repository: repository, sink: sink)
        let first = expectation(description: "first stream")
        repository.onStream = { first.fulfill() }
        watcher.setActive(true)
        watcher.watch(runId: "r1", sessionId: "s1", title: "Task")
        await fulfillment(of: [first], timeout: 2)
        let approved = expectation(description: "first approval")
        sink.onApproval = { approved.fulfill() }
        repository.streams[0].yield(try frame(1, #"{"type":"permission_request","permissionId":"p1","toolName":"Bash"}"#))
        await fulfillment(of: [approved], timeout: 2)
        watcher.setActive(false)
        let resumed = expectation(description: "resumed stream")
        repository.onStream = { resumed.fulfill() }
        watcher.setActive(true)
        await fulfillment(of: [resumed], timeout: 2)
        XCTAssertEqual(repository.cursors.count, 2)
        XCTAssertNil(repository.cursors[0])
        XCTAssertEqual(repository.cursors[1], 1)
        let done = expectation(description: "finished after resume")
        sink.onResult = { done.fulfill() }
        repository.streams[1].yield(try frame(1, #"{"type":"permission_request","permissionId":"p1","toolName":"Bash"}"#))
        repository.streams[1].yield(try frame(2, #"{"type":"permission_request","permissionId":"p1","toolName":"Bash"}"#))
        repository.streams[1].yield(try frame(3, #"{"type":"status","label":"succeeded","terminal":true}"#))
        await fulfillment(of: [done], timeout: 2)
        XCTAssertEqual(sink.approvals, ["p1"])
        watcher.reset()
    }

    func testClosedStreamCatchesUpTerminalEvent() async throws {
        let repository = NotificationRepository()
        repository.active = false
        repository.events = [try frame(1, #"{"type":"error","message":"failed to run","terminal":true}"#)]
        let sink = NotificationSink()
        let watcher = RunWatchCenter(repository: repository, sink: sink)
        let started = expectation(description: "stream")
        repository.onStream = { started.fulfill() }
        let done = expectation(description: "catch-up result")
        sink.onResult = { done.fulfill() }
        watcher.setActive(true)
        watcher.watch(runId: "r1", sessionId: "s1", title: "Task")
        await fulfillment(of: [started], timeout: 2)
        repository.streams[0].finish()
        await fulfillment(of: [done], timeout: 2)
        XCTAssertEqual(sink.results, ["failed"])
        XCTAssertEqual(sink.lastMessage, "failed to run")
        watcher.reset()
    }

    func testResetDiscardsOldConnectionEvents() async throws {
        let repository = NotificationRepository()
        let sink = NotificationSink()
        let watcher = RunWatchCenter(repository: repository, sink: sink)
        let started = expectation(description: "old stream")
        repository.onStream = { started.fulfill() }
        watcher.setActive(true)
        watcher.watch(runId: "r1", sessionId: "old-session", title: "Old")
        await fulfillment(of: [started], timeout: 2)
        watcher.reset()
        let resumed = expectation(description: "new connection stream")
        repository.onStream = { resumed.fulfill() }
        watcher.setActive(true)
        watcher.watch(runId: "r1", sessionId: "new-session", title: "New")
        await fulfillment(of: [resumed], timeout: 2)
        let done = expectation(description: "new result")
        sink.onResult = { done.fulfill() }
        let terminal = try frame(1, #"{"type":"status","label":"succeeded","terminal":true}"#)
        repository.streams[0].yield(terminal)
        repository.streams[1].yield(terminal)
        await fulfillment(of: [done], timeout: 2)
        XCTAssertEqual(sink.results, ["succeeded"])
        XCTAssertEqual(sink.lastRun?.sessionId, "new-session")
        watcher.reset()
    }

    private func frame(_ seq: Int, _ event: String) throws -> SSEFrame {
        try JSONDecoder().decode(SSEFrame.self, from: Data("{\"runId\":\"r1\",\"seq\":\(seq),\"event\":\(event)}".utf8))
    }
}

private final class NotificationRepository: RunWatchingRepository {
    var streams: [AsyncThrowingStream<SSEFrame, Error>.Continuation] = []
    var cursors: [Int64?] = []
    var onStream: (() -> Void)?
    var active: Bool? = true
    var events: [SSEFrame] = []
    func runStream(runId: String, after: Int64?) -> AsyncThrowingStream<SSEFrame, Error> {
        cursors.append(after)
        return AsyncThrowingStream { continuation in
            streams.append(continuation)
            onStream?()
        }
    }
    func runEvents(runId: String, after: Int64?) async throws -> [SSEFrame] { events }
    func isRunActive(runId: String) async -> Bool? { active }
}

@MainActor
private final class NotificationSink: RunNotificationSink {
    var approvals: [String] = []
    var resolved: [String] = []
    var results: [String] = []
    var lastRun: RunNotificationContext?
    var lastMessage: String?
    var onApproval: (() -> Void)?
    var onResult: (() -> Void)?
    func approval(_ permission: NormalizedEvent.PermissionRequest, run: RunNotificationContext) async {
        approvals.append(permission.permissionId)
        onApproval?()
    }
    func resolvePermission(id: String, run: RunNotificationContext) { resolved.append(id) }
    func clearApprovals(run: RunNotificationContext) {}
    func result(label: String, message: String?, run: RunNotificationContext) async {
        results.append(label)
        lastRun = run
        lastMessage = message
        onResult?()
    }
}
