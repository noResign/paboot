import Foundation
import PabootClient
import PabootProtocol

/// 会话里的 agent（一份可复用的助手定义）。
///
/// 与 `MetaRepository.agents()` 区分：那个列的是「后端插件的 runtime」，这个管的是
/// 「房间里干活的那个助手」——名字、简介、目录、权限上限，以及它在本会话的对话。
///
/// 端点是新的（`/api/agent-profiles`），老 daemon 上会 404 —— 调用方据此把 agent 相关
/// 入口藏起来，而不是当成错误弹给用户。
protocol AgentRepositoryProtocol {
    func listByWorkspace(workspaceId: String) async throws -> [AgentProfileDto]
    func create(workspaceId: String, body: AgentProfileRequest) async throws -> AgentProfileDetailDto
    func detail(agentId: String) async throws -> AgentProfileDetailDto
    func update(agentId: String, body: AgentProfileRequest) async throws -> AgentProfileDetailDto
    func delete(agentId: String) async throws
    func sessionAgents(sessionId: String) async throws -> SessionAgentsResponse
    func addToSession(sessionId: String, agentId: String) async throws
    func removeFromSession(sessionId: String, agentId: String) async throws
    /// 重置某个 agent 在本会话的上下文。只清 paboot 侧的 thread / transcript 绑定，
    /// runtime 自己存的记忆不在范围内。
    func resetContext(sessionId: String, agentId: String) async throws
}

final class AgentRepository: AgentRepositoryProtocol {
    private let session: DaemonSession

    init(session: DaemonSession = .shared) {
        self.session = session
    }

    /// Same shape as the other repositories: one client per call, and a typed
    /// error when the daemon is not connected yet.
    private func clientOrThrow() throws -> PabootClient {
        guard let client = session.client else {
            throw ChatRepositoryError.notConnected
        }
        return client
    }

    private func api() throws -> PabootAPI {
        try clientOrThrow().api
    }

    func listByWorkspace(workspaceId: String) async throws -> [AgentProfileDto] {
        try await api().workspaceAgents(workspaceId: workspaceId).agents
    }

    func create(workspaceId: String, body: AgentProfileRequest) async throws -> AgentProfileDetailDto {
        try await api().createAgentProfile(workspaceId: workspaceId, body: body).agent
    }

    func detail(agentId: String) async throws -> AgentProfileDetailDto {
        try await api().agentProfile(id: agentId).agent
    }

    func update(agentId: String, body: AgentProfileRequest) async throws -> AgentProfileDetailDto {
        try await api().updateAgentProfile(id: agentId, body: body).agent
    }

    func delete(agentId: String) async throws {
        try await api().deleteAgentProfile(id: agentId)
    }

    func sessionAgents(sessionId: String) async throws -> SessionAgentsResponse {
        try await api().sessionAgents(sessionId: sessionId)
    }

    func addToSession(sessionId: String, agentId: String) async throws {
        try await api().addSessionAgent(sessionId: sessionId, agentId: agentId)
    }

    func removeFromSession(sessionId: String, agentId: String) async throws {
        try await api().removeSessionAgent(sessionId: sessionId, agentId: agentId)
    }

    func resetContext(sessionId: String, agentId: String) async throws {
        try await api().resetAgentContext(sessionId: sessionId, agentId: agentId)
    }
}
