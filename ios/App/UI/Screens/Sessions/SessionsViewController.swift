import Combine
import PabootProtocol
import UIKit

/// Session list for the selected workspace: root cwd flat, subdirectory cwds grouped.
final class SessionsViewController: UIViewController {
    private lazy var viewModel = SessionListViewModel()
    private var cancellables = Set<AnyCancellable>()

    private let tableView = UITableView(frame: .zero, style: .plain)
    private let refreshIndicatorContainer = UIView()
    private let refreshSpinner = UIActivityIndicatorView(style: .medium)
    private let refreshThreshold: CGFloat = 60
    private let refreshMaxHold: CGFloat = 96
    private let minimumRefreshDuration: TimeInterval = 0.35
    private var isRefreshing = false
    private let stateContainer = UIView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private lazy var loadingStack = UIStackView(arrangedSubviews: [loadingSpinner, loadingLabel])
    private var emptyStateView: EmptyStateView?

    private let titleLabel = UILabel()
    private let pathLabel = UILabel()
    private let titleContainer = UIView()
    private var titleWidthConstraint: NSLayoutConstraint!
    private let newSessionButton = UIButton(type: .system)

    private var dataSource: UITableViewDiffableDataSource<String, String>!
    private var sections: [SessionSectionModel] = []
    private var currentModel = SessionListModel()
    private var sessionsByID: [String: SessionDto] = [:]
    /// The task section starts expanded; directory/older sections start collapsed.
    private var expandedSections: Set<String> = ["tasks"]
    private var lastWorkspaceID: String?
    private let workspaceChip = WorkspaceChipControl()
    private lazy var workspaceChipItem = UIBarButtonItem(customView: workspaceChip)
    private var hasLoaded = false
    private var hasRenderedOnce = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.Colors.background

        configureNavigationTitle()
        workspaceChip.addTarget(
            self,
            action: #selector(openWorkspaceSwitcher),
            for: .touchUpInside
        )
        configureTable()
        configureRefreshIndicator()
        configureStateContainer()
        configureNewSessionButton()
        configureDataSource()
        bind()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        if hasLoaded {
            Task { await viewModel.load(showLoading: false) }
        } else {
            hasLoaded = true
            Task { await viewModel.load(showLoading: true) }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Install after the transition so a pop does not draw both the pushed
        // screen's title and ours in the same place.
        installNavigationTitle()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // The navigation bar is shared with pushed chats; never leave our labels
        // on top of another screen's title.
        titleContainer.removeFromSuperview()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // A long workspace path must not widen the title into the workspace
        // chip's space. Recalculate for rotation and split-screen resizing.
        let width = min(280, max(100, view.bounds.width - 230))
        if titleWidthConstraint.constant != width {
            titleWidthConstraint.constant = width
        }
    }

    private func configureNavigationTitle() {
        titleLabel.text = "会话"
        titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.textAlignment = .center

        pathLabel.font = Typography.caption
        pathLabel.textColor = Theme.Colors.textSecondary
        pathLabel.textAlignment = .center
        pathLabel.lineBreakMode = .byTruncatingMiddle
        pathLabel.numberOfLines = 1
        pathLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        pathLabel.isHidden = true

        let stack = UIStackView(arrangedSubviews: [titleLabel, pathLabel])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        titleContainer.translatesAutoresizingMaskIntoConstraints = false
        // Purely decorative: taps must reach the navigation bar and its menu.
        titleContainer.isUserInteractionEnabled = false
        titleContainer.addSubview(stack)
        titleWidthConstraint = titleContainer.widthAnchor.constraint(equalToConstant: 240)
        NSLayoutConstraint.activate([
            titleWidthConstraint,
            stack.topAnchor.constraint(equalTo: titleContainer.topAnchor),
            stack.bottomAnchor.constraint(equalTo: titleContainer.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: titleContainer.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: titleContainer.trailingAnchor),
        ])
    }

    /// `UINavigationBar` centers a `titleView` inside the space left by its bar
    /// button items, so asymmetric items pull the title off-center. Pin the
    /// title to the bar itself instead; the bounded width keeps it clear of the
    /// trailing menu.
    private func installNavigationTitle() {
        guard let bar = navigationController?.navigationBar,
              titleContainer.superview !== bar else { return }
        bar.addSubview(titleContainer)
        let widthCap = titleContainer.widthAnchor.constraint(
            lessThanOrEqualTo: bar.widthAnchor,
            constant: -220
        )
        // The exact width comes from `titleWidthConstraint`; this is a guard.
        widthCap.priority = .defaultHigh
        NSLayoutConstraint.activate([
            titleContainer.centerXAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.centerXAnchor),
            titleContainer.centerYAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.centerYAnchor),
            widthCap,
        ])
    }

    private func configureTable() {
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = Theme.Colors.background
        tableView.register(SessionCell.self, forCellReuseIdentifier: SessionCell.reuseIdentifier)
        tableView.register(
            SessionSectionHeader.self,
            forHeaderFooterViewReuseIdentifier: SessionSectionHeader.reuseIdentifier
        )
        tableView.delegate = self
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 96
        tableView.separatorStyle = .none
        tableView.sectionHeaderTopPadding = 0
        tableView.sectionFooterHeight = .leastNonzeroMagnitude
        tableView.estimatedSectionFooterHeight = 0
        // Cards have 6pt vertical insets: add 2pt above for an 8pt top gap,
        // and 10pt below for 16pt of bottom padding.
        tableView.tableHeaderView = UIView(frame: CGRect(x: 0, y: 0, width: 0, height: 2))
        tableView.tableFooterView = UIView(frame: CGRect(x: 0, y: 0, width: 0, height: 10))
        tableView.alwaysBounceVertical = true

        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            // Extend beneath the transparent tab bar; automatic safe-area insets keep
            // the last item reachable above its buttons when scrolling to the bottom.
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func configureRefreshIndicator() {
        refreshIndicatorContainer.translatesAutoresizingMaskIntoConstraints = false
        refreshIndicatorContainer.isHidden = true
        refreshIndicatorContainer.isUserInteractionEnabled = false

        refreshSpinner.translatesAutoresizingMaskIntoConstraints = false
        refreshSpinner.color = Theme.Colors.textSecondary
        refreshIndicatorContainer.addSubview(refreshSpinner)
        view.addSubview(refreshIndicatorContainer)

        NSLayoutConstraint.activate([
            refreshIndicatorContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            refreshIndicatorContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            refreshIndicatorContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            refreshIndicatorContainer.heightAnchor.constraint(equalToConstant: 48),

            refreshSpinner.centerXAnchor.constraint(equalTo: refreshIndicatorContainer.centerXAnchor),
            refreshSpinner.centerYAnchor.constraint(equalTo: refreshIndicatorContainer.centerYAnchor),
        ])
    }

    private func configureStateContainer() {
        stateContainer.translatesAutoresizingMaskIntoConstraints = false
        stateContainer.isHidden = true
        view.addSubview(stateContainer)

        loadingLabel.text = "正在加载会话…"
        loadingLabel.font = Typography.body
        loadingLabel.textColor = Theme.Colors.textSecondary
        loadingStack.axis = .vertical
        loadingStack.alignment = .center
        loadingStack.spacing = Spacing.sm
        loadingStack.translatesAutoresizingMaskIntoConstraints = false
        loadingStack.isHidden = true
        stateContainer.addSubview(loadingStack)

        NSLayoutConstraint.activate([
            stateContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stateContainer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stateContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stateContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            loadingStack.centerXAnchor.constraint(equalTo: stateContainer.centerXAnchor),
            loadingStack.centerYAnchor.constraint(equalTo: stateContainer.centerYAnchor),
        ])
    }

    private func configureNewSessionButton() {
        var configuration = UIButton.Configuration.filled()
        configuration.image = UIImage(
            systemName: "plus",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
        )
        configuration.baseBackgroundColor = Theme.Colors.primarySubtle
        configuration.baseForegroundColor = Theme.Colors.primaryDeep
        configuration.cornerStyle = .capsule

        newSessionButton.configuration = configuration
        newSessionButton.translatesAutoresizingMaskIntoConstraints = false
        newSessionButton.layer.shadowColor = UIColor.black.cgColor
        newSessionButton.layer.shadowOpacity = 0.18
        newSessionButton.layer.shadowRadius = 8
        newSessionButton.layer.shadowOffset = CGSize(width: 0, height: 4)
        newSessionButton.accessibilityLabel = "新建会话"
        newSessionButton.addAction(
            UIAction { [weak self] _ in self?.presentNewSession() },
            for: .touchUpInside
        )

        view.addSubview(newSessionButton)
        NSLayoutConstraint.activate([
            newSessionButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
            newSessionButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -Spacing.lg),
            newSessionButton.widthAnchor.constraint(equalToConstant: 56),
            newSessionButton.heightAnchor.constraint(equalToConstant: 56),
        ])
    }

    private func presentNewSession() {
        let sheet = NewSessionViewController()
        sheet.onStart = { [weak self] workspace, agent, mode in
            guard let self else { return }
            self.dismiss(animated: true) {
                WorkspaceSelection.shared.select(id: workspace.id, path: workspace.path)
                let viewModel = ChatViewModel(
                    sessionId: nil,
                    workspaceId: workspace.id,
                    runtime: agent.id,
                    permissionMode: mode
                )
                let chat = ChatViewController(viewModel: viewModel)
                self.navigationController?.pushViewController(chat, animated: true)
            }
        }

        let navigation = UINavigationController(rootViewController: sheet)
        navigation.modalPresentationStyle = .pageSheet
        if let presentation = navigation.sheetPresentationController {
            presentation.detents = [.medium(), .large()]
            presentation.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func configureDataSource() {
        dataSource = UITableViewDiffableDataSource<String, String>(
            tableView: tableView
        ) { [weak self] tableView, indexPath, id in
            let cell = tableView.dequeueReusableCell(
                withIdentifier: SessionCell.reuseIdentifier,
                for: indexPath
            ) as! SessionCell
            if let session = self?.sessionsByID[id] {
                cell.configure(with: session)
            }
            return cell
        }
        dataSource.defaultRowAnimation = .fade
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: SessionListViewModel.State) {
        if lastWorkspaceID != state.selectedWorkspaceID {
            lastWorkspaceID = state.selectedWorkspaceID
            expandedSections = ["tasks"]
            tableView.setContentOffset(
                CGPoint(x: 0, y: -tableView.adjustedContentInset.top),
                animated: false
            )
        }

        let selectedWorkspace = state.workspaces.first(where: { $0.id == state.selectedWorkspaceID })
        let chipLabel = selectedWorkspace?.displayName ?? "工作区"
        workspaceChip.configure(label: chipLabel)
        let subtitle: String?
        if selectedWorkspace?.family == "life" || selectedWorkspace?.isBuiltin == true {
            subtitle = nil
        } else {
            subtitle = state.selectedWorkspacePath
        }
        pathLabel.text = subtitle
        pathLabel.isHidden = subtitle == nil
        updateWorkspaceSwitcher(state)

        if state.model.isEmpty {
            tableView.isHidden = true
            stateContainer.isHidden = false

            if state.isLoading {
                showLoading()
            } else if let error = state.loadError {
                showEmpty(
                    symbolName: "exclamationmark.triangle",
                    title: state.requiresReconnect ? "连接已失效" : "加载失败",
                    message: error,
                    actionTitle: state.requiresReconnect ? "重新连接" : "重试",
                    action: { [weak self] in
                        guard let self else { return }
                        if state.requiresReconnect {
                            AppRouter.shared.showConnect()
                        } else {
                            Task { await self.viewModel.load(showLoading: true) }
                        }
                    }
                )
            } else {
                showEmpty(
                    symbolName: "bubble.left.and.bubble.right",
                    title: "还没有会话",
                    message: "在电脑上新建会话后，这里会显示出来",
                    actionTitle: nil,
                    action: nil
                )
            }
        } else {
            loadingSpinner.stopAnimating()
            stateContainer.isHidden = true
            tableView.isHidden = false
            apply(model: state.model)
        }

        if let actionError = state.actionError {
            viewModel.consumeActionError()
            presentAlert(title: "操作失败", message: actionError)
        }
    }

    private func buildSections(_ model: SessionListModel) -> [SessionSectionModel] {
        var result: [SessionSectionModel] = []

        if !model.rootSessions.isEmpty {
            result.append(
                SessionSectionModel(
                    id: "root",
                    title: nil,
                    count: model.rootSessions.count,
                    sessions: model.rootSessions,
                    collapsible: false,
                    iconName: nil,
                    isExpanded: true
                )
            )
        }

        if !model.olderRootSessions.isEmpty {
            let id = "older"
            result.append(
                SessionSectionModel(
                    id: id,
                    title: "更早",
                    count: model.olderRootSessions.count,
                    sessions: model.olderRootSessions,
                    collapsible: true,
                    iconName: "clock.arrow.circlepath",
                    isExpanded: expandedSections.contains(id)
                )
            )
        }

        for group in model.subGroups {
            let id = "cwd:\(group.cwd)"
            result.append(
                SessionSectionModel(
                    id: id,
                    title: group.title,
                    count: group.sessions.count,
                    sessions: group.sessions,
                    collapsible: true,
                    iconName: "folder",
                    isExpanded: expandedSections.contains(id)
                )
            )
        }

        if !model.taskSessions.isEmpty {
            let id = "tasks"
            result.append(
                SessionSectionModel(
                    id: id,
                    title: "定时任务",
                    count: model.taskSessions.count,
                    sessions: model.taskSessions,
                    collapsible: true,
                    iconName: "calendar.badge.clock",
                    isExpanded: expandedSections.contains(id)
                )
            )
        }

        return result
    }

    private func apply(model: SessionListModel, animated: Bool = true) {
        currentModel = model
        sections = buildSections(model)
        sessionsByID = Dictionary(
            sections.flatMap { $0.sessions }.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        var snapshot = NSDiffableDataSourceSnapshot<String, String>()
        for section in sections {
            snapshot.appendSections([section.id])
            if section.isExpanded {
                snapshot.appendItems(section.sessions.map(\.id), toSection: section.id)
            }
        }
        // Stable IDs describe identity, not content. A refresh can change running,
        // title, runtime or timestamps without inserting/removing any sessions.
        let existingIDs = Set(dataSource.snapshot().itemIdentifiers)
        snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { existingIDs.contains($0) })
        dataSource.apply(snapshot, animatingDifferences: animated && hasRenderedOnce)
        hasRenderedOnce = true
    }

    private func toggleSection(_ id: String) {
        if expandedSections.contains(id) {
            expandedSections.remove(id)
        } else {
            expandedSections.insert(id)
        }
        apply(model: currentModel, animated: false)
        // The diffable data source does not reload header views for a pure expand/collapse;
        // reload so the chevron and sticky header reflect the new state.
        tableView.reloadData()
    }

    private func updateWorkspaceSwitcher(_ state: SessionListViewModel.State) {
        // The built-in fallback still scopes sessions/files, but is not a row the
        // user can switch to. family=life is a builtin the client must still render.
        let shown = state.workspaces.filter { $0.family == "life" || !$0.isBuiltin }
        guard !shown.isEmpty else {
            navigationItem.rightBarButtonItem = nil
            return
        }
        navigationItem.rightBarButtonItem = workspaceChipItem
    }

    @objc private func openWorkspaceSwitcher() {
        let state = viewModel.state
        let shown = state.workspaces.filter { $0.family == "life" || !$0.isBuiltin }
        guard !shown.isEmpty else { return }

        let switcher = WorkspaceSwitcherViewController(
            workspaces: shown,
            selectedWorkspaceId: state.selectedWorkspaceID
        )
        switcher.onSelect = { [weak self] workspace in
            guard let self else { return }
            let alreadySelected = workspace.id == self.viewModel.state.selectedWorkspaceID
            self.dismiss(animated: true) {
                guard !alreadySelected else { return }
                Task { await self.viewModel.selectWorkspace(workspace) }
            }
        }
        switcher.onOpenOverview = { [weak self] workspace in
            guard let self else { return }
            self.dismiss(animated: true) {
                self.presentWorkspaceOverview(workspace: workspace)
            }
        }
        switcher.onDismiss = { [weak self] in
            self?.dismiss(animated: true)
        }
        switcher.modalPresentationStyle = .pageSheet
        if let sheet = switcher.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.selectedDetentIdentifier = shown.count > 5 ? .large : .medium
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Radius.sheet
        }
        present(switcher, animated: true)
    }

    /// The overview is read-only: dirs are added/removed from workspace management
    /// (settings) or on desktop, never here. It is a normal pushed page, not a
    /// sheet, so knowledge opens as another full page on top of it.
    private func presentWorkspaceOverview(workspace explicitWorkspace: WorkspaceDto? = nil) {
        let state = viewModel.state
        guard let workspace = explicitWorkspace
            ?? state.workspaces.first(where: { $0.id == state.selectedWorkspaceID }) else {
            return
        }
        let overview = WorkspaceOverviewViewController(
            workspace: workspace,
            // `nil` while the list is loading or failed: the overview must not
            // present「0 个会话」as fact.
            sessions: state.loadError == nil && !state.isLoading ? state.model.allSessions : nil
        )
        navigationController?.pushViewController(overview, animated: true)
    }

    private func showLoading() {
        emptyStateView?.removeFromSuperview()
        emptyStateView = nil
        loadingStack.isHidden = false
        loadingSpinner.startAnimating()
    }

    private func showEmpty(
        symbolName: String,
        title: String,
        message: String?,
        actionTitle: String?,
        action: (() -> Void)?
    ) {
        loadingSpinner.stopAnimating()
        loadingStack.isHidden = true
        emptyStateView?.removeFromSuperview()

        let empty = EmptyStateView(
            symbolName: symbolName,
            title: title,
            message: message,
            actionTitle: actionTitle,
            onAction: action
        )
        empty.translatesAutoresizingMaskIntoConstraints = false
        stateContainer.addSubview(empty)
        NSLayoutConstraint.activate([
            empty.topAnchor.constraint(equalTo: stateContainer.topAnchor),
            empty.bottomAnchor.constraint(equalTo: stateContainer.bottomAnchor),
            empty.leadingAnchor.constraint(equalTo: stateContainer.leadingAnchor),
            empty.trailingAnchor.constraint(equalTo: stateContainer.trailingAnchor),
        ])
        emptyStateView = empty
    }

    /// Keeps the page pulled down for the whole request, instead of letting the system
    /// refresh control snap back on release.
    private func beginRefresh(hold: CGFloat) {
        guard !isRefreshing else { return }
        isRefreshing = true

        refreshIndicatorContainer.isHidden = false
        refreshSpinner.alpha = 1
        refreshSpinner.startAnimating()

        tableView.contentInset.top = hold
        tableView.setContentOffset(CGPoint(x: 0, y: -hold), animated: true)

        Task {
            let started = Date()
            await viewModel.load(showLoading: false)

            let elapsed = Date().timeIntervalSince(started)
            if elapsed < minimumRefreshDuration {
                let remaining = UInt64((minimumRefreshDuration - elapsed) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: remaining)
            }

            endRefresh()
        }
    }

    private func endRefresh() {
        guard isRefreshing else { return }
        isRefreshing = false

        refreshSpinner.stopAnimating()
        tableView.contentInset.top = 0
        tableView.setContentOffset(
            CGPoint(x: 0, y: -tableView.adjustedContentInset.top),
            animated: true
        )
        refreshIndicatorContainer.isHidden = true
    }

    private func presentRename(for session: SessionDto) {
        let alert = UIAlertController(title: "重命名会话", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = session.title
            field.placeholder = "会话名称"
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "保存", style: .default) { [weak self] _ in
            let title = alert.textFields?.first?.text ?? ""
            Task { await self?.viewModel.rename(id: session.id, title: title) }
        })
        present(alert, animated: true)
    }

    private func confirmDelete(_ session: SessionDto) {
        let name = session.title.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名会话"
        let alert = UIAlertController(
            title: "删除会话？",
            message: "「\(name)」及其运行记录会被删除。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "删除", style: .destructive) { [weak self] _ in
            Task { await self?.viewModel.delete(id: session.id) }
        })
        present(alert, animated: true)
    }

    private func presentAlert(title: String, message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}

extension SessionsViewController: UITableViewDelegate {
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)

        guard let id = dataSource.itemIdentifier(for: indexPath),
              let session = sessionsByID[id] else {
            return
        }

        let viewModel = ChatViewModel(
            sessionId: session.id,
            runtime: session.runtime,
            title: session.title
        )
        let chat = ChatViewController(viewModel: viewModel)
        navigationController?.pushViewController(chat, animated: true)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === tableView, !isRefreshing, scrollView.isDragging else { return }

        let pull = -(scrollView.contentOffset.y + scrollView.adjustedContentInset.top)
        guard pull > 0 else {
            refreshIndicatorContainer.isHidden = true
            refreshSpinner.stopAnimating()
            return
        }

        refreshIndicatorContainer.isHidden = false
        let progress = min(max(pull / refreshThreshold, 0), 1)
        refreshSpinner.alpha = progress
        if progress >= 1 {
            refreshSpinner.startAnimating()
        } else {
            refreshSpinner.stopAnimating()
        }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        guard scrollView === tableView, !isRefreshing else { return }

        let pull = -(scrollView.contentOffset.y + scrollView.adjustedContentInset.top)
        guard pull >= refreshThreshold else {
            refreshIndicatorContainer.isHidden = true
            refreshSpinner.stopAnimating()
            return
        }

        beginRefresh(hold: min(pull, refreshMaxHold))
    }

    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        guard section < sections.count, let title = sections[section].title else {
            return nil
        }
        let model = sections[section]

        let header = tableView.dequeueReusableHeaderFooterView(
            withIdentifier: SessionSectionHeader.reuseIdentifier
        ) as! SessionSectionHeader
        header.configure(
            title: title,
            count: model.count,
            expanded: model.isExpanded,
            collapsible: model.collapsible,
            iconName: model.iconName
        )
        header.onTap = { [weak self] in
            self?.toggleSection(model.id)
        }
        return header
    }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
        guard section < sections.count, sections[section].title != nil else { return .leastNonzeroMagnitude }
        return 40
    }

    func tableView(
        _ tableView: UITableView,
        trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        guard let id = dataSource.itemIdentifier(for: indexPath), let session = sessionsByID[id] else {
            return nil
        }

        let delete = UIContextualAction(style: .destructive, title: "删除") { [weak self] _, _, completion in
            self?.confirmDelete(session)
            completion(true)
        }
        let rename = UIContextualAction(style: .normal, title: "重命名") { [weak self] _, _, completion in
            self?.presentRename(for: session)
            completion(true)
        }
        rename.backgroundColor = Theme.Colors.primary

        let configuration = UISwipeActionsConfiguration(actions: [delete, rename])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }
}

private struct SessionSectionModel {
    let id: String
    let title: String?
    let count: Int
    let sessions: [SessionDto]
    let collapsible: Bool
    let iconName: String?
    let isExpanded: Bool
}

private final class SessionSectionHeader: UITableViewHeaderFooterView {
    static let reuseIdentifier = "SessionSectionHeader"

    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let countLabel = UILabel()
    private let chevron = UIImageView()
    private let toggleButton = UIButton(type: .custom)
    var onTap: (() -> Void)?

    override init(reuseIdentifier: String?) {
        super.init(reuseIdentifier: reuseIdentifier)

        backgroundColor = Theme.Colors.background
        contentView.backgroundColor = Theme.Colors.background

        iconView.tintColor = Theme.Colors.textSecondary
        iconView.contentMode = .scaleAspectFit
        iconView.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = Typography.caption
        titleLabel.textColor = Theme.Colors.textSecondary
        titleLabel.lineBreakMode = .byTruncatingMiddle

        countLabel.font = Typography.caption
        countLabel.textColor = Theme.Colors.textMuted
        countLabel.setContentHuggingPriority(.required, for: .horizontal)

        chevron.tintColor = Theme.Colors.textMuted
        chevron.contentMode = .scaleAspectFit
        chevron.translatesAutoresizingMaskIntoConstraints = false

        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let stack = UIStackView(arrangedSubviews: [iconView, titleLabel, countLabel, spacer, chevron])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 14),
            iconView.heightAnchor.constraint(equalToConstant: 14),
            chevron.widthAnchor.constraint(equalToConstant: 12),
            chevron.heightAnchor.constraint(equalToConstant: 12),
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.lg),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.lg),
            stack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])

        // Use one full-header control so text, whitespace and the chevron all toggle.
        toggleButton.translatesAutoresizingMaskIntoConstraints = false
        toggleButton.addTarget(self, action: #selector(handleTap), for: .touchUpInside)
        addSubview(toggleButton)
        NSLayoutConstraint.activate([
            toggleButton.topAnchor.constraint(equalTo: topAnchor),
            toggleButton.bottomAnchor.constraint(equalTo: bottomAnchor),
            toggleButton.leadingAnchor.constraint(equalTo: leadingAnchor),
            toggleButton.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        contentView.accessibilityElementsHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(
        title: String,
        count: Int,
        expanded: Bool,
        collapsible: Bool,
        iconName: String?
    ) {
        iconView.image = iconName.flatMap { UIImage(systemName: $0) }
        iconView.isHidden = iconName == nil
        titleLabel.text = title
        countLabel.text = "\(count)"
        chevron.image = UIImage(systemName: expanded ? "chevron.down" : "chevron.right")
        chevron.isHidden = !collapsible
        isUserInteractionEnabled = collapsible
        toggleButton.isEnabled = collapsible
        toggleButton.accessibilityLabel = "\(title)，\(count) 个会话"
        toggleButton.accessibilityValue = expanded ? "已展开" : "已收起"
    }

    @objc private func handleTap() {
        onTap?()
    }
}

/// Read-only workspace overview (docs/ui/mobile/pages/sessions.md §6.2): the
/// primary dir plus extra dirs with their session counts. Directory add/remove
/// belongs to workspace management (and desktop), so nothing here writes.
private final class WorkspaceOverviewViewController: UIViewController {
    private let workspace: WorkspaceDto
    /// `nil` = the list is still loading / failed; do not present「0 个会话」as fact.
    private let sessions: [SessionDto]?

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()

    init(workspace: WorkspaceDto, sessions: [SessionDto]?) {
        self.workspace = workspace
        self.sessions = sessions
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "工作区概览"
        view.backgroundColor = Theme.Colors.background
        configureLayout()
        buildContent()
    }

    private func configureLayout() {
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        contentStack.axis = .vertical
        contentStack.alignment = .fill
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
                constant: Spacing.md
            ),
            contentStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor,
                constant: -Spacing.md
            ),
            contentStack.leadingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.leadingAnchor,
                constant: Spacing.md
            ),
            contentStack.trailingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.trailingAnchor,
                constant: -Spacing.md
            ),
            contentStack.widthAnchor.constraint(
                equalTo: scrollView.frameLayoutGuide.widthAnchor,
                constant: -Spacing.md * 2
            ),
        ])
    }

    private func buildContent() {
        let dirs = SessionGrouping.directories(for: workspace)
        let totalSessions = sessions.map { allSessions in
            dirs.reduce(0) { sum, path in
                sum + allSessions.filter { SessionGrouping.matchesDirectory($0.cwd, path) }.count
            }
        }

        contentStack.addArrangedSubview(heroCard(dirs: dirs, totalSessions: totalSessions))
        contentStack.addArrangedSubview(directorySection(dirs: dirs))

        if workspace.family != "life" {
            contentStack.addArrangedSubview(knowledgeCard())
        } else {
            contentStack.addArrangedSubview(memoryCard())
        }

        if workspace.isBuiltin && workspace.family != "life" {
            let builtin = UILabel()
            builtin.text = "内置工作区只是临时目录，建议先在设置里添加真实工作区。"
            builtin.font = Typography.caption
            builtin.textColor = Theme.Colors.textSecondary
            builtin.numberOfLines = 0
            contentStack.addArrangedSubview(builtin)
        }
    }

    private func heroCard(dirs: [String], totalSessions: Int?) -> UIView {
        let card = makeCard()
        let iconBox = makeIconBox(systemName: "folder", boxSize: 42, iconSize: 21)

        let name = UILabel()
        name.text = workspace.displayName
        name.font = Typography.cardTitle
        name.textColor = Theme.Colors.textPrimary
        name.numberOfLines = 1
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let nameRow = UIStackView(arrangedSubviews: [name])
        nameRow.axis = .horizontal
        nameRow.alignment = .center
        nameRow.spacing = Spacing.xs
        if let badge = kindBadge() {
            nameRow.addArrangedSubview(badge)
        }

        let path = UILabel()
        path.text = workspace.path
        path.font = Typography.code
        path.textColor = Theme.Colors.textSecondary
        path.numberOfLines = 2
        path.lineBreakMode = .byCharWrapping

        let textStack = UIStackView(arrangedSubviews: [nameRow, path])
        textStack.axis = .vertical
        textStack.spacing = 3

        let top = UIStackView(arrangedSubviews: [iconBox, textStack])
        top.axis = .horizontal
        top.alignment = .center
        top.spacing = Spacing.sm

        let stats = UIStackView(arrangedSubviews: [
            makePill(
                "\(dirs.count) 个目录",
                background: Theme.Colors.surface2,
                foreground: Theme.Colors.textSecondary
            )
        ])
        stats.axis = .horizontal
        stats.spacing = Spacing.xs
        if let totalSessions {
            stats.addArrangedSubview(
                makePill(
                    "\(totalSessions) 个会话",
                    background: Theme.Colors.surface2,
                    foreground: Theme.Colors.textSecondary
                )
            )
        }

        let stack = UIStackView(arrangedSubviews: [top, stats])
        stack.axis = .vertical
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.md),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.md),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.md),
        ])
        return card
    }

    private func kindBadge() -> UIView? {
        let label: String?
        if workspace.family == "life" {
            label = "生活"
        } else if workspace.isBuiltin {
            label = "内置"
        } else {
            label = nil
        }
        guard let label else { return nil }
        return makePill(
            label,
            background: Theme.Colors.primarySubtle,
            foreground: Theme.Colors.primaryDeep
        )
    }

    private func directorySection(dirs: [String]) -> UIView {
        let card = makeCard()
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false

        let header = UIStackView()
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = Spacing.xs
        header.isLayoutMarginsRelativeArrangement = true
        header.layoutMargins = UIEdgeInsets(
            top: 14,
            left: Spacing.md,
            bottom: 4,
            right: Spacing.md
        )
        let title = UILabel()
        title.text = "目录"
        title.font = Typography.cardTitle
        title.textColor = Theme.Colors.textPrimary
        let count = UILabel()
        count.text = "\(dirs.count)"
        count.font = Typography.caption
        count.textColor = Theme.Colors.textSecondary
        count.setContentHuggingPriority(.required, for: .horizontal)
        header.addArrangedSubview(title)
        header.addArrangedSubview(UIView())
        header.addArrangedSubview(count)
        stack.addArrangedSubview(header)

        for (index, path) in dirs.enumerated() {
            if index > 0 {
                stack.addArrangedSubview(makeDivider())
            }
            stack.addArrangedSubview(directoryRow(path: path, isPrimary: index == 0))
        }

        let hint = makeInsetHint(
            dirs.count > 1
                ? "附加目录会扩大这个工作区所有会话的可写范围，不是只给当前对话。"
                : "还没有附加目录，可以在设置 → 工作区管理里添加。"
        )
        stack.addArrangedSubview(hint)

        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor),
        ])
        return card
    }

    private func directoryRow(path: String, isPrimary: Bool) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Spacing.sm
        row.isLayoutMarginsRelativeArrangement = true
        row.layoutMargins = UIEdgeInsets(
            top: Spacing.sm,
            left: Spacing.md,
            bottom: Spacing.sm,
            right: Spacing.md
        )

        let icon = UIImageView(image: UIImage(systemName: "folder"))
        icon.tintColor = isPrimary ? Theme.Colors.primary : Theme.Colors.textSecondary
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 19),
            icon.heightAnchor.constraint(equalToConstant: 19),
        ])

        let label = UILabel()
        label.text = isPrimary ? "主目录" : "附加目录"
        label.font = Typography.caption
        label.textColor = isPrimary ? Theme.Colors.primary : Theme.Colors.textSecondary

        let pathLabel = UILabel()
        pathLabel.text = path
        pathLabel.font = Typography.code
        pathLabel.textColor = Theme.Colors.textSecondary
        pathLabel.numberOfLines = 1
        pathLabel.lineBreakMode = .byTruncatingTail
        pathLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let textStack = UIStackView(arrangedSubviews: [label, pathLabel])
        textStack.axis = .vertical
        textStack.spacing = 2

        row.addArrangedSubview(icon)
        row.addArrangedSubview(textStack)

        if let sessions {
            let count = sessions.filter { SessionGrouping.matchesDirectory($0.cwd, path) }.count
            let number = UILabel()
            number.text = "\(count)"
            number.font = Typography.cardTitle
            number.textColor = Theme.Colors.textPrimary
            number.textAlignment = .right
            let unit = UILabel()
            unit.text = "会话"
            unit.font = Typography.caption
            unit.textColor = Theme.Colors.textMuted
            unit.textAlignment = .right
            let countStack = UIStackView(arrangedSubviews: [number, unit])
            countStack.axis = .vertical
            countStack.spacing = 0
            countStack.setContentHuggingPriority(.required, for: .horizontal)
            countStack.setContentCompressionResistancePriority(.required, for: .horizontal)
            row.addArrangedSubview(countStack)
        }

        return row
    }

    private func knowledgeCard() -> UIView {
        let card = makeCard()
        card.isUserInteractionEnabled = true
        card.isAccessibilityElement = true
        card.accessibilityTraits = .button
        card.accessibilityLabel = "知识"
        card.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(openKnowledge))
        )

        let iconBox = makeIconBox(systemName: "doc.text", boxSize: 38, iconSize: 19)
        let title = UILabel()
        title.text = "知识"
        title.font = Typography.cardTitle
        title.textColor = Theme.Colors.textPrimary
        let hint = UILabel()
        hint.text = "项目约定、决策与踩坑；自动收录，新会话按路径注入。"
        hint.font = Typography.caption
        hint.textColor = Theme.Colors.textSecondary
        hint.numberOfLines = 2
        let textStack = UIStackView(arrangedSubviews: [title, hint])
        textStack.axis = .vertical
        textStack.spacing = 2

        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = Theme.Colors.textMuted
        chevron.contentMode = .scaleAspectFit
        chevron.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            chevron.widthAnchor.constraint(equalToConstant: 12),
            chevron.heightAnchor.constraint(equalToConstant: 16),
        ])

        let row = UIStackView(arrangedSubviews: [iconBox, textStack, chevron])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Spacing.sm
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.md),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.md),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.md),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.md),
        ])
        return card
    }

    @objc private func openKnowledge() {
        let controller = KnowledgeListViewController(
            workspaceId: workspace.id,
            workspaceName: workspace.displayName
        )
        navigationController?.pushViewController(controller, animated: true)
    }

    @objc private func openMemory() {
        let controller = MemoryViewController(
            workspaceId: workspace.id,
            workspaceName: workspace.displayName
        )
        navigationController?.pushViewController(controller, animated: true)
    }

    private func memoryCard() -> UIView {
        let card = makeCard()
        card.isUserInteractionEnabled = true
        card.isAccessibilityElement = true
        card.accessibilityTraits = .button
        card.accessibilityLabel = "关于你"
        card.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(openMemory))
        )

        let iconBox = makeIconBox(systemName: "person.crop.circle", boxSize: 38, iconSize: 19)
        let title = UILabel()
        title.text = "关于你"
        title.font = Typography.cardTitle
        title.textColor = Theme.Colors.textPrimary
        let hint = UILabel()
        hint.text = "生活会话自动整理长期事实；新会话按记忆注入，可改正或忘记。"
        hint.font = Typography.caption
        hint.textColor = Theme.Colors.textSecondary
        hint.numberOfLines = 2
        let textStack = UIStackView(arrangedSubviews: [title, hint])
        textStack.axis = .vertical
        textStack.spacing = 2

        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = Theme.Colors.textMuted
        chevron.contentMode = .scaleAspectFit
        chevron.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            chevron.widthAnchor.constraint(equalToConstant: 12),
            chevron.heightAnchor.constraint(equalToConstant: 16),
        ])

        let row = UIStackView(arrangedSubviews: [iconBox, textStack, chevron])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Spacing.sm
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.md),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.md),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.md),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.md),
        ])
        return card
    }

    private func makeCard() -> UIView {
        let card = UIView()
        card.backgroundColor = Theme.Colors.surface
        card.layer.cornerRadius = Radius.card
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1.0 / max(traitCollection.displayScale, 1)
        card.layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor
        card.translatesAutoresizingMaskIntoConstraints = false
        return card
    }

    private func makeIconBox(systemName: String, boxSize: CGFloat, iconSize: CGFloat) -> UIView {
        let box = UIView()
        box.backgroundColor = Theme.Colors.primarySubtle
        box.layer.cornerRadius = 11
        box.layer.cornerCurve = .continuous
        box.translatesAutoresizingMaskIntoConstraints = false

        let image = UIImageView(image: UIImage(systemName: systemName))
        image.tintColor = Theme.Colors.primaryDeep
        image.contentMode = .scaleAspectFit
        image.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(image)

        NSLayoutConstraint.activate([
            box.widthAnchor.constraint(equalToConstant: boxSize),
            box.heightAnchor.constraint(equalToConstant: boxSize),
            image.widthAnchor.constraint(equalToConstant: iconSize),
            image.heightAnchor.constraint(equalToConstant: iconSize),
            image.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            image.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        ])
        return box
    }

    private func makePill(_ text: String, background: UIColor, foreground: UIColor) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = foreground
        label.translatesAutoresizingMaskIntoConstraints = false

        let pill = UIView()
        pill.backgroundColor = background
        pill.layer.cornerRadius = 11
        pill.layer.cornerCurve = .continuous
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.setContentHuggingPriority(.required, for: .horizontal)
        pill.setContentCompressionResistancePriority(.required, for: .horizontal)
        pill.addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: pill.topAnchor, constant: 3),
            label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -3),
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 9),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -9),
        ])
        return pill
    }

    private func makeDivider() -> UIView {
        let wrapper = UIView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false
        let line = UIView()
        line.backgroundColor = Theme.Colors.border
        line.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: Spacing.md),
            line.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -Spacing.md),
            line.topAnchor.constraint(equalTo: wrapper.topAnchor),
            line.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
            line.heightAnchor.constraint(equalToConstant: 1.0 / max(traitCollection.displayScale, 1)),
        ])
        return wrapper
    }

    private func makeInsetHint(_ text: String) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false

        let wrapper = UIView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: Spacing.xxs),
            label.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -14),
            label.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: Spacing.md),
            label.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -Spacing.md),
        ])
        return wrapper
    }
}
