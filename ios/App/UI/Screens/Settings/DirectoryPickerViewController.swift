import Combine
import PabootProtocol
import UIKit

/// Absolute-path directory browser on the daemon host.
///
/// Used for both "create workspace from this folder" and "add an extra dir to this workspace".
/// The distinction only changes the title and which daemon call `onSelect` performs.
final class DirectoryPickerViewController: UIViewController {
    enum Mode: Equatable {
        case createWorkspace
        case addDirectory
        /// File-tab bookmark: browsable only, grants the agent no access.
        case browseShortcut
    }

    /// Returns `nil` on success, otherwise a message to show and keep the picker open.
    var onSelect: ((String) async -> String?)?

    private let viewModel: DirectoryPickerViewModel
    private let mode: Mode
    private var cancellables = Set<AnyCancellable>()

    private let pathLabel = UILabel()
    private let hiddenSwitch = UISwitch()
    private let contentContainer = UIView()
    private let tableView = UITableView(frame: .zero, style: .plain)
    private let stateContainer = UIView()
    private var emptyStateView: EmptyStateView?
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let selectButton = UIButton(type: .system)

    private var entries: [DirectoryEntryDto] = []
    private var parent: String?
    private var currentPath: String?
    private var isWorkspace = false
    private var isLoading = true
    private var isSelecting = false

    init(viewModel: DirectoryPickerViewModel, mode: Mode) {
        self.viewModel = viewModel
        self.mode = mode
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        switch mode {
        case .createWorkspace:
            title = "选择工作区目录"
        case .addDirectory:
            title = "选择附加目录"
        case .browseShortcut:
            title = "添加浏览目录"
        }
        view.backgroundColor = Theme.Colors.background

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "取消",
            style: .plain,
            target: self,
            action: #selector(cancel)
        )

        configureInfoSection()
        configureContent()
        configureSelectButton()
        bind()

        Task { await viewModel.load(path: nil) }
    }

    private func configureInfoSection() {
        pathLabel.font = Typography.code
        pathLabel.textColor = Theme.Colors.textSecondary
        pathLabel.numberOfLines = 2
        pathLabel.lineBreakMode = .byTruncatingMiddle
        pathLabel.text = "加载中…"

        let hiddenLabel = UILabel()
        hiddenLabel.text = "显示隐藏目录"
        hiddenLabel.font = Typography.body
        hiddenLabel.textColor = Theme.Colors.textPrimary

        hiddenSwitch.onTintColor = Theme.Colors.primary
        hiddenSwitch.addTarget(self, action: #selector(hiddenChanged), for: .valueChanged)

        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let hiddenRow = UIStackView(arrangedSubviews: [hiddenLabel, spacer, hiddenSwitch])
        hiddenRow.axis = .horizontal
        hiddenRow.alignment = .center
        hiddenRow.spacing = Spacing.sm

        let infoStack = UIStackView(arrangedSubviews: [pathLabel, hiddenRow])
        infoStack.axis = .vertical
        infoStack.spacing = Spacing.xs
        infoStack.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(infoStack)
        NSLayoutConstraint.activate([
            infoStack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Spacing.md),
            infoStack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            infoStack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
        ])

        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(contentContainer)
        NSLayoutConstraint.activate([
            contentContainer.topAnchor.constraint(equalTo: infoStack.bottomAnchor, constant: Spacing.sm),
            contentContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func configureContent() {
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = Theme.Colors.background
        tableView.separatorInset = UIEdgeInsets(top: 0, left: Spacing.lg, bottom: 0, right: 0)
        tableView.rowHeight = 52
        tableView.tableFooterView = UIView()
        tableView.dataSource = self
        tableView.delegate = self
        contentContainer.addSubview(tableView)

        stateContainer.translatesAutoresizingMaskIntoConstraints = false
        stateContainer.isHidden = true
        contentContainer.addSubview(stateContainer)

        spinner.color = Theme.Colors.textSecondary
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(spinner)

        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            stateContainer.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            stateContainer.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            stateContainer.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            stateContainer.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            spinner.centerXAnchor.constraint(equalTo: contentContainer.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: contentContainer.centerYAnchor),
        ])
    }

    private func configureSelectButton() {
        selectButton.setTitle("选择当前文件夹", for: .normal)
        selectButton.titleLabel?.font = Typography.cardTitle
        selectButton.setTitleColor(Theme.Colors.onPrimary, for: .normal)
        selectButton.backgroundColor = Theme.Colors.primary
        selectButton.layer.cornerRadius = Radius.card
        selectButton.translatesAutoresizingMaskIntoConstraints = false
        selectButton.heightAnchor.constraint(equalToConstant: Layout.minTouchTarget).isActive = true
        selectButton.addAction(UIAction { [weak self] _ in self?.confirmSelection() }, for: .touchUpInside)

        view.addSubview(selectButton)
        NSLayoutConstraint.activate([
            selectButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            selectButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
            selectButton.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -Spacing.lg
            ),
            contentContainer.bottomAnchor.constraint(equalTo: selectButton.topAnchor, constant: -Spacing.sm),
        ])
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: DirectoryPickerViewModel.State) {
        entries = state.entries
        parent = state.parent
        currentPath = state.path
        isWorkspace = state.isWorkspace
        isLoading = state.isLoading

        pathLabel.text = state.path ?? "~"
        hiddenSwitch.setOn(state.showHidden, animated: false)
        tableView.reloadData()
        updateSelectButton()

        if state.isLoading {
            spinner.startAnimating()
        } else {
            spinner.stopAnimating()
        }

        if let error = state.error {
            tableView.isHidden = true
            stateContainer.isHidden = false
            showEmpty(error)
        } else {
            tableView.isHidden = false
            stateContainer.isHidden = true
            emptyStateView?.removeFromSuperview()
            emptyStateView = nil
        }
    }

    private func showEmpty(_ message: String) {
        emptyStateView?.removeFromSuperview()

        let empty = EmptyStateView(
            symbolName: "exclamationmark.triangle",
            title: "无法读取目录",
            message: message,
            actionTitle: "重试",
            onAction: { [weak self] in
                Task { await self?.viewModel.retry() }
            }
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

    private func updateSelectButton() {
        guard !isSelecting else { return }

        let blocked = mode == .createWorkspace && isWorkspace
        let enabled = currentPath != nil && !blocked && !isLoading
        selectButton.isEnabled = enabled
        selectButton.alpha = enabled ? 1 : 0.5

        if blocked {
            selectButton.setTitle("已是工作区", for: .normal)
        } else {
            switch mode {
            case .createWorkspace:
                selectButton.setTitle("选择当前文件夹", for: .normal)
            case .addDirectory:
                selectButton.setTitle("添加此文件夹", for: .normal)
            case .browseShortcut:
                selectButton.setTitle("加为快捷（不改权限）", for: .normal)
            }
        }
    }

    private func confirmSelection() {
        guard let path = currentPath, !isSelecting else { return }

        guard let onSelect else {
            dismiss(animated: true)
            return
        }

        isSelecting = true
        selectButton.isEnabled = false
        selectButton.setTitle("处理中…", for: .normal)

        Task {
            let error = await onSelect(path)

            if let error {
                isSelecting = false
                presentAlert(title: "操作失败", message: error)
                updateSelectButton()
            } else {
                dismiss(animated: true)
            }
        }
    }

    @objc private func cancel() {
        dismiss(animated: true)
    }

    @objc private func hiddenChanged() {
        Task { await viewModel.toggleHidden() }
    }

    private func presentAlert(title: String, message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}

extension DirectoryPickerViewController: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        entries.count + (parent == nil ? 0 : 1)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "DirectoryCell")
            ?? UITableViewCell(style: .default, reuseIdentifier: "DirectoryCell")

        cell.textLabel?.font = Typography.body
        cell.textLabel?.textColor = Theme.Colors.textPrimary
        cell.backgroundColor = Theme.Colors.background
        cell.accessoryType = .disclosureIndicator

        if parent != nil && indexPath.row == 0 {
            cell.textLabel?.text = "上一级"
            cell.imageView?.image = UIImage(systemName: "arrow.up")
            cell.imageView?.tintColor = Theme.Colors.textSecondary
            cell.accessibilityLabel = "上一级"
        } else {
            let entry = entries[indexPath.row - (parent == nil ? 0 : 1)]
            cell.textLabel?.text = entry.isWorkspace ? "\(entry.name)（已是工作区）" : entry.name
            cell.imageView?.image = UIImage(systemName: "folder")
            cell.imageView?.tintColor = Theme.Colors.primary
            cell.accessibilityLabel = entry.isWorkspace
                ? "\(entry.name)，已是工作区"
                : entry.name
        }

        return cell
    }
}

extension DirectoryPickerViewController: UITableViewDelegate {
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard !isLoading else { return }

        if parent != nil && indexPath.row == 0 {
            Task { await viewModel.goUp() }
            return
        }

        let entry = entries[indexPath.row - (parent == nil ? 0 : 1)]
        Task { await viewModel.open(entry) }
    }
}
