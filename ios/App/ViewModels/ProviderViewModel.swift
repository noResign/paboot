import Combine
import Foundation
import PabootProtocol

struct ProviderDraft {
    var id: String
    var kind: String
    var label: String
    var baseUrl: String
    var apiKey: String = ""
    var clearKey: Bool = false
    var modelIds: String = ""
}

@MainActor
final class ProviderViewModel {
    struct State {
        var isLoading = true
        var providers: [ProviderDto] = []
        var busy = false
        var error: String?
        var notice: String?
    }

    @Published private(set) var state = State()

    private let repository: ProviderRepository
    private var generation = 0

    init(repository: ProviderRepository = ProviderRepository()) {
        self.repository = repository
    }

    func load() async {
        generation += 1
        let current = generation
        state.isLoading = true
        state.error = nil
        do {
            let providers = try await repository.list()
            guard current == generation else { return }
            state.isLoading = false
            state.providers = providers
        } catch {
            guard current == generation else { return }
            state.isLoading = false
            state.error = message(error)
        }
    }

    func save(original: ProviderDto?, draft: ProviderDraft) async {
        let id = draft.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseUrl = draft.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !baseUrl.isEmpty else {
            state.error = "Provider id 和 Base URL 不能为空"
            return
        }

        state.busy = true
        state.error = nil
        state.notice = nil
        do {
            let models = buildModels(original: original, text: draft.modelIds)
            let key = draft.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            let labelText = draft.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = labelText.isEmpty ? id : labelText
            if let original {
                let apiKey: JSONValue? = draft.clearKey
                    ? .null
                    : (key.isEmpty ? nil : .string(key))
                _ = try await repository.update(
                    id: original.id,
                    body: ProviderUpdateRequest(
                        kind: draft.kind,
                        label: label,
                        baseUrl: baseUrl,
                        apiKey: apiKey,
                        models: models
                    )
                )
            } else {
                _ = try await repository.create(
                    ProviderCreateRequest(
                        id: id,
                        kind: draft.kind,
                        label: label,
                        baseUrl: baseUrl,
                        apiKey: key.isEmpty ? nil : key,
                        models: models
                    )
                )
            }
            state.busy = false
            state.notice = "已保存 \(id)"
            await load()
        } catch {
            state.busy = false
            state.error = message(error)
        }
    }

    func delete(_ provider: ProviderDto) async {
        state.busy = true
        state.error = nil
        state.notice = nil
        do {
            try await repository.delete(id: provider.id)
            state.busy = false
            state.notice = "已删除 \(provider.id)"
            await load()
        } catch {
            state.busy = false
            state.error = message(error)
        }
    }

    func test(_ provider: ProviderDto) async {
        state.busy = true
        state.error = nil
        state.notice = "正在测试 \(provider.id)…"
        do {
            let result = try await repository.test(id: provider.id)
            state.busy = false
            state.notice = "连接成功 · \(result.latencyMs)ms · \(result.modelCount ?? 0) 个模型"
        } catch {
            state.busy = false
            state.error = message(error)
        }
    }

    func refreshModels(_ provider: ProviderDto) async {
        state.busy = true
        state.error = nil
        state.notice = "正在刷新模型…"
        do {
            let updated = try await repository.refreshModels(id: provider.id)
            state.busy = false
            state.notice = "已刷新 · \(updated.models.count) 个模型"
            await load()
        } catch {
            state.busy = false
            state.error = message(error)
        }
    }

    func clearMessages() {
        state.error = nil
        state.notice = nil
    }

    private func buildModels(original: ProviderDto?, text: String) -> [ProviderModelDto] {
        let existing = Dictionary(uniqueKeysWithValues: (original?.models ?? []).map { ($0.id, $0) })
        var seen = Set<String>()
        return text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { id in
                let old = existing[id]
                return ProviderModelDto(
                    id: id,
                    label: old?.label,
                    contextWindow: old?.contextWindow,
                    maxOutput: old?.maxOutput,
                    supportsTools: old?.supportsTools ?? true,
                    supportsImages: old?.supportsImages ?? false,
                    enabled: old?.enabled ?? true
                )
            }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
