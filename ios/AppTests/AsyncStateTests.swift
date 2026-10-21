import Combine
import Foundation
import PabootProtocol
import XCTest
import UIKit
@testable import paboot

@MainActor
final class AsyncStateTests: XCTestCase {
    func testComposerCollapseRestoresHeightAndPreservesDraft() throws {
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        let composer = ChatInputBar()
        let stack = UIStackView(arrangedSubviews: [composer])
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(stack)
        let emptyHeight = stack.heightAnchor.constraint(equalToConstant: 0)
        emptyHeight.priority = .fittingSizeLevel
        emptyHeight.isActive = true
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
        func textField(in view: UIView) -> UITextField? {
            if let field = view as? UITextField { return field }
            return view.subviews.lazy.compactMap { textField(in: $0) }.first
        }
        let field = try XCTUnwrap(textField(in: composer))
        field.text = "未发送的草稿"
        host.layoutIfNeeded()
        let expandedHeight = stack.bounds.height
        XCTAssertGreaterThan(expandedHeight, 36)

        composer.isHidden = true
        host.layoutIfNeeded()
        XCTAssertEqual(stack.bounds.height, 0, accuracy: 1)
        composer.isHidden = false
        host.layoutIfNeeded()
        XCTAssertEqual(stack.bounds.height, expandedHeight, accuracy: 1)
        XCTAssertEqual(field.text, "未发送的草稿")

        // Repeat the transition to catch stale stack sizing after restoration.
        composer.isHidden = true
        host.layoutIfNeeded()
        XCTAssertEqual(stack.bounds.height, 0, accuracy: 1)
        composer.isHidden = false
        host.layoutIfNeeded()
        XCTAssertEqual(stack.bounds.height, expandedHeight, accuracy: 1)
        XCTAssertEqual(field.text, "未发送的草稿")
    }

    func testFileNoWrapCreatesScrollableWidthAndWrappingRestoresViewport() throws {
        let editor = FileTextView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        editor.setText(String(repeating: "a", count: 400) + "\nshort line")
        editor.setWrapping(false)
        editor.layoutIfNeeded()
        let horizontal = try XCTUnwrap(editor.subviews.first as? UIScrollView)
        horizontal.layoutIfNeeded()
        let text = try XCTUnwrap(horizontal.subviews.first(where: { $0 is UITextView }) as? UITextView)
        XCTAssertGreaterThan(horizontal.contentSize.width, horizontal.bounds.width + 100)
        XCTAssertEqual(text.bounds.width, horizontal.contentSize.width, accuracy: 1)
        horizontal.setContentOffset(CGPoint(x: 100, y: 0), animated: false)
        XCTAssertEqual(horizontal.contentOffset.x, 100, accuracy: 1)

        editor.setWrapping(true)
        editor.layoutIfNeeded()
        horizontal.layoutIfNeeded()
        XCTAssertEqual(text.bounds.width, horizontal.bounds.width, accuracy: 1)
        XCTAssertEqual(horizontal.contentSize.width, horizontal.bounds.width, accuracy: 1)
        XCTAssertEqual(horizontal.contentOffset.x, 0, accuracy: 1)
        XCTAssertEqual(editor.layer.cornerRadius, 0)

        editor.frame.size.width = 600
        editor.setWrapping(false)
        editor.setNeedsLayout()
        editor.layoutIfNeeded()
        horizontal.layoutIfNeeded()
        XCTAssertGreaterThan(horizontal.contentSize.width, horizontal.bounds.width)
    }

    func testSessionRunningIndicatorDisappearsOnCompletionAndReuse() throws {
        let cell = SessionCell(style: .default, reuseIdentifier: SessionCell.reuseIdentifier)
        let running: SessionDto = try decode(#"{"id":"s1","running":true}"#)
        let stopped: SessionDto = try decode(#"{"id":"s1","running":false}"#)
        cell.configure(with: running)

        func findIndicator(in view: UIView) -> RunningDotView? {
            if let indicator = view as? RunningDotView { return indicator }
            return view.subviews.lazy.compactMap { findIndicator(in: $0) }.first
        }
        let indicator = try XCTUnwrap(findIndicator(in: cell))
        let dot = try XCTUnwrap(indicator.subviews.first)
        XCTAssertFalse(indicator.isHidden)
        XCTAssertFalse(dot.isHidden)
        XCTAssertNotNil(dot.layer.animation(forKey: "pulse"))

        // Diffable reconfiguration keeps the same cell and does not call prepareForReuse.
        cell.configure(with: stopped)
        cell.configure(with: stopped)
        XCTAssertTrue(indicator.isHidden)
        XCTAssertTrue(dot.isHidden)
        XCTAssertEqual(dot.alpha, 0)
        XCTAssertNil(dot.layer.animation(forKey: "pulse"))

        cell.configure(with: running)
        XCTAssertFalse(indicator.isHidden)
        XCTAssertFalse(dot.isHidden)
        XCTAssertEqual(dot.alpha, 1)
        XCTAssertNotNil(dot.layer.animation(forKey: "pulse"))
        cell.prepareForReuse()
        XCTAssertTrue(indicator.isHidden)
        XCTAssertTrue(dot.isHidden)
        XCTAssertNil(dot.layer.animation(forKey: "pulse"))
    }

    private func waitForState(
        _ model: ChatViewModel,
        matching predicate: @escaping (ChatViewModel.State) -> Bool
    ) async {
        let changed = expectation(description: "chat state")
        let subscription = model.$state.first(where: predicate).sink { _ in changed.fulfill() }
        await fulfillment(of: [changed], timeout: 2)
        withExtendedLifetime(subscription) {}
    }

    private func flush(_ repository: FakeChatRepository, model: ChatViewModel) async throws {
        let marker = UUID().uuidString
        try repository.emit(["type": "status", "label": "running", "model": marker])
        await waitForState(model) { $0.model == marker }
    }

    func testSSEThenHTTPDoesNotDismissNextPermission() async throws {
        let repository = FakeChatRepository()
        let model = ChatViewModel(sessionId: nil, repository: repository)
        model.send("hello")
        try repository.permission("p1")
        try repository.permission("p2")
        try await flush(repository, model: model)

        let sent = expectation(description: "decision sent")
        repository.onDecision = { sent.fulfill() }
        model.decidePermission("allow", permissionId: "p1")
        await fulfillment(of: [sent], timeout: 2)
        try repository.permission("p1", status: "allowed")
        try await flush(repository, model: model)
        XCTAssertEqual(model.state.permission?.permissionId, "p2")

        repository.decisionContinuation?.resume()
        repository.decisionContinuation = nil
        await waitForState(model) { $0.submittingPermissionId == nil }
        // Synchronize with another frame after the HTTP task has been scheduled.
        try await flush(repository, model: model)
        XCTAssertEqual(model.state.permission?.permissionId, "p2")
        model.detach()
    }

    func testHTTPThenSSEAndStaleUIActionDoNotDismissNextPermission() async throws {
        let repository = FakeChatRepository()
        let model = ChatViewModel(sessionId: nil, repository: repository)
        model.send("hello")
        try repository.permission("p1")
        try repository.permission("p2")
        try await flush(repository, model: model)
        let sent = expectation(description: "decision sent")
        repository.onDecision = { sent.fulfill() }
        model.decidePermission("allow", permissionId: "p1")
        await fulfillment(of: [sent], timeout: 2)
        repository.decisionContinuation?.resume()
        repository.decisionContinuation = nil
        await waitForState(model) { $0.permission?.permissionId == "p2" }

        try repository.permission("p1", status: "allowed")
        try repository.permission("p1") // stale replay must not requeue the resolved ID
        try await flush(repository, model: model)
        model.decidePermission("deny", permissionId: "p1")
        XCTAssertEqual(repository.decisions.count, 1)
        XCTAssertEqual(model.state.permission?.permissionId, "p2")
        try repository.permission("p2", status: "denied")
        try await flush(repository, model: model)
        XCTAssertNil(model.state.permission)
        model.detach()
    }

    func testUserInputResponseStaysOnOriginalRunAndCanRetry() async throws {
        let repository = FakeChatRepository()
        let model = ChatViewModel(sessionId: nil, repository: repository)
        model.send("hello")
        try repository.permission("input", tool: "UserInput")
        try await flush(repository, model: model)
        let sent = expectation(description: "answer sent")
        repository.onDecision = { sent.fulfill() }
        let answer = JSONValue.object(["answers": .object(["q1": .object([
            "answers": .array([.string("A")]),
        ])])])
        model.decidePermission("allow", permissionId: "input", response: answer)
        model.decidePermission("allow", permissionId: "input", response: answer)
        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(repository.decisions.count, 1)
        XCTAssertEqual(repository.decisions.first?.response, answer)
        XCTAssertEqual(repository.chatCount, 1)
        repository.decisionContinuation?.resume(throwing: ChatRepositoryError.failed("bad response"))
        repository.decisionContinuation = nil
        await waitForState(model) { $0.permissionError != nil && $0.submittingPermissionId == nil }
        XCTAssertEqual(model.state.permission?.permissionId, "input")
        XCTAssertNil(model.state.error)

        let retried = expectation(description: "answer retried")
        repository.onDecision = { retried.fulfill() }
        model.decidePermission("allow", permissionId: "input", response: answer)
        await fulfillment(of: [retried], timeout: 2)
        repository.decisionContinuation?.resume()
        repository.decisionContinuation = nil
        await waitForState(model) { $0.permission == nil }
        XCTAssertEqual(repository.chatCount, 1)
        model.detach()
    }

    func testDetachDuringHistoryLoadNeverReattachesRun() async throws {
        let repository = FakeChatRepository()
        let requested = expectation(description: "history requested")
        var history: CheckedContinuation<SessionDetailResponse, Error>?
        repository.detail = {
            try await withCheckedThrowingContinuation { continuation in
                history = continuation
                requested.fulfill()
            }
        }
        let model = ChatViewModel(sessionId: "s1", repository: repository)
        model.start()
        await fulfillment(of: [requested], timeout: 2)
        model.detach()
        history?.resume(returning: try decode(#"{"session":{"id":"s1","runningRunId":"r1"},"runs":[{"id":"r1"}]}"#))
        await waitForState(model) { !$0.loadingHistory }
        XCTAssertEqual(repository.attachCount, 0)
        XCTAssertFalse(model.state.streaming)
        XCTAssertTrue(model.state.messages.isEmpty)
    }

    func testDetachWhileReplayingHistoryNeverReattachesRun() async throws {
        let repository = FakeChatRepository()
        repository.detail = {
            try decode(#"{"session":{"id":"s1","runningRunId":"r1"},"runs":[{"id":"old"},{"id":"r1"}]}"#)
        }
        let requested = expectation(description: "events requested")
        var events: CheckedContinuation<[SSEFrame], Error>?
        repository.events = {
            try await withCheckedThrowingContinuation { continuation in
                events = continuation
                requested.fulfill()
            }
        }
        let model = ChatViewModel(sessionId: "s1", repository: repository)
        model.start()
        await fulfillment(of: [requested], timeout: 2)
        model.detach()
        events?.resume(returning: [])
        await waitForState(model) { !$0.loadingHistory }
        XCTAssertEqual(repository.attachCount, 0)
        XCTAssertTrue(model.state.messages.isEmpty)
    }

    func testOldPageCannotAppendIntoNewRootWithSameRelativePath() async throws {
        let repository = FakeFilesRepository()
        let model = FilesViewModel(repository: repository)
        await model.switchMode(.all)
        let requested = expectation(description: "old page requested")
        repository.onPage = { requested.fulfill() }
        let oldPage = Task { await model.loadMore() }
        await fulfillment(of: [requested], timeout: 2)
        await model.selectRoot("/new")
        repository.page?.resume(returning: try makeFilesResponse(root: "/old", name: "stale", cursor: "400"))
        await oldPage.value
        XCTAssertEqual(model.state.root, "/new")
        XCTAssertEqual(model.state.entries.map(\.name), ["new"])
        XCTAssertEqual(model.state.nextCursor, "200")
        XCTAssertFalse(model.state.isLoadingMore)
        XCTAssertNil(model.state.actionError)
    }

    func testOldPageFailureDoesNotShowErrorInNewDirectory() async throws {
        let repository = FakeFilesRepository()
        let model = FilesViewModel(repository: repository)
        await model.switchMode(.all)
        let requested = expectation(description: "page requested")
        repository.onPage = { requested.fulfill() }
        let oldPage = Task { await model.loadMore() }
        await fulfillment(of: [requested], timeout: 2)
        await model.openDirectory(path: "child")
        repository.page?.resume(throwing: FilesRepositoryError.failed("old error"))
        await oldPage.value
        XCTAssertEqual(model.state.path, "child")
        XCTAssertNil(model.state.actionError)
    }
}

private func decode<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func makeFilesResponse(root: String, name: String, path: String = "", cursor: String) throws -> FilesResponse {
    let data = try JSONSerialization.data(withJSONObject: [
        "workspaceId": "w1", "workspacePath": "/old", "root": root,
        "path": path, "entries": [["name": name, "path": name, "type": "file"]],
        "nextCursor": cursor,
    ])
    return try JSONDecoder().decode(FilesResponse.self, from: data)
}

private final class FakeFilesRepository: FileListingRepository {
    var page: CheckedContinuation<FilesResponse, Error>?
    var onPage: (() -> Void)?

    func files(workspaceId: String?, root: String?, path: String?, cursor: String?, showHidden: Bool) async throws -> FilesResponse {
        if cursor != nil {
            return try await withCheckedThrowingContinuation { continuation in
                page = continuation
                onPage?()
            }
        }
        return try makeFilesResponse(root: root ?? "/old", name: root == "/new" ? "new" : "old", path: path ?? "", cursor: "200")
    }

    func changes(workspaceId: String?, root: String?) async throws -> ChangesResponse {
        throw FilesRepositoryError.failed("unused")
    }
}

private final class FakeChatRepository: ChatRepositoryProtocol {
    var detail: (() async throws -> SessionDetailResponse)?
    var events: (() async throws -> [SSEFrame])?
    var stream: AsyncThrowingStream<SSEFrame, Error>.Continuation?
    var decisionContinuation: CheckedContinuation<Void, Error>?
    var onDecision: (() -> Void)?
    var decisions: [(id: String, response: JSONValue?)] = []
    var chatCount = 0
    var attachCount = 0
    private var seq = 0

    func emit(_ event: [String: Any]) throws {
        seq += 1
        let data = try JSONSerialization.data(withJSONObject: ["runId": "r1", "seq": seq, "event": event])
        stream?.yield(try JSONDecoder().decode(SSEFrame.self, from: data))
    }

    func permission(_ id: String, status: String = "pending", tool: String = "Bash") throws {
        try emit(["type": "permission_request", "permissionId": id, "toolName": tool, "status": status])
    }

    func chat(_ request: ChatRequest) -> AsyncThrowingStream<SSEFrame, Error> {
        chatCount += 1
        return AsyncThrowingStream { stream = $0 }
    }
    func runStream(runId: String, after: Int64?) -> AsyncThrowingStream<SSEFrame, Error> {
        attachCount += 1
        return AsyncThrowingStream { stream = $0 }
    }
    func decidePermission(id: String, decision: String, response: JSONValue?) async throws {
        decisions.append((id, response))
        try await withCheckedThrowingContinuation { continuation in
            decisionContinuation = continuation
            onDecision?()
        }
    }
    func sessionDetail(id: String) async throws -> SessionDetailResponse {
        guard let detail else { throw ChatRepositoryError.failed("unused") }
        return try await detail()
    }
    func runEvents(runId: String, after: Int64?) async throws -> [SSEFrame] {
        guard let events else { return [] }
        return try await events()
    }
    func isRunActive(runId: String) async -> Bool? { true }
    func cancelRun(id: String) async throws {}
    func updateModel(sessionId: String, model: String?, parameters: [String: String]?) async throws -> SessionDto? { nil }
    func updatePermissionMode(sessionId: String, mode: String) async throws {}
    func models(agentId: String) async throws -> [ModelOptionDto] { [] }
}
