import Combine
import PabootProtocol
import UIKit

/// One conversation: transcript, composer, approvals, session settings.
final class ChatViewController: UIViewController {
    private let viewModel: ChatViewModel
    var sessionIdentifier: String? { viewModel.state.sessionId }
    private var cancellables = Set<AnyCancellable>()

    private let tableView = UITableView(frame: .zero, style: .plain)
    private let bottomBar = ChatBottomBar()
    private var inputBar: ChatInputBar { bottomBar.inputBar }
    private let todoPanel = TodoPanelView()
    private let reconnectBanner = UILabel()
    private let loadingOverlay = UIView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let jumpButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private var bottomStack: UIStackView!

    private var dataSource: UITableViewDiffableDataSource<String, String>!
    private var messagesByID: [String: ChatUiMessage] = [:]
    private var lastMessageIDs: [String] = []
    private var hasRenderedOnce = false
    private var isFollowingBottom = true
    private var isUpdatingBottomInset = false
    private var isScrollingToBottom = false
    private var lastTableViewSize: CGSize = .zero
    private var presentedPermissionID: String?
    private var permissionAlert: UIViewController?
    private var dismissingPermission = false
    private var menuSignature: String?
    private var lastPresentedError: String?
    private var presentedError = false

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = Theme.Colors.background
        navigationItem.largeTitleDisplayMode = .never

        configureNavigationTitle()
        configureTable()
        configureBottomStack()
        configureKeyboardDismissal()
        configureLoadingOverlay()
        configureJumpButton()
        configureDataSource()
        bind()

        viewModel.start()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Re-render on return so approvals/errors that arrived while another tab was
        // visible are presented now.
        render(viewModel.state)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let id = sessionIdentifier { RunNotifications.shared.clearSession(id) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard bottomStack != nil, !isUpdatingBottomInset else { return }
        let overlap = max(0, tableView.frame.maxY - bottomStack.frame.minY)
        let inset = overlap + Spacing.md
        let viewportChanged = tableView.bounds.size != lastTableViewSize
        lastTableViewSize = tableView.bounds.size
        guard abs(tableView.contentInset.bottom - inset) > 0.5 else {
            // Pin only when the viewport actually resized (keyboard, rotation,
            // split view). Cell growth and unrelated layout passes must not move
            // the list, and a layout change must never fight an active pan.
            if viewportChanged, canAutoScroll {
                scrollToBottom()
            }
            return
        }
        isUpdatingBottomInset = true
        let offset = tableView.contentOffset
        tableView.contentInset.bottom = inset
        tableView.verticalScrollIndicatorInsets.bottom = overlap
        if isFollowingBottom, !tableView.isDragging, !tableView.isDecelerating {
            scrollToBottom()
        } else {
            tableView.setContentOffset(offset, animated: false)
        }
        isUpdatingBottomInset = false
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isMovingFromParent || isBeingDismissed {
            viewModel.detach()
        }
    }

    // MARK: - Layout

    private func configureNavigationTitle() {
        titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingTail

        subtitleLabel.font = Typography.caption
        subtitleLabel.textColor = Theme.Colors.textSecondary
        subtitleLabel.textAlignment = .center
        subtitleLabel.lineBreakMode = .byTruncatingMiddle
        subtitleLabel.numberOfLines = 1
        subtitleLabel.isHidden = true

        let stack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 0
        navigationItem.titleView = stack
    }

    private func configureTable() {
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = Theme.Colors.background
        tableView.separatorStyle = .none
        tableView.keyboardDismissMode = .interactive
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 120
        tableView.contentInset = UIEdgeInsets(top: Spacing.sm, left: 0, bottom: Spacing.md, right: 0)
        tableView.register(
            UserMessageCell.self,
            forCellReuseIdentifier: UserMessageCell.reuseIdentifier
        )
        tableView.register(
            AssistantMessageCell.self,
            forCellReuseIdentifier: AssistantMessageCell.reuseIdentifier
        )
        tableView.delegate = self

        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func configureBottomStack() {
        reconnectBanner.text = "连接中断，正在重连…"
        reconnectBanner.font = Typography.caption
        reconnectBanner.textColor = Theme.Colors.warning
        reconnectBanner.textAlignment = .center
        reconnectBanner.backgroundColor = Theme.Colors.warning.withAlphaComponent(0.12)
        reconnectBanner.isHidden = true
        reconnectBanner.heightAnchor.constraint(greaterThanOrEqualToConstant: 28).isActive = true

        todoPanel.isHidden = true

        inputBar.onSend = { [weak self] text in
            guard let self else { return }
            self.isFollowingBottom = true
            self.jumpButton.isHidden = true
            self.viewModel.send(text)
        }
        inputBar.onStop = { [weak self] in
            self?.viewModel.stop()
        }

        bottomBar.onNavigate = { [weak self] destination in
            guard let self else { return }
            self.view.endEditing(true)
            (self.navigationController?.parent as? MainTabBarController)?.navigateFromChat(to: destination)
        }

        bottomStack = UIStackView(arrangedSubviews: [reconnectBanner, todoPanel, bottomBar])
        bottomStack.axis = .vertical
        bottomStack.spacing = 0
        bottomStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottomStack)

        // With the keyboard dismissed, rest 8 pt below the safe area. With it
        // visible, the required upper bound keeps the composer above the keyboard.
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        let keyboardBottom = bottomStack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        keyboardBottom.priority = .defaultHigh
        NSLayoutConstraint.activate([
            bottomStack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomStack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            keyboardBottom,
            bottomStack.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor),
            bottomStack.bottomAnchor.constraint(
                lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: ChatBottomBar.bottomOffset
            ),
            tableView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
    }

    private func configureKeyboardDismissal() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        view.addGestureRecognizer(tap)
    }

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }

    private func configureLoadingOverlay() {
        loadingOverlay.translatesAutoresizingMaskIntoConstraints = false
        loadingOverlay.backgroundColor = Theme.Colors.background
        loadingOverlay.isHidden = true

        let label = UILabel()
        label.text = "正在加载对话…"
        label.font = Typography.body
        label.textColor = Theme.Colors.textSecondary

        let stack = UIStackView(arrangedSubviews: [loadingSpinner, label])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        loadingOverlay.addSubview(stack)

        view.addSubview(loadingOverlay)
        NSLayoutConstraint.activate([
            loadingOverlay.topAnchor.constraint(equalTo: tableView.topAnchor),
            loadingOverlay.bottomAnchor.constraint(equalTo: bottomStack.topAnchor),
            loadingOverlay.leadingAnchor.constraint(equalTo: tableView.leadingAnchor),
            loadingOverlay.trailingAnchor.constraint(equalTo: tableView.trailingAnchor),
            stack.centerXAnchor.constraint(equalTo: loadingOverlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: loadingOverlay.centerYAnchor),
        ])
    }

    private func configureJumpButton() {
        var configuration = UIButton.Configuration.filled()
        configuration.image = UIImage(systemName: "arrow.down.to.line")
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        configuration.baseBackgroundColor = Theme.Colors.surface2.withAlphaComponent(0.85)
        configuration.baseForegroundColor = Theme.Colors.textSecondary
        configuration.cornerStyle = .capsule
        // A smaller visual button while retaining the full 44 pt touch target.
        configuration.background.backgroundInsets = NSDirectionalEdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4)

        jumpButton.configuration = configuration
        jumpButton.translatesAutoresizingMaskIntoConstraints = false
        jumpButton.isHidden = true
        jumpButton.accessibilityLabel = "回到底部"
        jumpButton.accessibilityIdentifier = "chat.jumpToBottom"
        jumpButton.addAction(
            UIAction { [weak self] _ in
                guard let self else { return }
                self.isFollowingBottom = true
                self.jumpButton.isHidden = true
                // Resolve estimated row heights at the destination before aligning
                // the content end. A long animated offset can use stale estimates.
                self.scrollToBottom()
            },
            for: .touchUpInside
        )
        view.addSubview(jumpButton)

        NSLayoutConstraint.activate([
            jumpButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.md),
            jumpButton.bottomAnchor.constraint(equalTo: bottomStack.topAnchor, constant: -Spacing.sm),
            jumpButton.widthAnchor.constraint(equalToConstant: 44),
            jumpButton.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func configureDataSource() {
        dataSource = UITableViewDiffableDataSource<String, String>(
            tableView: tableView
        ) { [weak self] tableView, indexPath, id in
            guard let self, let message = self.messagesByID[id] else {
                return UITableViewCell()
            }

            switch message.role {
            case .user:
                let cell = tableView.dequeueReusableCell(
                    withIdentifier: UserMessageCell.reuseIdentifier,
                    for: indexPath
                ) as! UserMessageCell
                cell.configure(text: message.text)
                return cell

            case .assistant:
                let cell = tableView.dequeueReusableCell(
                    withIdentifier: AssistantMessageCell.reuseIdentifier,
                    for: indexPath
                ) as! AssistantMessageCell
                cell.configure(
                    message: message,
                    streaming: self.viewModel.state.streaming
                ) { [weak self] toolUseId, text in
                    guard let self else { return }
                    self.isFollowingBottom = true
                    self.jumpButton.isHidden = true
                    self.viewModel.answerQuestion(toolUseId: toolUseId, answerText: text)
                }
                return cell
            }
        }
        dataSource.defaultRowAnimation = .fade
    }

    private func bind() {
        viewModel.$state
            .throttle(for: .milliseconds(80), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    // MARK: - Rendering

    private func render(_ state: ChatViewModel.State) {
        titleLabel.text = state.title
        updateSubtitle(state)
        inputBar.setStreaming(state.streaming)
        inputBar.isUserInteractionEnabled = !state.loadingHistory
        inputBar.alpha = state.loadingHistory ? 0.6 : 1
        reconnectBanner.isHidden = !state.reconnecting
        todoPanel.configure(state.todos)
        updateMenu(state)
        updateLoading(state)
        updatePermissionAlert(state.permission)

        if let error = state.error {
            if view.window != nil {
                let needsReconnect = state.requiresReconnect
                viewModel.consumeError()
                presentError(error, needsReconnect: needsReconnect)
            }
        } else {
            lastPresentedError = nil
        }

        messagesByID = Dictionary(
            state.messages.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        let ids = state.messages.map(\.id)
        if ids != lastMessageIDs {
            lastMessageIDs = ids
            var snapshot = NSDiffableDataSourceSnapshot<String, String>()
            snapshot.appendSections(["messages"])
            snapshot.appendItems(ids, toSection: "messages")
            dataSource.apply(snapshot, animatingDifferences: hasRenderedOnce) { [weak self] in
                guard let self, self.canAutoScroll else { return }
                self.scrollToBottom()
                self.alignToBottomAfterLayoutSettles()
            }
            hasRenderedOnce = true
        } else if let last = ids.last {
            var snapshot = dataSource.snapshot()
            snapshot.reconfigureItems([last])
            dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
                guard let self, self.canAutoScroll else { return }
                self.scrollToBottom()
                self.alignToBottomAfterLayoutSettles()
            }
        }

        if canAutoScroll {
            scrollToBottom()
        }
        jumpButton.isHidden = isFollowingBottom || ids.isEmpty
    }

    private func updateSubtitle(_ state: ChatViewModel.State) {
        var parts: [String] = []
        if !state.runtime.isEmpty { parts.append(state.runtime) }
        if !state.cwd.isEmpty { parts.append(state.cwd) }
        if let usage = state.contextUsage { parts.append(usage.display) }

        subtitleLabel.text = parts.joined(separator: " · ")
        subtitleLabel.isHidden = parts.isEmpty
    }

    private func updateLoading(_ state: ChatViewModel.State) {
        let loading = state.loadingHistory && state.messages.isEmpty
        loadingOverlay.isHidden = !loading
        if loading {
            loadingSpinner.startAnimating()
        } else {
            loadingSpinner.stopAnimating()
        }
    }

    private var canAutoScroll: Bool {
        isFollowingBottom && !isScrollingToBottom
            && !tableView.isDragging && !tableView.isDecelerating
    }

    private func contentEnd() -> CGFloat {
        max(
            -tableView.adjustedContentInset.top,
            tableView.contentSize.height + tableView.adjustedContentInset.bottom - tableView.bounds.height
        )
    }

    private func scrollToBottom() {
        guard !lastMessageIDs.isEmpty, !isScrollingToBottom else { return }
        isScrollingToBottom = true
        defer { isScrollingToBottom = false }

        tableView.layoutIfNeeded()
        guard abs(tableView.contentOffset.y - contentEnd()) > 0.5 else { return }
        // Resolve estimated row heights at the destination before aligning the end.
        if let last = dataSource.indexPath(for: lastMessageIDs.last!) {
            tableView.scrollToRow(at: last, at: .bottom, animated: false)
            tableView.layoutIfNeeded()
        }
        let bottom = contentEnd()
        guard abs(tableView.contentOffset.y - bottom) > 0.5 else { return }
        tableView.setContentOffset(CGPoint(x: tableView.contentOffset.x, y: bottom), animated: false)
    }

    /// Self-sizing rows can resolve after the snapshot's layout cycle, which moves
    /// the content end. Re-align once the next run loop has applied those heights
    /// so entering a long conversation (or a batch of new messages) lands at the
    /// bottom instead of a screen short.
    private func alignToBottomAfterLayoutSettles() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.canAutoScroll else { return }
            self.tableView.layoutIfNeeded()
            guard abs(self.tableView.contentOffset.y - self.contentEnd()) > 0.5 else { return }
            self.scrollToBottom()
        }
    }

    // MARK: - Header menu

    private func updateMenu(_ state: ChatViewModel.State) {
        let signature = [
            state.permissionMode,
            state.model ?? "",
            state.sessionId ?? "",
            state.models.map(\.id).joined(separator: ","),
            state.modelParameters.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: ","),
        ].joined(separator: "|")

        guard signature != menuSignature else { return }
        menuSignature = signature

        let permissionLabels = [
            ("ask", "询问"),
            ("acceptEdits", "自动接受编辑"),
            ("bypass", "绕过审批"),
        ]

        var permissionActions: [UIMenuElement] = []
        for (mode, label) in permissionLabels {
            permissionActions.append(
                UIAction(
                    title: label,
                    state: state.permissionMode == mode ? .on : .off
                ) { [weak self] _ in
                    self?.viewModel.setPermissionMode(mode)
                }
            )
        }

        var modelChildren: [UIMenuElement] = []
        modelChildren.append(
            UIAction(
                title: "默认模型",
                state: state.model == nil ? .on : .off
            ) { [weak self] _ in
                self?.viewModel.setModel(nil)
            }
        )

        for model in state.models {
            modelChildren.append(
                UIAction(
                    title: model.label,
                    state: state.model == model.id ? .on : .off
                ) { [weak self] _ in
                    self?.viewModel.setModel(model.id)
                }
            )
        }

        if let selected = state.models.first(where: { $0.id == state.model }) {
            for parameter in selected.parameters where !parameter.values.isEmpty {
                var children: [UIMenuElement] = []
                children.append(
                    UIAction(
                        title: "默认",
                        state: state.modelParameters[parameter.id] == nil ? .on : .off
                    ) { [weak self] _ in
                        self?.viewModel.setModelParameter(parameter.id, valueId: nil)
                    }
                )
                for value in parameter.values {
                    children.append(
                        UIAction(
                            title: value.label,
                            state: state.modelParameters[parameter.id] == value.id ? .on : .off
                        ) { [weak self] _ in
                            self?.viewModel.setModelParameter(parameter.id, valueId: value.id)
                        }
                    )
                }
                modelChildren.append(UIMenu(title: parameter.label, children: children))
            }
        }

        let modelMenu = UIMenu(
            title: "模型：\(viewModel.modelLabel)",
            children: modelChildren
        )
        var permissionSettingsAttributes: UIAction.Attributes = []
        if state.sessionId == nil {
            permissionSettingsAttributes = .disabled
        }
        let permissionSettings = UIAction(
            title: "权限设置…",
            attributes: permissionSettingsAttributes
        ) { [weak self] _ in
            self?.presentPermissionSettings()
        }

        var tasksAttributes: UIAction.Attributes = []
        if state.sessionId == nil {
            tasksAttributes = .disabled
        }
        let tasksAction = UIAction(
            title: "定时任务",
            attributes: tasksAttributes
        ) { [weak self] _ in
            self?.openSessionTasks()
        }

        let menu = UIMenu(children: [
            UIMenu(title: "权限模式", options: .displayInline, children: permissionActions),
            modelMenu,
            UIMenu(options: .displayInline, children: [tasksAction, permissionSettings]),
        ])

        let item = UIBarButtonItem(
            title: nil,
            image: UIImage(
                systemName: "slider.horizontal.3",
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)
            ),
            primaryAction: nil,
            menu: menu
        )
        item.accessibilityLabel = "会话设置"
        navigationItem.rightBarButtonItem = item
    }

    private func openSessionTasks() {
        guard let sessionId = viewModel.state.sessionId else { return }
        let controller = TasksViewController(
            viewModel: ScheduledTasksViewModel(sessionFilterId: sessionId),
            screenTitle: "定时任务"
        )
        navigationController?.pushViewController(controller, animated: true)
    }

    private func presentPermissionSettings() {
        guard let sessionId = viewModel.state.sessionId else { return }

        let permissions = SessionPermissionsViewController(
            sessionId: sessionId,
            runtime: viewModel.state.runtime
        )
        permissions.onModeChanged = { [weak self] mode in
            self?.viewModel.applyPermissionMode(mode)
        }

        let navigation = UINavigationController(rootViewController: permissions)
        navigation.modalPresentationStyle = .pageSheet
        if let presentation = navigation.sheetPresentationController {
            presentation.detents = [.medium(), .large()]
            presentation.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    // MARK: - Permissions

    private func updatePermissionAlert(_ permission: PendingPermission?) {
        guard !dismissingPermission else { return }
        if permission?.permissionId != presentedPermissionID, let existing = permissionAlert {
            permissionAlert = nil
            presentedPermissionID = nil
            // UIAlertController may already have dismissed itself after an action.
            // Only wait for a dismissal completion while it still has a presenter.
            if existing.presentingViewController != nil {
                dismissingPermission = true
                existing.dismiss(animated: true) { [weak self] in
                    guard let self else { return }
                    self.dismissingPermission = false
                    self.updatePermissionAlert(self.viewModel.state.permission)
                }
                return
            }
        }
        guard let permission else {
            presentedPermissionID = nil
            return
        }
        if permission.permissionId == presentedPermissionID {
            if let navigation = permissionAlert as? UINavigationController,
               let input = navigation.viewControllers.first as? UserInputViewController {
                input.update(
                    submitting: viewModel.state.submittingPermissionId == permission.permissionId,
                    error: viewModel.state.permissionError
                )
            }
            return
        }
        presentPermission(permission)
    }

    private func presentPermission(_ permission: PendingPermission) {
        guard view.window != nil, presentedViewController == nil else { return }
        presentedPermissionID = permission.permissionId

        if permission.toolName == "UserInput" {
            let input = UserInputViewController(input: permission.toolInput)
            input.onDecision = { [weak self] decision, response in
                self?.viewModel.decidePermission(
                    decision, permissionId: permission.permissionId, response: response
                )
            }
            let navigation = UINavigationController(rootViewController: input)
            navigation.isModalInPresentation = true
            navigation.sheetPresentationController?.detents = [.large()]
            permissionAlert = navigation
            input.update(
                submitting: viewModel.state.submittingPermissionId == permission.permissionId,
                error: viewModel.state.permissionError
            )
            present(navigation, animated: true)
            return
        }

        let alert = UIAlertController(
            title: "\(permission.toolName) 请求权限",
            message: describeToolInput(permission.toolInput),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "允许", style: .default) { [weak self] _ in
            self?.viewModel.decidePermission("allow", permissionId: permission.permissionId)
        })
        alert.addAction(UIAlertAction(title: "全部允许", style: .default) { [weak self] _ in
            self?.viewModel.decidePermission("allow_all", permissionId: permission.permissionId)
        })
        alert.addAction(UIAlertAction(title: "拒绝", style: .destructive) { [weak self] _ in
            self?.viewModel.decidePermission("deny", permissionId: permission.permissionId)
        })

        permissionAlert = alert
        present(alert, animated: true)
    }

    private func describeToolInput(_ input: JSONValue?) -> String {
        guard let input,
              let data = try? JSONEncoder().encode(input),
              let text = String(data: data, encoding: .utf8) else {
            return "允许 agent 执行此操作。"
        }
        return String(text.prefix(1_000))
    }

    // MARK: - Errors

    private func presentError(_ message: String, needsReconnect: Bool) {
        guard message != lastPresentedError, presentedViewController == nil else { return }
        lastPresentedError = message

        // A failed decision leaves the permission pending; allow it to be presented again
        // once this error alert is dismissed.
        if viewModel.state.permission != nil {
            presentedPermissionID = nil
            permissionAlert = nil
        }

        let alert = UIAlertController(title: "出错了", message: message, preferredStyle: .alert)
        if needsReconnect {
            alert.addAction(UIAlertAction(title: "重新连接", style: .default) { _ in
                AppRouter.shared.showConnect()
            })
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
                guard let self else { return }
                self.render(self.viewModel.state)
            })
        } else {
            alert.addAction(UIAlertAction(title: "好", style: .default) { [weak self] _ in
                guard let self else { return }
                self.render(self.viewModel.state)
            })
        }
        present(alert, animated: true)
    }
}

extension ChatViewController: UITableViewDelegate {
    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        guard scrollView === tableView else { return true }
        // A status-bar tap scrolls without dragging or decelerating; treat it as
        // a user scroll so the next layout or render does not snap back.
        isFollowingBottom = false
        jumpButton.isHidden = lastMessageIDs.isEmpty
        return true
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === tableView, !isUpdatingBottomInset, !isScrollingToBottom,
              scrollView.isDragging || scrollView.isDecelerating else { return }
        // Self-sizing rows and snapshot updates also invoke this delegate. Only
        // an actual user scroll may turn off the request to follow the bottom.

        let distance = tableView.contentSize.height
            + tableView.adjustedContentInset.bottom
            - tableView.contentOffset.y
            - tableView.bounds.height
        isFollowingBottom = distance < 80
        jumpButton.isHidden = isFollowingBottom || lastMessageIDs.isEmpty
    }
}

extension ChatViewController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Keep typing and composer actions focused; taps elsewhere dismiss the keyboard.
        var touchedView = touch.view
        while let current = touchedView {
            if current === bottomBar || current is UITextField {
                return false
            }
            if let textView = current as? UITextView, textView.isEditable {
                return false
            }
            touchedView = current.superview
        }
        return true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        // Card expansion and text selection should still receive the same interaction.
        true
    }
}
