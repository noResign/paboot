import Combine
import PabootProtocol
import UIKit
import UserNotifications

/// Foreground-only local notifications. No background mode or APNs registration.
@MainActor
final class RunNotifications: NSObject, RunNotificationSink, UNUserNotificationCenterDelegate {
    static let shared = RunNotifications()
    struct State {
        var enabled: Bool
        var requesting = false
        var authorization: UNAuthorizationStatus = .notDetermined
        var error: String?
    }
    @Published private(set) var state: State
    private let center = UNUserNotificationCenter.current()
    private let defaultsKey = "paboot.foregroundNotifications"
    private lazy var watcher = RunWatchCenter(repository: ChatRepository(), sink: self)
    private var discovery: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var generation = 0
    private var approvalIds: [String: Set<String>] = [:]
    private var sessionIds: [String: Set<String>] = [:]

    private override init() {
        state = State(enabled: UserDefaults.standard.bool(forKey: "paboot.foregroundNotifications"))
        super.init()
    }

    func start() {
        center.delegate = self
        center.setNotificationCategories(Set(["TASK_APPROVAL", "TASK_RESULT"].map {
            UNNotificationCategory(identifier: $0, actions: [], intentIdentifiers: [], options: [])
        }))
        guard observers.isEmpty else { return }
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.refreshAuthorization()
                self.connectionActivated()
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, UIApplication.shared.applicationState != .active else { return }
                self.generation += 1
                self.discovery?.cancel()
                self.watcher.setActive(false)
                self.center.removeAllPendingNotificationRequests()
            }
        })
    }

    func refreshAuthorization() async {
        let settings = await center.notificationSettings()
        state.authorization = settings.authorizationStatus
        if settings.authorizationStatus == .denied, state.enabled {
            disable()
        }
    }

    func setEnabled(_ enabled: Bool) async {
        guard !state.requesting else { return }
        state.error = nil
        if !enabled { disable(); return }
        state.requesting = true
        defer { state.requesting = false }
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound])
            await refreshAuthorization()
            guard granted else { return }
            state.enabled = true
            UserDefaults.standard.set(true, forKey: defaultsKey)
            connectionActivated()
        } catch { state.error = error.localizedDescription }
    }

    private func disable() {
        state.enabled = false
        UserDefaults.standard.set(false, forKey: defaultsKey)
        resetConnection()
    }

    func resetConnection() {
        generation += 1
        discovery?.cancel()
        discovery = nil
        watcher.reset()
        approvalIds.removeAll()
        sessionIds.removeAll()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }

    func connectionActivated() {
        guard state.enabled, UIApplication.shared.applicationState == .active,
              let client = DaemonSession.shared.client else { return }
        watcher.setActive(true)
        discovery?.cancel()
        let current = generation
        discovery = Task {
            guard let response = try? await client.api.runs(),
                  !Task.isCancelled, current == generation else { return }
            for run in response.runs {
                watch(runId: run.id, sessionId: run.sessionId,
                      title: run.prompt.isEmpty ? "会话" : String(run.prompt.prefix(60)))
            }
        }
    }

    func watch(runId: String, sessionId: String, title: String) {
        guard state.enabled, DaemonSession.shared.client != nil else { return }
        watcher.watch(runId: runId, sessionId: sessionId, title: title)
    }

    func clearSession(_ sessionId: String) {
        let ids = Array(sessionIds.removeValue(forKey: sessionId) ?? [])
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    private func permissionId(_ id: String, run: RunNotificationContext) -> String {
        "paboot.approval.\(run.runId).\(id)"
    }

    func approval(_ permission: NormalizedEvent.PermissionRequest, run: RunNotificationContext) async {
        let id = permissionId(permission.permissionId, run: run)
        approvalIds[run.runId, default: []].insert(id)
        let title = permission.toolName == "UserInput" ? "需要你的回答" : "需要审批：\(permission.toolName)"
        await post(id: id, title: title, body: run.title, category: "TASK_APPROVAL", run: run)
    }

    func resolvePermission(id: String, run: RunNotificationContext) {
        let identifier = permissionId(id, run: run)
        approvalIds[run.runId]?.remove(identifier)
        sessionIds[run.sessionId]?.remove(identifier)
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    func clearApprovals(run: RunNotificationContext) {
        let ids = approvalIds.removeValue(forKey: run.runId) ?? []
        sessionIds[run.sessionId]?.subtract(ids)
        center.removeDeliveredNotifications(withIdentifiers: Array(ids))
        center.removePendingNotificationRequests(withIdentifiers: Array(ids))
    }

    func result(label: String, message: String?, run: RunNotificationContext) async {
        let title: String
        switch label {
        case "succeeded": title = "任务已完成"
        case "failed": title = "任务失败"
        case "cancelled": title = "任务已取消"
        default: title = "任务已结束"
        }
        await post(id: "paboot.result.\(run.sessionId)", title: title,
                   body: message.map { "\(run.title)：\($0)" } ?? run.title,
                   category: "TASK_RESULT", run: run)
    }

    private func post(id: String, title: String, body: String, category: String, run: RunNotificationContext) async {
        guard state.enabled, UIApplication.shared.applicationState == .active,
              !AppRouter.shared.isViewingSession(run.sessionId),
              let connectionId = DaemonSession.shared.connection?.id else { return }
        let current = generation
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = String(body.prefix(240))
        content.sound = .default
        content.categoryIdentifier = category
        content.threadIdentifier = "\(connectionId).\(run.sessionId)"
        content.userInfo = ["connectionId": connectionId, "sessionId": run.sessionId, "generation": current]
        sessionIds[run.sessionId, default: []].insert(id)
        do {
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            if current != generation || !state.enabled || UIApplication.shared.applicationState != .active
                || AppRouter.shared.isViewingSession(run.sessionId) {
                center.removeDeliveredNotifications(withIdentifiers: [id])
                center.removePendingNotificationRequests(withIdentifiers: [id])
            }
        } catch {
            sessionIds[run.sessionId]?.remove(id)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await MainActor.run {
            let info = notification.request.content.userInfo
            guard self.state.enabled, UIApplication.shared.applicationState == .active,
                  (info["generation"] as? Int) == self.generation,
                  let connectionId = info["connectionId"] as? String,
                  connectionId == DaemonSession.shared.connection?.id,
                  let sessionId = info["sessionId"] as? String,
                  !AppRouter.shared.isViewingSession(sessionId) else { return [] }
            return [.banner, .list, .sound]
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let sessionId = response.notification.request.content.userInfo["sessionId"] as? String,
              let connectionId = response.notification.request.content.userInfo["connectionId"] as? String else { return }
        await MainActor.run {
            AppRouter.shared.openSession(id: sessionId, connectionId: connectionId)
        }
    }
}
