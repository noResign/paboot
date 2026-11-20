import PabootClient
import PabootProtocol
import UIKit

/// Sheet for starting a new conversation. The daemon creates the session on the first
/// `/api/chat` request, so this only chooses workspace / runtime / permission mode.
final class NewSessionViewController: UIViewController {
    /// `agentProfileId` 是新会话的主答助手；nil = 用工作区默认。
    var onStart: ((WorkspaceDto, AgentDto, String, String?) -> Void)?

    private let workspaceButton = UIButton(type: .system)
    private let workspaceHintLabel = UILabel()
    private let agentButton = UIButton(type: .system)
    private let permissionControl = UISegmentedControl(items: [])
    private let startButton = UIButton(type: .system)
    private let errorLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    private var agents: [AgentDto] = []
    private var selectedWorkspace: WorkspaceDto?
    private var selectedAgent: AgentDto?
    /// 工作区里可用的助手（主答候选）。老 daemon 上为空，picker 不显示。
    private var agentProfiles: [AgentProfileDto] = []
    private var selectedProfileId: String?
    private let profileButton = UIButton(type: .system)
    private var bypassAllowed = true
    private var permissionOptions = PermissionModeOptions.options(runtime: nil)

    override func viewDidLoad() {
        super.viewDidLoad()

        title = "新建会话"
        view.backgroundColor = Theme.Colors.background
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "取消",
            style: .plain,
            target: self,
            action: #selector(cancel)
        )

        configureViews()
        configureLayout()
        load()
    }

    private func configureViews() {
        stylePicker(workspaceButton, placeholder: "工作区")
        stylePicker(agentButton, placeholder: "选择 Agent")
        stylePicker(profileButton, placeholder: "主答：工作区默认")
        profileButton.showsMenuAsPrimaryAction = true
        // The workspace comes from the current selection; it is not switchable
        // from this sheet (s0_plan §4), so the button is a read-only display.
        workspaceButton.isUserInteractionEnabled = false
        agentButton.showsMenuAsPrimaryAction = true
        agentButton.menu = UIMenu(
            children: [UIAction(title: "加载中…", attributes: .disabled) { _ in }]
        )

        workspaceHintLabel.font = Typography.caption
        workspaceHintLabel.textColor = Theme.Colors.textSecondary
        workspaceHintLabel.numberOfLines = 0
        workspaceHintLabel.isHidden = true

        rebuildPermissionControl(selected: "ask")
        permissionControl.addTarget(self, action: #selector(permissionChanged), for: .valueChanged)

        startButton.setTitle("开始会话", for: .normal)
        startButton.titleLabel?.font = Typography.cardTitle
        startButton.setTitleColor(Theme.Colors.onPrimary, for: .normal)
        startButton.backgroundColor = Theme.Colors.primary
        startButton.layer.cornerRadius = Radius.card
        startButton.heightAnchor.constraint(equalToConstant: Layout.minTouchTarget).isActive = true
        startButton.addAction(
            UIAction { [weak self] _ in self?.start() },
            for: .touchUpInside
        )

        errorLabel.font = Typography.caption
        errorLabel.textColor = Theme.Colors.error
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true

        spinner.color = Theme.Colors.textSecondary
    }

    private func configureLayout() {
        let fields = UIStackView(arrangedSubviews: [
            fieldLabel("工作区"),
            workspaceButton,
            workspaceHintLabel,
            fieldLabel("Agent"),
            agentButton,
            fieldLabel("谁来主答"),
            profileButton,
            fieldLabel("权限模式"),
            permissionControl,
            startButton,
            errorLabel,
        ])
        fields.axis = .vertical
        fields.spacing = Spacing.sm
        fields.setCustomSpacing(Spacing.md, after: workspaceButton)
        fields.setCustomSpacing(Spacing.md, after: agentButton)
        fields.setCustomSpacing(Spacing.md, after: profileButton)

        let scrollView = UIScrollView()
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        fields.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(fields)
        view.addSubview(scrollView)
        view.addSubview(spinner)
        spinner.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            fields.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.lg),
            fields.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.lg),
            fields.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            fields.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            fields.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -Spacing.lg * 2),

            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func fieldLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        return label
    }

    private func stylePicker(_ button: UIButton, placeholder: String) {
        button.setTitle(placeholder, for: .normal)
        button.setTitleColor(Theme.Colors.textMuted, for: .normal)
        button.titleLabel?.font = Typography.body
        button.titleLabel?.lineBreakMode = .byTruncatingMiddle
        button.contentHorizontalAlignment = .leading
        button.backgroundColor = Theme.Colors.surface
        button.layer.cornerRadius = Radius.card
        button.contentEdgeInsets = UIEdgeInsets(
            top: Spacing.sm,
            left: Spacing.sm,
            bottom: Spacing.sm,
            right: Spacing.sm
        )
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: Layout.minTouchTarget).isActive = true
    }

    private func load() {
        spinner.startAnimating()
        errorLabel.isHidden = true

        Task {
            defer { spinner.stopAnimating() }

            do {
                guard let client = DaemonSession.shared.client else {
                    throw NewSessionLoadError.notConnected
                }

                async let workspacesRequest = client.api.workspaces()
                async let agentsRequest = client.api.agents()
                async let configRequest = client.api.config()

                let workspaces = try await workspacesRequest.workspaces
                let agents = try await agentsRequest.agents
                let config = try await configRequest

                self.agents = agents

                selectedWorkspace = workspaces.first(where: {
                    $0.id == WorkspaceSelection.shared.selectedId
                }) ?? workspaces.first(where: { $0.isDefault }) ?? workspaces.first
                // Workspace default wins, then the first available agent.
                if let preferred = selectedWorkspace?.defaultRuntime {
                    selectedAgent = agents.first(where: { $0.id == preferred && $0.available })
                }
                if selectedAgent == nil {
                    selectedAgent = agents.first(where: { $0.available })
                }

                // 助手列表是可选增强：老 daemon 上这个端点会 404，那时主答就用
                // 工作区默认，piker 隐藏 —— 不影响新建会话本身。
                if let workspaceId = selectedWorkspace?.id {
                    agentProfiles = (try? await client.api.workspaceAgents(workspaceId: workspaceId).agents) ?? []
                }

                bypassAllowed = config.bypassAllowed
                let requested = selectedWorkspace?.defaultPermissionMode ?? config.defaultPermissionMode
                rebuildPermissionControl(
                    selected: PermissionModeOptions.clamp(requested, bypassAllowed: bypassAllowed)
                )

                updateButtons()
            } catch let error as NewSessionLoadError {
                errorLabel.text = error.errorDescription
                errorLabel.isHidden = false
            } catch {
                errorLabel.text = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                errorLabel.isHidden = false
            }
        }
    }

    private func updateButtons() {
        if let workspace = selectedWorkspace {
            workspaceButton.setTitle(workspace.displayName, for: .normal)
            workspaceButton.setTitleColor(Theme.Colors.textPrimary, for: .normal)
            if let visiblePath = workspace.displayPath {
                workspaceHintLabel.text = "主目录：\(visiblePath)。其他目录会自动作为附加目录。"
                workspaceHintLabel.isHidden = false
            } else {
                workspaceHintLabel.isHidden = true
            }
        }

        if let agent = selectedAgent {
            let identity = RuntimeIdentity.resolve(id: agent.id, fallbackName: agent.name)
            agentButton.setTitle(identity.displayName, for: .normal)
            agentButton.setTitleColor(Theme.Colors.textPrimary, for: .normal)
        }
        agentButton.menu = makeAgentMenu()

        // 只在工作区里有助手时才显示这一项：老 daemon / 空工作区上，一个点了没反应的
        // 选择器比不显示更糟。
        profileButton.isHidden = agentProfiles.isEmpty
        let chosen = agentProfiles.first { $0.id == selectedProfileId }
        profileButton.setTitle(
            chosen.map { "主答：\($0.name)" } ?? "主答：工作区默认",
            for: .normal
        )
        profileButton.setTitleColor(Theme.Colors.textPrimary, for: .normal)
        profileButton.menu = makeProfileMenu()

        startButton.isEnabled = selectedWorkspace != nil && selectedAgent != nil
        startButton.alpha = startButton.isEnabled ? 1 : 0.5
    }

    private func makeAgentMenu() -> UIMenu {
        let actions = agents.map { agent in
            let identity = RuntimeIdentity.resolve(id: agent.id, fallbackName: agent.name)
            return UIAction(
                title: identity.displayName,
                attributes: agent.available ? [] : .disabled,
                state: agent.id == selectedAgent?.id ? .on : .off
            ) { [weak self] _ in
                guard let self else { return }
                let current = self.currentPermissionMode
                self.selectedAgent = agent
                self.rebuildPermissionControl(
                    selected: PermissionModeOptions.clamp(current, bypassAllowed: self.bypassAllowed)
                )
                self.updateButtons()
            }
        }
        return UIMenu(
            title: "选择 Agent",
            children: actions.isEmpty
                ? [UIAction(title: "暂无可用 Agent", attributes: .disabled) { _ in }]
                : actions
        )
    }

    private func makeProfileMenu() -> UIMenu {
        let defaultAction = UIAction(
            title: "工作区默认",
            state: selectedProfileId == nil ? .on : .off
        ) { [weak self] _ in
            self?.selectedProfileId = nil
            self?.updateButtons()
        }
        let actions = agentProfiles.map { profile in
            UIAction(
                title: profile.name,
                // 不可用的仍列出来但置灰：直接不显示会让人以为它被删了。
                attributes: profile.available ? [] : .disabled,
                state: profile.id == selectedProfileId ? .on : .off
            ) { [weak self] _ in
                self?.selectedProfileId = profile.id
                self?.updateButtons()
            }
        }
        return UIMenu(title: "谁来主答", children: [defaultAction] + actions)
    }

    @objc private func permissionChanged() {
        updateButtons()
    }

    private var currentPermissionMode: String {
        let index = permissionControl.selectedSegmentIndex
        guard index >= 0, index < permissionOptions.count else { return "ask" }
        return permissionOptions[index].mode
    }

    private func rebuildPermissionControl(selected: String) {
        let options = PermissionModeOptions.options(
            runtime: selectedAgent?.id,
            bypassAllowed: bypassAllowed
        )
        permissionOptions = options
        permissionControl.removeAllSegments()
        for (index, option) in options.enumerated() {
            permissionControl.insertSegment(withTitle: option.title, at: index, animated: false)
        }
        let mode = options.contains(where: { $0.mode == selected }) ? selected : "acceptEdits"
        if let index = options.firstIndex(where: { $0.mode == mode }) {
            permissionControl.selectedSegmentIndex = index
        } else {
            permissionControl.selectedSegmentIndex = UISegmentedControl.noSegment
        }
    }

    @objc private func cancel() {
        dismiss(animated: true)
    }

    private func start() {
        guard let workspace = selectedWorkspace, let agent = selectedAgent else { return }
        onStart?(workspace, agent, currentPermissionMode, selectedProfileId)
    }
}

private enum NewSessionLoadError: Error {
    case notConnected
}

extension NewSessionLoadError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "当前没有连接，请先连接 daemon"
        }
    }
}
