import Combine
import PabootProtocol
import UIKit

/// Lists the daemon's workspaces and hosts every workspace mutation.
final class WorkspaceManagementViewController: UIViewController {
    private lazy var viewModel = WorkspaceManagementViewModel()
    private var cancellables = Set<AnyCancellable>()

    private let tableView = UITableView(frame: .zero, style: .plain)
    private let stateContainer = UIView()
    private let loadingStack = UIStackView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private var emptyStateView: EmptyStateView?

    private var workspaces: [WorkspaceDto] = []
    private var selectedWorkspaceId: String?
    private var hasLoaded = false
    private var hasPresentedActionError = false

    override func viewDidLoad() {
        super.viewDidLoad()

        title = "工作区"
        view.backgroundColor = Theme.Colors.background

        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "+ 新增",
            style: .plain,
            target: self,
            action: #selector(addWorkspace)
        )

        configureTable()
        configureStateContainer()
        bind()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        Task { await viewModel.load(showLoading: !hasLoaded) }
        hasLoaded = true
    }

    private func configureTable() {
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = Theme.Colors.background
        tableView.separatorStyle = .none
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 220
        tableView.register(WorkspaceCell.self, forCellReuseIdentifier: WorkspaceCell.reuseIdentifier)
        tableView.dataSource = self
        tableView.delegate = self

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

        loadingSpinner.color = Theme.Colors.textSecondary
        loadingLabel.text = "正在加载工作区…"
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
            stateContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
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

    private func render(_ state: WorkspaceManagementViewModel.State) {
        workspaces = state.workspaces
        selectedWorkspaceId = state.selectedWorkspaceId
        // Keep the table's row count in sync even when switching to the empty state.
        tableView.reloadData()

        if workspaces.isEmpty {
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
                    symbolName: "folder",
                    title: "还没有工作区",
                    message: "选择一个目录，把它注册为工作区",
                    actionTitle: "新增工作区",
                    action: { [weak self] in self?.presentDirectoryPicker(targetWorkspaceId: nil) }
                )
            }
        } else {
            loadingSpinner.stopAnimating()
            emptyStateView?.removeFromSuperview()
            emptyStateView = nil
            loadingStack.isHidden = true
            stateContainer.isHidden = true
            tableView.isHidden = false
        }

        if let error = state.actionError, !hasPresentedActionError {
            hasPresentedActionError = true
            viewModel.consumeActionError()
            presentAlert(title: "操作失败", message: error) { [weak self] in
                self?.hasPresentedActionError = false
            }
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

    @objc private func addWorkspace() {
        presentDirectoryPicker(targetWorkspaceId: nil)
    }

    private func presentDirectoryPicker(targetWorkspaceId: String?) {
        let pickerViewModel = DirectoryPickerViewModel(workspacePaths: workspaces.map(\.path))
        let picker = DirectoryPickerViewController(
            viewModel: pickerViewModel,
            mode: targetWorkspaceId == nil ? .createWorkspace : .addDirectory
        )
        picker.onSelect = { [weak self] path in
            guard let self else { return "页面已关闭" }
            if let targetWorkspaceId {
                return await self.viewModel.addDir(workspaceId: targetWorkspaceId, path: path)
            }
            return await self.viewModel.createWorkspace(path: path)
        }

        let navigation = UINavigationController(rootViewController: picker)
        navigation.modalPresentationStyle = .pageSheet
        if let presentation = navigation.sheetPresentationController {
            presentation.detents = [.large()]
            presentation.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func presentRename(_ workspace: WorkspaceDto) {
        let alert = UIAlertController(title: "重命名工作区", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = workspace.name
            field.placeholder = "名称"
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "保存", style: .default) { [weak self] _ in
            let name = alert.textFields?.first?.text ?? ""
            Task { await self?.viewModel.rename(workspace.id, name: name) }
        })
        present(alert, animated: true)
    }

    private func confirmDelete(_ workspace: WorkspaceDto) {
        guard !workspace.isDefault else { return }

        let name = workspace.name.isEmpty ? workspace.path : workspace.name
        let alert = UIAlertController(
            title: "删除工作区？",
            message: "删除「\(name)」只会移除注册信息，磁盘上的目录和文件不受影响。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))

        if workspace.sessionCount > 0 {
            alert.message = "「\(name)」下有 \(workspace.sessionCount) 个会话。"
                + "删除工作区时需同时删除聊天记录、运行事件与会话级授权；"
                + "电脑上的 Claude Code 会话记录不受影响，目录重新加回来仍能续接。"
            alert.addAction(
                UIAlertAction(
                    title: "同时删除 \(workspace.sessionCount) 个会话",
                    style: .destructive
                ) { [weak self] _ in
                    Task { await self?.viewModel.delete(workspace.id, cascade: true) }
                }
            )
        } else {
            alert.addAction(UIAlertAction(title: "删除", style: .destructive) { [weak self] _ in
                Task { await self?.viewModel.delete(workspace.id, cascade: false) }
            })
        }

        present(alert, animated: true)
    }

    private func confirmRemoveDir(_ workspace: WorkspaceDto, path: String) {
        let alert = UIAlertController(
            title: "移除附加目录？",
            message: "「\(path)」将不再对该工作区的所有会话可读写，磁盘内容不会被删除。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "移除", style: .destructive) { [weak self] _ in
            Task { await self?.viewModel.removeDir(workspaceId: workspace.id, path: path) }
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
}

extension WorkspaceManagementViewController: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        workspaces.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        guard indexPath.row < workspaces.count else {
            return UITableViewCell()
        }

        let cell = tableView.dequeueReusableCell(
            withIdentifier: WorkspaceCell.reuseIdentifier,
            for: indexPath
        ) as! WorkspaceCell
        let workspace = workspaces[indexPath.row]

        cell.configure(
            workspace: workspace,
            selected: workspace.id == selectedWorkspaceId
        )
        cell.onSelect = { [weak self] in self?.viewModel.select(workspace) }
        cell.onSetDefault = { [weak self] in
            Task { await self?.viewModel.setDefault(workspace.id) }
        }
        cell.onToggleEnabled = { [weak self] in
            Task { await self?.viewModel.setEnabled(workspace.id, enabled: !workspace.enabled) }
        }
        cell.onRename = { [weak self] in self?.presentRename(workspace) }
        cell.onAddDir = { [weak self] in
            self?.presentDirectoryPicker(targetWorkspaceId: workspace.id)
        }
        cell.onRemoveDir = { [weak self] path in
            self?.confirmRemoveDir(workspace, path: path)
        }
        cell.onHeightChange = { [weak self] in
            guard let self else { return }
            UIView.performWithoutAnimation {
                self.tableView.beginUpdates()
                self.tableView.endUpdates()
            }
        }
        return cell
    }
}

extension WorkspaceManagementViewController: UITableViewDelegate {
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        guard indexPath.row < workspaces.count else { return }
        viewModel.select(workspaces[indexPath.row])
    }

    func tableView(
        _ tableView: UITableView,
        trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        guard indexPath.row < workspaces.count else { return nil }
        let workspace = workspaces[indexPath.row]
        // The default workspace cannot be deleted, so it gets no swipe action at all.
        guard !workspace.isDefault else { return nil }

        let delete = UIContextualAction(style: .destructive, title: "删除") { [weak self] _, _, completion in
            self?.confirmDelete(workspace)
            completion(true)
        }
        let configuration = UISwipeActionsConfiguration(actions: [delete])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }
}

private final class WorkspaceCell: UITableViewCell {
    static let reuseIdentifier = "WorkspaceCell"

    var onSelect: (() -> Void)?
    var onSetDefault: (() -> Void)?
    var onToggleEnabled: (() -> Void)?
    var onRename: (() -> Void)?
    var onAddDir: (() -> Void)?
    var onRemoveDir: ((String) -> Void)?
    var onHeightChange: (() -> Void)?

    private let card = UIView()
    private let selectArea = UIControl()
    private let radioView = UIImageView()
    private let nameLabel = UILabel()
    private let defaultBadge = UILabel()
    private let disabledBadge = UILabel()
    private let sessionCountLabel = UILabel()
    private let bannerLabel = InsetLabel()
    private let primaryPathButton = UIButton(type: .system)
    private let dirsStack = UIStackView()
    private let actionsStack = UIStackView()
    private let setDefaultButton = UIButton(type: .system)
    private let toggleEnabledButton = UIButton(type: .system)
    private let renameButton = UIButton(type: .system)
    private let addDirButton = UIButton(type: .system)
    private let defaultNoteLabel = UILabel()

    private var workspace: WorkspaceDto?
    private var expandedPath: String?
    private var isSelectedRow = false

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        backgroundColor = .clear
        selectionStyle = .none
        contentView.backgroundColor = .clear

        card.translatesAutoresizingMaskIntoConstraints = false
        card.layer.cornerRadius = Radius.card
        card.layer.borderWidth = 1
        contentView.addSubview(card)

        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: contentView.topAnchor, constant: Spacing.xxs),
            card.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -Spacing.xxs),
            card.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.md),
            card.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
        ])

        configureSelectArea()
        configureBanner()
        configurePathButton()
        configureDirsStack()
        configureActionRow()
        configureDefaultNote()

        let mainStack = UIStackView(arrangedSubviews: [
            selectArea,
            bannerLabel,
            primaryPathButton,
            dirsStack,
            actionsStack,
            defaultNoteLabel,
        ])
        mainStack.axis = .vertical
        mainStack.spacing = Spacing.xxs
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(mainStack)

        NSLayoutConstraint.activate([
            mainStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
            mainStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
            mainStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            mainStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func configureSelectArea() {
        radioView.tintColor = Theme.Colors.primary
        radioView.contentMode = .scaleAspectFit
        radioView.translatesAutoresizingMaskIntoConstraints = false
        radioView.widthAnchor.constraint(equalToConstant: 22).isActive = true
        radioView.heightAnchor.constraint(equalToConstant: 22).isActive = true

        nameLabel.font = Typography.cardTitle
        nameLabel.textColor = Theme.Colors.textPrimary
        nameLabel.lineBreakMode = .byTruncatingTail

        configureBadge(defaultBadge, color: Theme.Colors.primary)
        configureBadge(disabledBadge, color: Theme.Colors.error)

        let nameRow = UIStackView(arrangedSubviews: [nameLabel, defaultBadge, disabledBadge])
        nameRow.axis = .horizontal
        nameRow.alignment = .center
        nameRow.spacing = 6

        sessionCountLabel.font = Typography.caption
        sessionCountLabel.textColor = Theme.Colors.textSecondary

        let textStack = UIStackView(arrangedSubviews: [nameRow, sessionCountLabel])
        textStack.axis = .vertical
        textStack.spacing = 2

        let stack = UIStackView(arrangedSubviews: [radioView, textStack])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = Spacing.xs
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        selectArea.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: selectArea.topAnchor, constant: 2),
            stack.bottomAnchor.constraint(equalTo: selectArea.bottomAnchor, constant: -2),
            stack.leadingAnchor.constraint(equalTo: selectArea.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: selectArea.trailingAnchor),
            selectArea.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        selectArea.addAction(UIAction { [weak self] _ in self?.onSelect?() }, for: .touchUpInside)
    }

    private func configureBadge(_ label: UILabel, color: UIColor) {
        label.font = Typography.caption
        label.textColor = color
        label.isHidden = true
        label.setContentHuggingPriority(.required, for: .horizontal)
    }

    private func configureBanner() {
        bannerLabel.font = Typography.code
        bannerLabel.textColor = Theme.Colors.textPrimary
        bannerLabel.numberOfLines = 0
        bannerLabel.backgroundColor = Theme.Colors.surface2
        bannerLabel.layer.cornerRadius = 8
        bannerLabel.layer.borderWidth = 1
        bannerLabel.layer.borderColor = Theme.Colors.border.cgColor
        bannerLabel.clipsToBounds = true
        bannerLabel.isHidden = true
        bannerLabel.isUserInteractionEnabled = true
        bannerLabel.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(collapseBanner))
        )
    }

    private func configurePathButton() {
        primaryPathButton.setTitleColor(Theme.Colors.textSecondary, for: .normal)
        primaryPathButton.titleLabel?.font = Typography.code
        primaryPathButton.titleLabel?.lineBreakMode = .byTruncatingMiddle
        primaryPathButton.contentHorizontalAlignment = .leading
        primaryPathButton.contentEdgeInsets = .zero
        primaryPathButton.addAction(
            UIAction { [weak self] _ in
                guard let self, let path = self.workspace?.path else { return }
                self.togglePath(path)
            },
            for: .touchUpInside
        )
    }

    private func configureDirsStack() {
        dirsStack.axis = .vertical
        dirsStack.spacing = 2
    }

    private func configureActionRow() {
        configureSmallButton(setDefaultButton, title: "设为默认")
        configureSmallButton(toggleEnabledButton, title: "禁用")
        configureSmallButton(renameButton, title: "重命名")
        configureSmallButton(addDirButton, title: "+ 附加目录")

        setDefaultButton.addAction(UIAction { [weak self] _ in self?.onSetDefault?() }, for: .touchUpInside)
        toggleEnabledButton.addAction(
            UIAction { [weak self] _ in self?.onToggleEnabled?() },
            for: .touchUpInside
        )
        renameButton.addAction(UIAction { [weak self] _ in self?.onRename?() }, for: .touchUpInside)
        addDirButton.addAction(UIAction { [weak self] _ in self?.onAddDir?() }, for: .touchUpInside)

        actionsStack.axis = .horizontal
        actionsStack.distribution = .fillEqually
        actionsStack.alignment = .center
        actionsStack.spacing = 0
        for button in [setDefaultButton, toggleEnabledButton, renameButton, addDirButton] {
            actionsStack.addArrangedSubview(button)
        }
    }

    private func configureSmallButton(_ button: UIButton, title: String) {
        button.setTitle(title, for: .normal)
        button.setTitleColor(Theme.Colors.primary, for: .normal)
        button.titleLabel?.font = Typography.caption
        button.titleLabel?.adjustsFontSizeToFitWidth = true
        button.titleLabel?.minimumScaleFactor = 0.8
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 36).isActive = true
    }

    private func configureDefaultNote() {
        defaultNoteLabel.text = "默认工作区不能删除，需先把另一个工作区设为默认"
        defaultNoteLabel.font = Typography.caption
        defaultNoteLabel.textColor = Theme.Colors.textMuted
        defaultNoteLabel.numberOfLines = 0
        defaultNoteLabel.isHidden = true
    }

    func configure(workspace: WorkspaceDto, selected: Bool) {
        self.workspace = workspace
        self.isSelectedRow = selected
        expandedPath = nil
        bannerLabel.isHidden = true

        radioView.image = UIImage(systemName: selected ? "largecircle.fill.circle" : "circle")
        radioView.tintColor = selected ? Theme.Colors.primary : Theme.Colors.textMuted
        nameLabel.text = workspace.name.isEmpty ? workspace.path : workspace.name
        defaultBadge.text = "默认"
        defaultBadge.isHidden = !workspace.isDefault
        disabledBadge.text = "已禁用"
        disabledBadge.isHidden = workspace.enabled
        sessionCountLabel.text = "\(workspace.sessionCount) 个会话"
        primaryPathButton.setTitle(workspace.path, for: .normal)

        setDefaultButton.isEnabled = !workspace.isDefault
        setDefaultButton.alpha = workspace.isDefault ? 0.4 : 1
        toggleEnabledButton.setTitle(workspace.enabled ? "禁用" : "启用", for: .normal)
        defaultNoteLabel.isHidden = !workspace.isDefault

        rebuildDirs(workspace.dirs)
        updateCardAppearance(selected: selected)
    }

    private func rebuildDirs(_ dirs: [String]) {
        dirsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for dir in dirs {
            let pathButton = UIButton(type: .system)
            pathButton.setTitle("＋ \(dir)", for: .normal)
            pathButton.setTitleColor(Theme.Colors.textSecondary, for: .normal)
            pathButton.titleLabel?.font = Typography.code
            pathButton.titleLabel?.lineBreakMode = .byTruncatingMiddle
            pathButton.contentHorizontalAlignment = .leading
            pathButton.addAction(
                UIAction { [weak self] _ in self?.togglePath(dir) },
                for: .touchUpInside
            )

            let removeButton = UIButton(type: .system)
            removeButton.setTitle("移除", for: .normal)
            removeButton.setTitleColor(Theme.Colors.primary, for: .normal)
            removeButton.titleLabel?.font = Typography.caption
            removeButton.setContentHuggingPriority(.required, for: .horizontal)
            removeButton.addAction(
                UIAction { [weak self] _ in self?.onRemoveDir?(dir) },
                for: .touchUpInside
            )

            let row = UIStackView(arrangedSubviews: [pathButton, removeButton])
            row.axis = .horizontal
            row.alignment = .center
            row.spacing = Spacing.xs
            dirsStack.addArrangedSubview(row)
        }
    }

    private func togglePath(_ path: String) {
        if expandedPath == path {
            collapseBanner()
            return
        }
        expandedPath = path
        bannerLabel.text = path
        bannerLabel.isHidden = false
        onHeightChange?()
    }

    @objc private func collapseBanner() {
        guard expandedPath != nil else { return }
        expandedPath = nil
        bannerLabel.isHidden = true
        onHeightChange?()
    }

    private func updateCardAppearance(selected: Bool) {
        card.backgroundColor = selected ? Theme.Colors.primarySubtle : Theme.Colors.surface
        card.layer.borderWidth = selected ? 1.5 : 1
        card.layer.borderColor = (selected ? Theme.Colors.primary : Theme.Colors.border)
            .resolvedColor(with: traitCollection)
            .cgColor
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)

        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            updateCardAppearance(selected: isSelectedRow)
            bannerLabel.layer.borderColor = Theme.Colors.border
                .resolvedColor(with: traitCollection)
                .cgColor
        }
    }
}

private final class InsetLabel: UILabel {
    private let insets = UIEdgeInsets(top: 6, left: 8, bottom: 6, right: 8)

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: insets))
    }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(
            width: size.width + insets.left + insets.right,
            height: size.height + insets.top + insets.bottom
        )
    }
}
