import Foundation
import PabootClient
import PabootProtocol

struct RunNotificationContext {
    let runId: String
    let sessionId: String
    var title: String
}

@MainActor
protocol RunNotificationSink: AnyObject {
    func approval(_ permission: NormalizedEvent.PermissionRequest, run: RunNotificationContext) async
    func resolvePermission(id: String, run: RunNotificationContext)
    func result(label: String, message: String?, run: RunNotificationContext) async
    func clearApprovals(run: RunNotificationContext)
}

protocol RunWatchingRepository {
    func runStream(runId: String, after: Int64?) -> AsyncThrowingStream<SSEFrame, Error>
    func runEvents(runId: String, after: Int64?) async throws -> [SSEFrame]
    func isRunActive(runId: String) async -> Bool?
}

/// Owns streams independently of chat screens, only while the app is active.
@MainActor
final class RunWatchCenter {
    private final class Entry {
        var context: RunNotificationContext
        var after: Int64 = -1
        var seenPermissions = Set<String>()
        init(_ context: RunNotificationContext) { self.context = context }
    }
    private struct Job {
        let id: UUID
        let task: Task<Void, Never>
    }
    private let repository: any RunWatchingRepository
    private weak var sink: (any RunNotificationSink)?
    private var entries: [String: Entry] = [:]
    private var jobs: [String: Job] = [:]
    private var active = false
    private var finishedRuns = Set<String>()

    init(repository: any RunWatchingRepository, sink: any RunNotificationSink) {
        self.repository = repository
        self.sink = sink
    }

    func watch(runId: String, sessionId: String, title: String) {
        guard !runId.isEmpty, !sessionId.isEmpty, !finishedRuns.contains(runId) else { return }
        if let entry = entries[runId] {
            entry.context.title = title
        } else {
            guard entries.count < 20 else { return }
            entries[runId] = Entry(RunNotificationContext(runId: runId, sessionId: sessionId, title: title))
        }
        if active { launch(runId) }
    }

    func setActive(_ active: Bool) {
        self.active = active
        if active {
            for id in Array(entries.keys) { launch(id) }
        } else {
            let previous = Array(jobs.values)
            jobs.removeAll()
            previous.forEach { $0.task.cancel() }
        }
    }

    func reset() {
        setActive(false)
        entries.removeAll()
        finishedRuns.removeAll()
    }

    private func launch(_ runId: String) {
        guard jobs[runId] == nil, let entry = entries[runId] else { return }
        let id = UUID()
        let task = Task { await follow(entry, jobId: id) }
        jobs[runId] = Job(id: id, task: task)
    }

    private func isCurrent(_ entry: Entry, _ jobId: UUID) -> Bool {
        !Task.isCancelled && active && jobs[entry.context.runId]?.id == jobId
    }

    private func follow(_ entry: Entry, jobId: UUID) async {
        let runId = entry.context.runId
        var attempt = 0
        var unreachableSince: Date?
        while isCurrent(entry, jobId) {
            let started = Date()
            var received = false
            var failure: Error?
            do {
                for try await frame in repository.runStream(runId: runId, after: entry.after >= 0 ? entry.after : nil) {
                    guard isCurrent(entry, jobId) else { return }
                    received = true
                    if await handle(frame, entry: entry) {
                        finish(entry, jobId: jobId)
                        return
                    }
                }
            } catch { failure = error }
            guard isCurrent(entry, jobId) else { return }
            let active = await repository.isRunActive(runId: runId)
            guard isCurrent(entry, jobId) else { return }
            if active == false {
                if let frames = try? await repository.runEvents(runId: runId, after: entry.after >= 0 ? entry.after : nil) {
                    guard isCurrent(entry, jobId) else { return }
                    for frame in frames {
                        guard isCurrent(entry, jobId) else { return }
                        if await handle(frame, entry: entry) {
                            finish(entry, jobId: jobId)
                            return
                        }
                    }
                }
                finish(entry, jobId: jobId)
                return
            }
            if active == nil {
                if unreachableSince == nil { unreachableSince = Date() }
            } else { unreachableSince = nil }
            let httpCode: Int?
            if let error = failure as? PabootError, case .http(let code, _) = error {
                httpCode = code
            } else { httpCode = nil }
            let decision = ReconnectPolicy.decide(
                terminal: false, httpCode: httpCode, runActive: active,
                unreachableMs: unreachableSince.map { Int64(Date().timeIntervalSince($0) * 1000) } ?? 0,
                attempt: attempt, jitter: Double.random(in: 0..<1)
            )
            guard case .retry(let delay) = decision else {
                finish(entry, jobId: jobId, completed: false)
                return
            }
            attempt = received || Date().timeIntervalSince(started) > 5 ? 0 : attempt + 1
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
        }
    }

    private func handle(_ frame: SSEFrame, entry: Entry) async -> Bool {
        guard frame.seq > entry.after else { return false }
        entry.after = frame.seq
        switch frame.event {
        case .permissionRequest(let permission):
            if (permission.status ?? "pending") == "pending" {
                if entry.seenPermissions.insert(permission.permissionId).inserted {
                    await sink?.approval(permission, run: entry.context)
                }
            } else {
                entry.seenPermissions.insert(permission.permissionId)
                sink?.resolvePermission(id: permission.permissionId, run: entry.context)
            }
        case .status(let status) where status.terminal == true:
            sink?.clearApprovals(run: entry.context)
            await sink?.result(label: status.label, message: nil, run: entry.context)
            return true
        case .error(let error) where error.terminal == true:
            sink?.clearApprovals(run: entry.context)
            await sink?.result(label: "failed", message: error.message, run: entry.context)
            return true
        default: break
        }
        return false
    }

    private func finish(_ entry: Entry, jobId: UUID, completed: Bool = true) {
        guard isCurrent(entry, jobId) else { return }
        if completed {
            if finishedRuns.count >= 2000 { finishedRuns.removeAll(keepingCapacity: true) }
            finishedRuns.insert(entry.context.runId)
        }
        jobs.removeValue(forKey: entry.context.runId)
        entries.removeValue(forKey: entry.context.runId)
        sink?.clearApprovals(run: entry.context)
    }
}
