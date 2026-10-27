import Combine
import Foundation
import PabootProtocol

struct TaskDraft {
    let name: String
    /// `ai` | `command`
    let type: String
    let prompt: String
    let command: String
    /// `existing` | `new` | `workspace`
    let targetMode: String
    let sessionId: String?
    let runtime: String
    /// daily | weekdays | weekly | every_minutes | every_hours
    let preset: String
    let time: String
    let days: [Int]
    let every: Int
}

/// Drives the task list, the detail sheet and the editor.
@MainActor
final class ScheduledTasksViewModel {
    struct State {
        var tasks: [ScheduledTaskDto] = []
        var isLoading = true
        var loadError: String?
        var actionError: String?
        var detail: ScheduledTaskDetailResponse?
        /// Task ids whose run-now request is still in flight.
        var startingTaskIds: Set<String> = []
    }

    @Published private(set) var state = State()

    private let repository: ScheduledTaskRepository
    /// When set, only this session's tasks are loaded (opened from a chat).
    private let sessionFilterId: String?
    private var loadGeneration = 0

    init(
        repository: ScheduledTaskRepository = ScheduledTaskRepository(),
        sessionFilterId: String? = nil
    ) {
        self.repository = repository
        self.sessionFilterId = sessionFilterId
    }

    func load(showLoading: Bool) async {
        loadGeneration += 1
        let generation = loadGeneration
        if showLoading {
            state.isLoading = true
        }
        defer {
            if generation == loadGeneration {
                state.isLoading = false
            }
        }

        let workspaceId = WorkspaceSelection.shared.selectedId
        do {
            let tasks = try await repository.list(
                workspaceId: workspaceId,
                sessionId: sessionFilterId
            )
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state.tasks = tasks
            state.loadError = nil
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state.loadError = error.localizedDescription
        }

    }

    func loadDetail(id: String) async {
        do {
            state.detail = try await repository.detail(id: id)
            state.actionError = nil
        } catch {
            state.actionError = error.localizedDescription
        }
    }

    func closeDetail() {
        state.detail = nil
    }

    func toggle(_ task: ScheduledTaskDto) async {
        do {
            try await repository.setEnabled(id: task.id, enabled: !task.enabled)
            await load(showLoading: false)
            if state.detail?.task.id == task.id {
                await loadDetail(id: task.id)
            }
        } catch {
            state.actionError = error.localizedDescription
        }
    }

    func runNow(_ task: ScheduledTaskDto) async {
        guard !state.startingTaskIds.contains(task.id), task.lastStatus != "running" else { return }
        state.startingTaskIds.insert(task.id)
        defer { state.startingTaskIds.remove(task.id) }
        do {
            try await repository.runNow(id: task.id)
            state.actionError = nil
            await load(showLoading: false)
            if state.detail?.task.id == task.id {
                await loadDetail(id: task.id)
            }
        } catch {
            state.actionError = error.localizedDescription
        }
    }

    /// Returns true when the task was deleted so the detail screen can pop.
    func delete(_ task: ScheduledTaskDto) async -> Bool {
        do {
            try await repository.delete(id: task.id)
            state.detail = nil
            await load(showLoading: false)
            return true
        } catch {
            state.actionError = error.localizedDescription
            return false
        }
    }

    /// Opens/creates the reusable AI authoring chat and returns its session id.
    func startConfigSession() async -> String? {
        guard let workspaceId = WorkspaceSelection.shared.selectedId else {
            state.actionError = "请先选择工作区"
            return nil
        }
        do {
            return try await repository.startConfigSession(workspaceId: workspaceId).sessionId
        } catch {
            state.actionError = error.localizedDescription
            return nil
        }
    }

    func update(
        taskId: String,
        draft: TaskDraft,
        scheduleEditable: Bool,
        target: ScheduledTaskTargetInput? = nil
    ) async -> Bool {
        let schedule: SchedulePresetInput? = scheduleEditable ? Self.scheduleInput(draft) : nil
        let body = UpdateScheduledTaskRequest(
            name: draft.name,
            prompt: draft.type == "ai" ? draft.prompt : nil,
            command: draft.type == "command" ? draft.command : nil,
            schedule: schedule,
            target: target
        )
        do {
            _ = try await repository.update(id: taskId, body: body)
            state.actionError = nil
            await load(showLoading: false)
            if state.detail?.task.id == taskId {
                await loadDetail(id: taskId)
            }
            return true
        } catch {
            state.actionError = error.localizedDescription
            return false
        }
    }

    private static func scheduleInput(_ draft: TaskDraft) -> SchedulePresetInput {
        switch draft.preset {
        case "every_minutes", "every_hours":
            return SchedulePresetInput(preset: draft.preset, every: draft.every)
        case "weekly":
            return SchedulePresetInput(preset: draft.preset, time: draft.time, days: draft.days)
        default:
            return SchedulePresetInput(preset: draft.preset, time: draft.time)
        }
    }

    func clearActionError() {
        state.actionError = nil
    }
}
