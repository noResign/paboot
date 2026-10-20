import Combine
import PabootProtocol
import UIKit

/// Per-session permission sheet: mode for subsequent runs, and revoking "allow all" grants.
final class SessionPermissionsViewController: UIViewController {
    var onModeChanged: ((String) -> Void)?

    private let runtime: String
    private lazy var viewModel = SessionPermissionsViewModel(sessionId: sessionId)
    private let sessionId: String
    private var cancellables = Set<AnyCancellable>()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let statusStack = UIStackView()
    private let statusSpinner = UIActivityIndicatorView(style: .medium)
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)

    private var permissionRows: [PermissionModeRow] = []
    private let grantsStack = UIStackView()
    private let emptyGrantsLabel = UILabel()
    private let bypassNoteLabel = UILabel()
    private let revokeAllButton = UIButton(type: .system)

    private var hasPresentedActionError = false

    init(sessionId: String, runtime: String) {
        self.sessionId = sessionId
        self.runtime = runtime
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        title = "权限设置"
        view.backgroundColor = Theme.Colors.background

        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "关闭",
            style: .plain,
            target: self,
            action: #selector(close)
        )

        viewModel.onModeChanged = { [weak self] mode in
            self?.onModeChanged?(mode)
        }

        configureScrollView()
        configureContent()
        bind()

        Task { await viewModel.load() }
    }

    private func configureScrollView() {
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        contentStack.axis = .vertical
        contentStack.spacing = Spacing.sm
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

    private func configureContent() {
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

        var retryConfiguration = UIButton.Configuration.tinted()
        retryConfiguration.title = "重试"
        retryConfiguration.baseForegroundColor = Theme.Colors.primary
        retryConfiguration.baseBackgroundColor = Theme.Colors.primary
        retryButton.configuration = retryConfiguration
        retryButton.addAction(
            UIAction { [weak self] _ in
                Task { await self?.viewModel.load(showLoading: true) }
            },
            for: .touchUpInside
        )
        retryButton.isHidden = true

        contentStack.addArrangedSubview(statusStack)
        contentStack.addArrangedSubview(retryButton)

        contentStack.addArrangedSubview(makeSectionTitle("权限模式"))

        for option in PermissionModeOptions.options(runtime: runtime) {
            let row = PermissionModeRow(
                mode: option.mode,
                title: option.title,
                detail: option.detail
            )
            row.addAction(
                UIAction { [weak self] _ in
                    Task { await self?.viewModel.setMode(option.mode) }
                },
                for: .touchUpInside
            )
            permissionRows.append(row)
            contentStack.addArrangedSubview(row)
        }

        if let lastRow = permissionRows.last {
            contentStack.setCustomSpacing(Spacing.lg, after: lastRow)
        }

        contentStack.addArrangedSubview(makeSectionTitle("已授权工具"))

        emptyGrantsLabel.text = "暂无「允许全部」授权"
        emptyGrantsLabel.font = Typography.caption
        emptyGrantsLabel.textColor = Theme.Colors.textMuted
        contentStack.addArrangedSubview(emptyGrantsLabel)

        grantsStack.axis = .vertical
        grantsStack.spacing = Spacing.xs
        contentStack.addArrangedSubview(grantsStack)

        bypassNoteLabel.text = "当前为绕过审批，已授权工具处于暂停状态"
        bypassNoteLabel.font = Typography.caption
        bypassNoteLabel.textColor = Theme.Colors.warning
        bypassNoteLabel.numberOfLines = 0
        bypassNoteLabel.isHidden = true
        contentStack.addArrangedSubview(bypassNoteLabel)

        var revokeConfiguration = UIButton.Configuration.tinted()
        revokeConfiguration.title = "全部撤销"
        revokeConfiguration.baseForegroundColor = Theme.Colors.error
        revokeConfiguration.baseBackgroundColor = Theme.Colors.error
        revokeConfiguration.cornerStyle = .medium
        revokeAllButton.configuration = revokeConfiguration
        revokeAllButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        revokeAllButton.addAction(
            UIAction { [weak self] _ in self?.confirmRevokeAll() },
            for: .touchUpInside
        )
        contentStack.addArrangedSubview(revokeAllButton)

        let footnotes = UIStackView(arrangedSubviews: [
            makeFootnote("权限模式只对后续 Run 生效。"),
            makeFootnote("撤销授权只影响后续请求，不会撤回已经批准过的操作。"),
            makeFootnote("Codex 的权限扩展在服务端可持续到当前轮结束，要立即收回只能停止运行。"),
        ])
        footnotes.axis = .vertical
        footnotes.spacing = Spacing.xxs
        contentStack.setCustomSpacing(Spacing.lg, after: revokeAllButton)
        contentStack.addArrangedSubview(footnotes)
    }

    private func makeSectionTitle(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.cardTitle
        label.textColor = Theme.Colors.textPrimary
        return label
    }

    private func makeFootnote(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = "· \(text)"
        label.font = Typography.caption
        label.textColor = Theme.Colors.textMuted
        label.numberOfLines = 0
        return label
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: SessionPermissionsViewModel.State) {
        for row in permissionRows {
            row.setSelected(row.mode == state.mode)
        }

        rebuildGrants(state.grants)
        emptyGrantsLabel.isHidden = !state.grants.isEmpty
        bypassNoteLabel.isHidden = state.mode != "bypass" || state.grants.isEmpty
        revokeAllButton.isHidden = state.grants.isEmpty

        if state.isLoading {
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

        if let error = state.actionError, !hasPresentedActionError {
            hasPresentedActionError = true
            viewModel.consumeActionError()
            presentAlert(title: "操作失败", message: error) { [weak self] in
                self?.hasPresentedActionError = false
            }
        }
    }

    private func rebuildGrants(_ grants: [PermissionGrantDto]) {
        grantsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for grant in grants {
            let nameLabel = UILabel()
            nameLabel.text = grant.toolName
            nameLabel.font = Typography.body
            nameLabel.textColor = Theme.Colors.textPrimary

            let timeLabel = UILabel()
            if grant.createdAt > 0 {
                timeLabel.text = "授权于 \(Formatters.relativeTime(fromMilliseconds: grant.createdAt))"
            } else {
                timeLabel.text = nil
            }
            timeLabel.font = Typography.caption
            timeLabel.textColor = Theme.Colors.textMuted

            let textStack = UIStackView(arrangedSubviews: [nameLabel, timeLabel])
            textStack.axis = .vertical
            textStack.spacing = 2
            textStack.setContentHuggingPriority(.defaultLow, for: .horizontal)

            let revokeButton = UIButton(type: .system)
            revokeButton.setTitle("撤销", for: .normal)
            revokeButton.setTitleColor(Theme.Colors.primary, for: .normal)
            revokeButton.titleLabel?.font = Typography.caption
            revokeButton.setContentHuggingPriority(.required, for: .horizontal)
            revokeButton.addAction(
                UIAction { [weak self] _ in self?.confirmRevoke(grant.toolName) },
                for: .touchUpInside
            )

            let spacer = UIView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

            let row = UIStackView(arrangedSubviews: [textStack, spacer, revokeButton])
            row.axis = .horizontal
            row.alignment = .center
            row.spacing = Spacing.sm
            grantsStack.addArrangedSubview(row)
        }
    }

    private func confirmRevoke(_ toolName: String) {
        let alert = UIAlertController(
            title: "撤销授权？",
            message: "「\(toolName)」的「允许全部」授权会被移除，只影响后续请求。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "撤销", style: .destructive) { [weak self] _ in
            Task { await self?.viewModel.revoke(toolName: toolName) }
        })
        present(alert, animated: true)
    }

    private func confirmRevokeAll() {
        let alert = UIAlertController(
            title: "撤销全部授权？",
            message: "所有「允许全部」授权都会被移除，只影响后续请求。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "全部撤销", style: .destructive) { [weak self] _ in
            Task { await self?.viewModel.revokeAll() }
        })
        present(alert, animated: true)
    }

    private func presentAlert(title: String, message: String, onDismiss: (() -> Void)? = nil) {
        guard presentedViewController == nil else {
            onDismiss?()
            return
        }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in onDismiss?() })
        present(alert, animated: true)
    }

    @objc private func close() {
        dismiss(animated: true)
    }
}
