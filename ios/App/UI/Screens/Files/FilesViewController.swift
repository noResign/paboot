import Combine
import PabootProtocol
import UIKit

/// File tab: git changes by default, plus a one-level-at-a-time browser.
final class FilesViewController: UIViewController {
    private lazy var viewModel = FilesViewModel()
    private var cancellables = Set<AnyCancellable>()

    private let segmentedControl = UISegmentedControl(items: ["改动", "全部文件"])
    private let rootBar = FileRootBarView()
    private let tableView = UITableView(frame: .zero, style: .plain)

    private let refreshIndicatorContainer = UIView()
    private let refreshSpinner = UIActivityIndicatorView(style: .medium)
    private let refreshThreshold: CGFloat = 60
    private let refreshMaxHold: CGFloat = 96
    private let minimumRefreshDuration: TimeInterval = 0.35
    private var isRefreshing = false

    private let stateContainer = UIView()
    private let loadingStack = UIStackView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private var emptyStateView: EmptyStateView?

    private lazy var hiddenToggleItem = UIBarButtonItem(
        image: UIImage(systemName: "eye"),
        style: .plain,
        target: self,
        action: #selector(toggleHidden)
    )

    private enum Row: Equatable {
        case change(ChangedFileDto)
        case repo(String)
        case entry(FileEntryDto)
        case up
    }

    private var rows: [Row] = []
    private var hasLoaded = false
    private var hasPresentedActionError = false
    private var hasPresentedLoadError = false
    private var rootBarSignature: String?

    override func viewDidLoad() {
        super.viewDidLoad()

        title = "文件"
        view.backgroundColor = Theme.Colors.background

        configureModeControl()
        configureRootBar()
        configureTable()
        configureRefreshIndicator()
        configureStateContainer()
        bind()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        Task { await viewModel.load(showLoading: !hasLoaded) }
        hasLoaded = true
    }

    private func configureModeControl() {
        segmentedControl.selectedSegmentIndex = 0
        segmentedControl.translatesAutoresizingMaskIntoConstraints = false
        segmentedControl.addTarget(self, action: #selector(modeChanged), for: .valueChanged)

        view.addSubview(segmentedControl)
        NSLayoutConstraint.activate([
            segmentedControl.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor,
                constant: Spacing.xs
            ),
            segmentedControl.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            segmentedControl.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
        ])
    }

    private func configureRootBar() {
        rootBar.translatesAutoresizingMaskIntoConstraints = false
        rootBar.onSelectRoot = { [weak self] root in
            Task { await self?.viewModel.selectRoot(root) }
        }
        rootBar.onRemoveShortcut = { [weak self] path in
            Task { await self?.viewModel.removeShortcut(path: path) }
        }
        rootBar.onAddRoot = { [weak self] in self?.presentAddRootPicker() }

        view.addSubview(rootBar)
        NSLayoutConstraint.activate([
            rootBar.topAnchor.constraint(equalTo: segmentedControl.bottomAnchor, constant: Spacing.xs),
            rootBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            rootBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            rootBar.heightAnchor.constraint(equalToConstant: 36),
        ])
    }

    private func configureTable() {
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = Theme.Colors.background
        tableView.separatorInset = UIEdgeInsets(top: 0, left: Spacing.lg, bottom: 0, right: 0)
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 64
        tableView.tableFooterView = UIView()
        tableView.alwaysBounceVertical = true
        tableView.register(ChangedFileCell.self, forCellReuseIdentifier: ChangedFileCell.reuseIdentifier)
        tableView.register(FileEntryCell.self, forCellReuseIdentifier: FileEntryCell.reuseIdentifier)
        tableView.dataSource = self
        tableView.delegate = self

        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: rootBar.bottomAnchor, constant: Spacing.xxs),
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
            refreshIndicatorContainer.topAnchor.constraint(equalTo: tableView.topAnchor),
            refreshIndicatorContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            refreshIndicatorContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            refreshIndicatorContainer.heightAnchor.constraint(equalToConstant: 44),

            refreshSpinner.centerXAnchor.constraint(equalTo: refreshIndicatorContainer.centerXAnchor),
            refreshSpinner.centerYAnchor.constraint(equalTo: refreshIndicatorContainer.centerYAnchor),
        ])
    }

    private func configureStateContainer() {
        stateContainer.translatesAutoresizingMaskIntoConstraints = false
        stateContainer.isHidden = true
        view.addSubview(stateContainer)
        view.bringSubviewToFront(stateContainer)

        loadingSpinner.color = Theme.Colors.textSecondary
        loadingLabel.text = "正在加载…"
        loadingLabel.font = Typography.body
        loadingLabel.textColor = Theme.Colors.textSecondary

        loadingStack.axis = .vertical
        loadingStack.alignment = .center
        loadingStack.spacing = Spacing.sm
        loadingStack.addArrangedSubview(loadingSpinner)
        loadingStack.addArrangedSubview(loadingLabel)
        loadingStack.translatesAutoresizingMaskIntoConstraints = false
        loadingStack.isHidden = true
        stateContainer.addSubview(loadingStack)

        NSLayoutConstraint.activate([
            stateContainer.topAnchor.constraint(equalTo: rootBar.bottomAnchor),
            stateContainer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stateContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stateContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            loadingStack.centerXAnchor.constraint(equalTo: stateContainer.centerXAnchor),
            loadingStack.centerYAnchor.constraint(equalTo: stateContainer.centerYAnchor),
        ])
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: FilesViewModel.State) {
        segmentedControl.selectedSegmentIndex = state.mode == .changes ? 0 : 1

        let signature = state.knownRoots.joined(separator: "|")
            + "#" + state.shortcuts.joined(separator: "|")
            + "#" + (state.root ?? "")
        if signature != rootBarSignature {
            rootBarSignature = signature
            rootBar.configure(
                roots: state.knownRoots,
                shortcuts: state.shortcuts,
                selectedRoot: state.root,
                workspacePath: state.workspacePath
            )
        }

        navigationItem.rightBarButtonItem = state.mode == .all ? hiddenToggleItem : nil
        hiddenToggleItem.image = UIImage(systemName: state.showHidden ? "eye.slash" : "eye")
        hiddenToggleItem.accessibilityLabel = state.showHidden ? "隐藏隐藏文件" : "显示隐藏文件"

        // The table's data source must never change without a matching reload. In
        // particular, transitioning to an empty list has to reload too; otherwise the
        // table keeps its old row count and can ask for an out-of-range index later.
        let newRows = makeRows(state)
        if newRows != rows {
            rows = newRows
            tableView.reloadData()
        }

        if rows.isEmpty {
            tableView.isHidden = true
            stateContainer.isHidden = false

            if state.isLoading {
                showLoading()
            } else if let error = state.loadError {
                showEmpty(
                    symbolName: "exclamationmark.triangle",
                    title: "加载失败",
                    message: error,
                    actionTitle: "重试",
                    action: { [weak self] in
                        Task { await self?.viewModel.load(showLoading: true) }
                    }
                )
            } else {
                showEmpty(
                    symbolName: state.mode == .changes ? "checkmark.circle" : "folder",
                    title: emptyTitle(state),
                    message: emptyMessage(state),
                    actionTitle: nil,
                    action: nil
                )
            }
        } else {
            loadingSpinner.stopAnimating()
            loadingStack.isHidden = true
            emptyStateView?.removeFromSuperview()
            emptyStateView = nil
            stateContainer.isHidden = true
            tableView.isHidden = false
        }

        if let error = state.loadError, !rows.isEmpty, !state.isLoading, !hasPresentedLoadError {
            hasPresentedLoadError = true
            presentAlert(title: "刷新失败", message: error) { [weak self] in
                self?.hasPresentedLoadError = false
            }
        }

        if let error = state.actionError, !hasPresentedActionError {
            hasPresentedActionError = true
            viewModel.consumeActionError()
            presentAlert(title: "操作失败", message: error) { [weak self] in
                self?.hasPresentedActionError = false
            }
        }
    }

    private func makeRows(_ state: FilesViewModel.State) -> [Row] {
        switch state.mode {
        case .changes:
            if state.isGitRepo {
                return state.changes.map { Row.change($0) }
            }
            return state.repos.map { Row.repo($0) }
        case .all:
            var result: [Row] = []
            if state.parent != nil {
                result.append(.up)
            }
            result.append(contentsOf: state.entries.map { Row.entry($0) })
            return result
        }
    }

    private func emptyTitle(_ state: FilesViewModel.State) -> String {
        switch state.mode {
        case .changes:
            return state.isGitRepo ? "当前没有未提交的改动" : "此目录不是 Git 仓库"
        case .all:
            return "空目录"
        }
    }

    private func emptyMessage(_ state: FilesViewModel.State) -> String? {
        switch state.mode {
        case .changes:
            return state.isGitRepo ? nil : "可以在根标签栏里切换到仓库目录查看改动"
        case .all:
            return "这个目录里没有文件"
        }
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

    @objc private func modeChanged() {
        let mode: FilesViewModel.Mode = segmentedControl.selectedSegmentIndex == 0 ? .changes : .all
        Task { await viewModel.switchMode(mode) }
    }

    @objc private func toggleHidden() {
        Task { await viewModel.toggleHidden() }
    }

    private func presentAddRootPicker() {
        let picker = DirectoryPickerViewController(
            viewModel: DirectoryPickerViewModel(workspacePaths: []),
            mode: .browseShortcut
        )
        picker.onSelect = { [weak self] path in
            guard let self else { return "页面已关闭" }
            return await self.viewModel.addShortcut(path: path)
        }

        let navigation = UINavigationController(rootViewController: picker)
        navigation.modalPresentationStyle = .pageSheet
        if let presentation = navigation.sheetPresentationController {
            presentation.detents = [.large()]
            presentation.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func openDiff(_ change: ChangedFileDto) {
        let controller = DiffViewController(
            workspaceId: viewModel.currentWorkspaceId,
            root: viewModel.state.root,
            path: change.path,
            status: change.status
        )
        navigationController?.pushViewController(controller, animated: true)
    }

    private func openContent(path: String) {
        let controller = FileContentViewController(
            workspaceId: viewModel.currentWorkspaceId,
            root: viewModel.state.root,
            path: path
        )
        navigationController?.pushViewController(controller, animated: true)
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
}

extension FilesViewController: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        // UIKit can still ask for a cell while a reload settles; never index off the end.
        guard indexPath.row < rows.count else {
            return UITableViewCell()
        }

        switch rows[indexPath.row] {
        case .change(let change):
            let cell = tableView.dequeueReusableCell(
                withIdentifier: ChangedFileCell.reuseIdentifier,
                for: indexPath
            ) as! ChangedFileCell
            cell.configure(with: change)
            return cell
        case .repo(let path):
            let cell = tableView.dequeueReusableCell(
                withIdentifier: FileEntryCell.reuseIdentifier,
                for: indexPath
            ) as! FileEntryCell
            cell.configureRepo(path)
            return cell
        case .entry(let entry):
            let cell = tableView.dequeueReusableCell(
                withIdentifier: FileEntryCell.reuseIdentifier,
                for: indexPath
            ) as! FileEntryCell
            cell.configure(with: entry)
            return cell
        case .up:
            let cell = tableView.dequeueReusableCell(
                withIdentifier: FileEntryCell.reuseIdentifier,
                for: indexPath
            ) as! FileEntryCell
            cell.configureUp()
            return cell
        }
    }
}

extension FilesViewController: UITableViewDelegate {
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)

        guard indexPath.row < rows.count else { return }

        switch rows[indexPath.row] {
        case .change(let change):
            if change.isDirectory {
                Task {
                    await viewModel.switchMode(.all)
                    await viewModel.openDirectory(path: change.path)
                }
            } else {
                openDiff(change)
            }
        case .repo(let path):
            Task { await viewModel.openChildRepo(path) }
        case .entry(let entry):
            if entry.type == "directory" {
                Task { await viewModel.openDirectory(entry) }
            } else {
                openContent(path: entry.path)
            }
        case .up:
            Task { await viewModel.goUp() }
        }
    }

    func tableView(
        _ tableView: UITableView,
        willDisplay cell: UITableViewCell,
        forRowAt indexPath: IndexPath
    ) {
        guard viewModel.state.mode == .all,
              viewModel.state.nextCursor != nil,
              !rows.isEmpty,
              indexPath.row == rows.count - 1 else {
            return
        }
        Task { await viewModel.loadMore() }
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
}
