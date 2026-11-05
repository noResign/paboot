import PabootClient
import PabootProtocol
import UIKit

/// Sheet for starting a new conversation. The daemon creates the session on the first
/// `/api/chat` request, so this only chooses workspace / runtime / permission mode.
final class NewSessionViewController: UIViewController {
    var onStart: ((WorkspaceDto, AgentDto, String) -> Void)?

    private let workspaceButton = UIButton(type: .system)
    private let workspaceHintLabel = UILabel()
    private let agentButton = UIButton(type: .system)
    private let permissionControl = UISegmentedControl(items: ["询问", "自动编辑", "绕过"])
    private let startButton = UIButton(type: .system)
    private let errorLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    private var agents: [AgentDto] = []
    private var selectedWorkspace: WorkspaceDto?
    private var selectedAgent: AgentDto?

    private let permissionModes = ["ask", "acceptEdits", "bypass"]

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

        permissionControl.selectedSegmentIndex = 0
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
            fieldLabel("权限模式"),
            permissionControl,
            startButton,
            errorLabel,
        ])
        fields.axis = .vertical
        fields.spacing = Spacing.sm
        fields.setCustomSpacing(Spacing.md, after: workspaceButton)
        fields.setCustomSpacing(Spacing.md, after: agentButton)

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

                let mode = selectedWorkspace?.defaultPermissionMode ?? config.defaultPermissionMode
                if let index = permissionModes.firstIndex(of: mode) {
                    permissionControl.selectedSegmentIndex = index
                }

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
            workspaceHintLabel.text = workspace.isBuiltin && workspace.family != "life"
                ? "内置工作区只是临时目录，建议先在设置里添加真实工作区。"
                : "主目录：\(workspace.path)。其他目录会自动作为附加目录。"
            workspaceHintLabel.isHidden = false
        }

        if let agent = selectedAgent {
            let identity = RuntimeIdentity.resolve(id: agent.id, fallbackName: agent.name)
            agentButton.setTitle(identity.displayName, for: .normal)
            agentButton.setTitleColor(Theme.Colors.textPrimary, for: .normal)
        }
        agentButton.menu = makeAgentMenu()

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
                self?.selectedAgent = agent
                self?.updateButtons()
            }
        }
        return UIMenu(
            title: "选择 Agent",
            children: actions.isEmpty
                ? [UIAction(title: "暂无可用 Agent", attributes: .disabled) { _ in }]
                : actions
        )
    }

    @objc private func permissionChanged() {
        updateButtons()
    }

    @objc private func cancel() {
        dismiss(animated: true)
    }

    private func start() {
        guard let workspace = selectedWorkspace, let agent = selectedAgent else { return }
        let mode = permissionModes[permissionControl.selectedSegmentIndex]
        onStart?(workspace, agent, mode)
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
