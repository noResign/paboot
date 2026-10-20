import Combine
import PabootProtocol
import UIKit

/// Settings tab: connection, current workspace, new-session defaults, about.
final class SettingsViewController: UIViewController {
    private lazy var viewModel = SettingsViewModel()
    private var cancellables = Set<AnyCancellable>()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()

    private let addressRow = SettingsInfoRow(title: "服务器地址", monospaced: true)
    private let tokenRow = SettingsInfoRow(title: "token")
    private let reconnectButton = UIButton(type: .system)

    private let statusStack = UIStackView()
    private let statusSpinner = UIActivityIndicatorView(style: .medium)
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)

    private let currentWorkspaceRow = SettingsInfoRow(title: "当前工作区", monospaced: true)
    private let manageWorkspacesButton = UIButton(type: .system)

    private let permissionErrorLabel = UILabel()
    private var permissionRows: [PermissionModeRow] = []

    private let appVersionRow = SettingsInfoRow(title: "App 版本")
    private let daemonVersionRow = SettingsInfoRow(title: "daemon 版本")

    private var hasLoaded = false

    override func viewDidLoad() {
        super.viewDidLoad()

        title = "设置"
        view.backgroundColor = Theme.Colors.background

        configureScrollView()
        configureSections()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        Task { await viewModel.load(showLoading: !hasLoaded) }
        hasLoaded = true
    }

    private func configureScrollView() {
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        contentStack.axis = .vertical
        contentStack.spacing = Spacing.md
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(scrollView)
        scrollView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            contentStack.topAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.topAnchor,
                constant: Spacing.lg
            ),
            contentStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor,
                constant: -Spacing.lg
            ),
            contentStack.leadingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.leadingAnchor,
                constant: Spacing.lg
            ),
            contentStack.trailingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.trailingAnchor,
                constant: -Spacing.lg
            ),
            contentStack.widthAnchor.constraint(
                equalTo: scrollView.frameLayoutGuide.widthAnchor,
                constant: -Spacing.lg * 2
            ),
        ])
    }

    private func configureSections() {
        configureConnectionSection()
        configureStatusSection()
        configureWorkspaceSection()
        configurePermissionSection()
        configureAboutSection()
        bind()
    }

    private func configureConnectionSection() {
        configureActionButton(reconnectButton, title: "重新连接")
        reconnectButton.addAction(
            UIAction { _ in AppRouter.shared.showConnect() },
            for: .touchUpInside
        )

        contentStack.addArrangedSubview(SettingsSectionTitle("连接"))
        contentStack.addArrangedSubview(addressRow)
        contentStack.addArrangedSubview(tokenRow)
        contentStack.addArrangedSubview(reconnectButton)
    }

    private func configureStatusSection() {
        statusSpinner.color = Theme.Colors.textSecondary
        statusSpinner.hidesWhenStopped = true

        statusLabel.font = Typography.caption
        statusLabel.textColor = Theme.Colors.textSecondary
        statusLabel.numberOfLines = 0

        statusStack.axis = .vertical
        statusStack.alignment = .leading
        statusStack.spacing = Spacing.xs
        statusStack.addArrangedSubview(statusSpinner)
        statusStack.addArrangedSubview(statusLabel)
        statusStack.isHidden = true

        configureActionButton(retryButton, title: "重试")
        retryButton.addAction(
            UIAction { [weak self] _ in
                Task { await self?.viewModel.load(showLoading: true) }
            },
            for: .touchUpInside
        )
        retryButton.isHidden = true

        contentStack.addArrangedSubview(statusStack)
        contentStack.addArrangedSubview(retryButton)
    }

    private func configureWorkspaceSection() {
        configureActionButton(manageWorkspacesButton, title: "管理工作区")
        manageWorkspacesButton.addAction(
            UIAction { [weak self] _ in self?.openWorkspaceManagement() },
            for: .touchUpInside
        )

        contentStack.addArrangedSubview(SettingsSectionTitle("工作区"))
        contentStack.addArrangedSubview(currentWorkspaceRow)
        contentStack.addArrangedSubview(manageWorkspacesButton)
    }

    private func configurePermissionSection() {
        contentStack.addArrangedSubview(SettingsSectionTitle("新会话默认权限"))

        for option in PermissionModeOptions.options(runtime: nil) {
            let row = PermissionModeRow(
                mode: option.mode,
                title: option.title,
                detail: option.detail
            )
            row.addAction(
                UIAction { [weak self] _ in
                    Task { await self?.viewModel.setDefaultPermissionMode(option.mode) }
                },
                for: .touchUpInside
            )
            permissionRows.append(row)
            contentStack.addArrangedSubview(row)
        }

        permissionErrorLabel.font = Typography.caption
        permissionErrorLabel.textColor = Theme.Colors.error
        permissionErrorLabel.numberOfLines = 0
        permissionErrorLabel.isHidden = true
        contentStack.addArrangedSubview(permissionErrorLabel)
    }

    private func configureAboutSection() {
        contentStack.addArrangedSubview(SettingsSectionTitle("关于"))
        contentStack.addArrangedSubview(appVersionRow)
        contentStack.addArrangedSubview(daemonVersionRow)
    }

    private func configureActionButton(_ button: UIButton, title: String) {
        var configuration = UIButton.Configuration.tinted()
        configuration.title = title
        configuration.baseForegroundColor = Theme.Colors.primary
        configuration.baseBackgroundColor = Theme.Colors.primary
        configuration.cornerStyle = .medium
        button.configuration = configuration
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: SettingsViewModel.State) {
        let connection = DaemonSession.shared.connection
        addressRow.setValue(connection?.baseUrl ?? "未配置")
        tokenRow.setValue(connection == nil ? "未配置" : "••••••••")
        currentWorkspaceRow.setValue(state.selectedWorkspacePath ?? "未选择")

        for row in permissionRows {
            row.setSelected(row.mode == state.defaultPermissionMode)
        }

        permissionErrorLabel.text = state.permissionModeError
        permissionErrorLabel.isHidden = state.permissionModeError == nil

        appVersionRow.setValue(Self.appVersion)
        daemonVersionRow.setValue(state.daemonVersion ?? "未知")

        if state.isLoading && state.workspaces.isEmpty {
            statusStack.isHidden = false
            statusSpinner.startAnimating()
            statusLabel.text = "正在加载…"
            retryButton.isHidden = true
        } else if let error = state.loadError {
            statusStack.isHidden = false
            statusSpinner.stopAnimating()
            statusLabel.text = error
            retryButton.isHidden = false
        } else {
            statusStack.isHidden = true
            statusSpinner.stopAnimating()
            retryButton.isHidden = true
        }

        manageWorkspacesButton.isEnabled = !state.workspaces.isEmpty
        manageWorkspacesButton.alpha = state.workspaces.isEmpty ? 0.5 : 1
    }

    private func openWorkspaceManagement() {
        navigationController?.pushViewController(WorkspaceManagementViewController(), animated: true)
    }

    private static var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String

        switch (version, build) {
        case let (version?, build?) where !version.isEmpty && !build.isEmpty:
            return "\(version) (\(build))"
        case let (version?, _):
            return version
        default:
            return "未知"
        }
    }
}

private final class SettingsSectionTitle: UILabel {
    init(_ text: String) {
        super.init(frame: .zero)
        self.text = text
        font = Typography.cardTitle
        textColor = Theme.Colors.textPrimary
        numberOfLines = 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

private final class SettingsInfoRow: UIView {
    private let valueLabel = UILabel()

    init(title: String, monospaced: Bool = false) {
        super.init(frame: .zero)

        let titleLabel = UILabel()
        titleLabel.text = title
        titleLabel.font = Typography.caption
        titleLabel.textColor = Theme.Colors.textSecondary
        titleLabel.setContentHuggingPriority(.required, for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        valueLabel.font = monospaced ? Typography.code : Typography.body
        valueLabel.textColor = Theme.Colors.textPrimary
        valueLabel.textAlignment = .right
        valueLabel.lineBreakMode = .byTruncatingMiddle
        valueLabel.numberOfLines = 1

        let stack = UIStackView(arrangedSubviews: [titleLabel, valueLabel])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = Spacing.md
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xxs),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.xxs),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setValue(_ value: String) {
        valueLabel.text = value
        valueLabel.accessibilityLabel = value
    }
}
