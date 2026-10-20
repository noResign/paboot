import Combine
import PabootProtocol
import UIKit

/// Session list grouped by workspace. Root screen of the 会话 tab.
final class SessionsViewController: UIViewController {
    private lazy var viewModel = SessionListViewModel()
    private var cancellables = Set<AnyCancellable>()

    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let refreshControl = UIRefreshControl()
    private let stateContainer = UIView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private lazy var loadingStack = UIStackView(arrangedSubviews: [loadingSpinner, loadingLabel])
    private var emptyStateView: EmptyStateView?

    private var dataSource: UITableViewDiffableDataSource<String, String>!
    private var groupsByID: [String: SessionGroup] = [:]
    private var sessionsByID: [String: SessionDto] = [:]

    private var hasLoaded = false
    private var hasRenderedOnce = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "会话"
        view.backgroundColor = Theme.Colors.background

        configureTable()
        configureStateContainer()
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
        tableView.estimatedRowHeight = 72

        refreshControl.tintColor = Theme.Colors.textSecondary
        refreshControl.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)
        tableView.refreshControl = refreshControl

        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
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
        if state.groups.isEmpty {
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
            apply(state.groups)
        }

        if let actionError = state.actionError {
            viewModel.consumeActionError()
            presentAlert(title: "操作失败", message: actionError)
        }
    }

    private func apply(_ groups: [SessionGroup]) {
        groupsByID = Dictionary(groups.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        sessionsByID = Dictionary(
            groups.flatMap { $0.sessions }.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        var snapshot = NSDiffableDataSourceSnapshot<String, String>()
        for group in groups {
            snapshot.appendSections([group.id])
            snapshot.appendItems(group.sessions.map(\.id), toSection: group.id)
        }
        dataSource.apply(snapshot, animatingDifferences: hasRenderedOnce)
        hasRenderedOnce = true
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

    @objc private func refreshPulled() {
        Task {
            await viewModel.load(showLoading: false)
            refreshControl.endRefreshing()
        }
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
        let title = session.title.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名会话"
        let alert = UIAlertController(
            title: "删除会话？",
            message: "「\(title)」及其运行记录会被删除。",
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
    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        let header = tableView.dequeueReusableHeaderFooterView(
            withIdentifier: SessionSectionHeader.reuseIdentifier
        ) as! SessionSectionHeader

        if let id = dataSource.sectionIdentifier(for: section), let group = groupsByID[id] {
            header.configure(group: group)
        }
        return header
    }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
        32
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

private final class SessionSectionHeader: UITableViewHeaderFooterView {
    static let reuseIdentifier = "SessionSectionHeader"

    private let label = UILabel()

    override init(reuseIdentifier: String?) {
        super.init(reuseIdentifier: reuseIdentifier)

        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        label.numberOfLines = 1
        label.lineBreakMode = .byTruncatingMiddle
        label.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(label)

        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.lg),
            label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.lg),
            label.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(group: SessionGroup) {
        label.text = group.subtitle.isEmpty
            ? group.title
            : "\(group.title) · \(group.subtitle)"
    }
}
