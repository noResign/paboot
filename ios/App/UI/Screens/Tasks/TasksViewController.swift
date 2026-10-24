import Combine
import UIKit
import PabootProtocol

/// Scheduled-task list. The daemon owns scheduling; this screen only creates,
/// toggles, runs and inspects tasks.
final class TasksViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let viewModel: ScheduledTasksViewModel
    private let screenTitle: String
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let refreshControl = UIRefreshControl()
    private let emptyView = EmptyStateView(
        symbolName: "calendar.badge.clock",
        title: "还没有定时任务",
        message: "按计划自动唤醒会话，或在工作区里执行命令。"
    )
    private let messageLabel = UILabel()
    private var cancellables = Set<AnyCancellable>()
    private var tasks: [ScheduledTaskDto] = []
    private var loadTask: Task<Void, Never>?

    /// Default arguments are evaluated in a nonisolated context, so the
    /// `@MainActor` view model is constructed inside the (isolated) init body.
    init(screenTitle: String = "任务") {
        self.viewModel = ScheduledTasksViewModel()
        self.screenTitle = screenTitle
        super.init(nibName: nil, bundle: nil)
    }

    init(viewModel: ScheduledTasksViewModel, screenTitle: String = "任务") {
        self.viewModel = viewModel
        self.screenTitle = screenTitle
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = screenTitle
        view.backgroundColor = Theme.Colors.background
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .add,
            target: self,
            action: #selector(addTapped)
        )

        messageLabel.font = Typography.caption
        messageLabel.textColor = Theme.Colors.error
        messageLabel.numberOfLines = 0
        messageLabel.isHidden = true
        messageLabel.translatesAutoresizingMaskIntoConstraints = false

        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(TaskCell.self, forCellReuseIdentifier: TaskCell.reuseIdentifier)
        tableView.backgroundColor = Theme.Colors.background
        // `.insetGrouped` reserves a large gap above the first section by default.
        tableView.sectionHeaderTopPadding = 0
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.refreshControl = refreshControl
        refreshControl.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)

        emptyView.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(messageLabel)
        view.addSubview(tableView)
        view.addSubview(emptyView)
        NSLayoutConstraint.activate([
            messageLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Spacing.xxs),
            messageLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            messageLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),

            tableView.topAnchor.constraint(equalTo: messageLabel.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            emptyView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            emptyView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            emptyView.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: Spacing.xl),
            emptyView.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -Spacing.xl),
        ])

        viewModel.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.render() }
            .store(in: &cancellables)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            guard let self else { return }
            await self.viewModel.load(showLoading: self.tasks.isEmpty)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // A late response must not reload the table while the controller is popping.
        loadTask?.cancel()
        loadTask = nil
    }

    private func render() {
        tasks = viewModel.state.tasks
        tableView.reloadData()
        emptyView.isHidden = viewModel.state.isLoading || !tasks.isEmpty
        refreshControl.endRefreshing()

        let error = viewModel.state.loadError ?? viewModel.state.actionError
        messageLabel.text = error
        messageLabel.isHidden = error == nil
        if error != nil {
            viewModel.clearActionError()
        }
    }

    @objc private func refreshPulled() {
        Task { await viewModel.load(showLoading: false) }
    }

    @objc private func addTapped() {
        let alert = UIAlertController(
            title: "用 AI 配置定时任务",
            message: "将打开「配置定时任务」会话。AI 会先问你想要完成什么任务，分析后给出名称、目标、计划和执行内容，确认后才会创建。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "开始配置", style: .default) { [weak self] _ in
            guard let self else { return }
            Task {
                guard let sessionId = await self.viewModel.startConfigSession(),
                      let connectionId = DaemonSession.shared.connection?.id else { return }
                AppRouter.shared.openSession(id: sessionId, connectionId: connectionId)
            }
        })
        present(alert, animated: true)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        tasks.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: TaskCell.reuseIdentifier, for: indexPath)
        if let cell = cell as? TaskCell {
            cell.configure(task: tasks[indexPath.row])
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let detail = TaskDetailViewController(taskId: tasks[indexPath.row].id, viewModel: viewModel)
        navigationController?.pushViewController(detail, animated: true)
    }
}

// MARK: - Cell

private final class TaskCell: UITableViewCell {
    static let reuseIdentifier = "TaskCell"

    private let nameLabel = UILabel()
    private let metaLabel = UILabel()
    private let statusLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = Theme.Colors.surface

        nameLabel.font = Typography.cardTitle
        nameLabel.textColor = Theme.Colors.textPrimary

        metaLabel.font = Typography.caption
        metaLabel.textColor = Theme.Colors.textMuted
        metaLabel.numberOfLines = 2

        statusLabel.font = Typography.caption
        statusLabel.setContentHuggingPriority(.required, for: .horizontal)
        statusLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        [nameLabel, metaLabel, statusLabel].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            contentView.addSubview($0)
        }

        NSLayoutConstraint.activate([
            nameLabel.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            nameLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.md),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: statusLabel.leadingAnchor, constant: -Spacing.xs),

            statusLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
            statusLabel.firstBaselineAnchor.constraint(equalTo: nameLabel.firstBaselineAnchor),

            metaLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 3),
            metaLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
            metaLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
            metaLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
        ])
        accessoryType = .disclosureIndicator
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(task: ScheduledTaskDto) {
        nameLabel.text = task.name
        let next = task.nextRunAt.map { Formatters.relativeTime(fromMilliseconds: $0) } ?? "—"
        let target: String
        if task.type == "command" {
            target = "执行命令"
        } else if let title = task.sessionTitle {
            target = "会话：\(title)"
        } else {
            target = "首次触发时创建会话"
        }
        metaLabel.text = "\(task.schedule.label) · 下次 \(next) · \(target)\(task.createdBy == "mcp" ? " · AI 创建" : "")"
        statusLabel.text = statusText(task)
        statusLabel.textColor = statusColor(task)
        accessoryType = .disclosureIndicator
    }

    private func statusText(_ task: ScheduledTaskDto) -> String {
        if !task.enabled { return "已停用" }
        switch task.lastStatus {
        case "running": return "运行中"
        case "failed": return "失败"
        case "succeeded": return "成功"
        case "cancelled": return "已取消"
        case "interrupted": return "已中断"
        case "skipped_busy": return "会话忙"
        case "skipped_missed": return "已错过"
        default: return "未运行"
        }
    }

    private func statusColor(_ task: ScheduledTaskDto) -> UIColor {
        if !task.enabled { return Theme.Colors.textMuted }
        switch task.lastStatus {
        case "failed": return Theme.Colors.error
        case "running": return Theme.Colors.primary
        case "succeeded": return Theme.Colors.success
        case "skipped_busy", "skipped_missed": return Theme.Colors.warning
        default: return Theme.Colors.textMuted
        }
    }
}

// MARK: - Detail

final class TaskDetailViewController: UIViewController {
    private let taskId: String
    private let viewModel: ScheduledTasksViewModel
    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let titleLabel = UILabel()
    private let metaLabel = UILabel()
    private let stateLabel = UILabel()
    private let contentLabel = UILabel()
    private let runsStack = UIStackView()
    private let runButton = TaskDetailViewController.makeButton(title: "立即运行", filled: true)
    private let toggleButton = TaskDetailViewController.makeButton(title: "停用", filled: false)
    private let editButton = TaskDetailViewController.makeButton(title: "编辑", filled: false)
    private let deleteButton = TaskDetailViewController.makeButton(title: "删除", filled: false)
    private var cancellables = Set<AnyCancellable>()

    init(taskId: String, viewModel: ScheduledTasksViewModel) {
        self.taskId = taskId
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
        title = "任务详情"

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        stack.axis = .vertical
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)

        titleLabel.font = Typography.pageTitle
        titleLabel.numberOfLines = 0
        metaLabel.font = Typography.caption
        metaLabel.textColor = Theme.Colors.textMuted
        metaLabel.numberOfLines = 0
        stateLabel.font = Typography.caption
        stateLabel.textColor = Theme.Colors.error
        stateLabel.numberOfLines = 0
        contentLabel.font = Typography.code
        contentLabel.numberOfLines = 0
        contentLabel.textColor = Theme.Colors.textPrimary
        runsStack.axis = .vertical
        runsStack.spacing = Spacing.xxs

        let actionsTop = UIStackView(arrangedSubviews: [runButton, toggleButton])
        actionsTop.axis = .horizontal
        actionsTop.spacing = Spacing.xs
        actionsTop.distribution = .fillEqually
        let actionsBottom = UIStackView(arrangedSubviews: [editButton, deleteButton])
        actionsBottom.axis = .horizontal
        actionsBottom.spacing = Spacing.xs
        actionsBottom.distribution = .fillEqually
        let actions = UIStackView(arrangedSubviews: [actionsTop, actionsBottom])
        actions.axis = .vertical
        actions.spacing = Spacing.xs

        runButton.addAction(UIAction { [weak self] _ in
            guard let self, let task = self.currentTask else { return }
            Task { await self.viewModel.runNow(task) }
        }, for: .touchUpInside)
        toggleButton.addAction(UIAction { [weak self] _ in
            guard let self, let task = self.currentTask else { return }
            Task { await self.viewModel.toggle(task) }
        }, for: .touchUpInside)
        editButton.addAction(UIAction { [weak self] _ in self?.presentEditor() }, for: .touchUpInside)
        deleteButton.addAction(UIAction { [weak self] _ in self?.confirmDelete() }, for: .touchUpInside)

        stack.addArrangedSubview(titleLabel)
        stack.addArrangedSubview(metaLabel)
        stack.addArrangedSubview(stateLabel)
        stack.addArrangedSubview(actions)
        stack.addArrangedSubview(contentLabel)
        stack.addArrangedSubview(makeSectionLabel("执行历史"))
        stack.addArrangedSubview(runsStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.lg),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.xl),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -2 * Spacing.lg),
        ])

        viewModel.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.render() }
            .store(in: &cancellables)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await viewModel.loadDetail(id: taskId) }
    }

    private var currentTask: ScheduledTaskDto? {
        guard let detail = viewModel.state.detail, detail.task.id == taskId else { return nil }
        return detail.task
    }

    private func render() {
        guard let detail = viewModel.state.detail, detail.task.id == taskId else { return }
        let task = detail.task
        titleLabel.text = task.name
        let next = task.nextRunAt.map { Formatters.relativeTime(fromMilliseconds: $0) } ?? "—"
        let last = task.lastRunAt.map { Formatters.relativeTime(fromMilliseconds: $0) } ?? "—"
        metaLabel.text = "\(task.schedule.label) · 下次 \(next) · 上次 \(last) · 已执行 \(task.runCount) 次\n" +
            "完全权限\(task.createdBy == "mcp" ? " · AI 创建" : "")"
        var stateText: [String] = []
        if !task.enabled { stateText.append("已停用" + (task.disabledReason.map { "：\($0)" } ?? "")) }
        if let error = task.lastError { stateText.append("最近错误：\(error)") }
        if let actionError = viewModel.state.actionError { stateText.append(actionError) }
        stateLabel.text = stateText.isEmpty ? nil : stateText.joined(separator: "\n")
        stateLabel.isHidden = stateText.isEmpty
        contentLabel.text = task.type == "command" ? task.command : task.prompt
        toggleButton.configuration?.title = task.enabled ? "停用" : "启用"

        runsStack.arrangedSubviews.forEach {
            runsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if detail.runs.isEmpty {
            let empty = UILabel()
            empty.text = "还没有执行记录"
            empty.font = Typography.caption
            empty.textColor = Theme.Colors.textMuted
            runsStack.addArrangedSubview(empty)
        }
        for run in detail.runs {
            let label = UILabel()
            label.font = Typography.caption
            label.textColor = run.status == "failed" ? Theme.Colors.error : Theme.Colors.textSecondary
            let trigger = run.trigger == "scheduled" ? "定时" : run.trigger == "run_now" ? "手动" : "交互"
            let when = Formatters.relativeTime(fromMilliseconds: run.startedAt)
            label.text = "\(when) · \(run.status) · \(trigger)"
            runsStack.addArrangedSubview(label)

            if let output = run.output, !output.isEmpty {
                let outputLabel = UILabel()
                outputLabel.font = Typography.code
                outputLabel.textColor = Theme.Colors.textMuted
                outputLabel.numberOfLines = 8
                outputLabel.text = output
                runsStack.addArrangedSubview(outputLabel)
            }
        }
    }

    private func presentEditor() {
        guard let task = currentTask else { return }
        let editor = TaskEditorViewController(viewModel: viewModel, task: task)
        let navigation = UINavigationController(rootViewController: editor)
        navigation.modalPresentationStyle = .pageSheet
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func confirmDelete() {
        guard let task = currentTask else { return }
        let alert = UIAlertController(title: "删除定时任务", message: "确定删除「\(task.name)」？", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "删除", style: .destructive) { [weak self] _ in
            guard let self else { return }
            Task {
                if await self.viewModel.delete(task) {
                    self.navigationController?.popViewController(animated: true)
                }
            }
        })
        present(alert, animated: true)
    }

    private static func makeButton(title: String, filled: Bool) -> UIButton {
        var configuration = filled ? UIButton.Configuration.filled() : UIButton.Configuration.tinted()
        configuration.title = title
        configuration.baseForegroundColor = filled ? Theme.Colors.onPrimary : Theme.Colors.primary
        if filled {
            configuration.baseBackgroundColor = Theme.Colors.primary
        }
        return UIButton(configuration: configuration)
    }

    private func makeSectionLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.cardTitle
        label.textColor = Theme.Colors.textPrimary
        return label
    }
}

// MARK: - Editor

final class TaskEditorViewController: UIViewController {
    private let viewModel: ScheduledTasksViewModel
    private let task: ScheduledTaskDto
    private let scheduleEditable: Bool
    private let initialTime: Date

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let nameField = UITextField()
    private let metaLabel = UILabel()
    private let presetButton = UIButton(type: .system)
    private let contentLabel = UILabel()
    private let contentTextView = UITextView()
    private let targetButton = UIButton(type: .system)
    private var targetMode: String
    private var targetSessionId: String?
    private var targetTitle: String
    private let timePicker = UIDatePicker()
    private let everyField = UITextField()
    private let daysStack = UIStackView()
    private let cronLabel = UILabel()
    private let noteLabel = UILabel()
    private let errorLabel = UILabel()
    private let saveButton = UIButton(type: .system)
    private var dayButtons: [UIButton] = []
    private var cancellables = Set<AnyCancellable>()

    private let presets = [
        ("daily", "每天"), ("weekdays", "工作日"), ("weekly", "每周指定日"),
        ("every_minutes", "每 N 分钟"), ("every_hours", "每 N 小时"),
    ]
    private var preset: String
    private var selectedDays: Set<Int>

    private let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    init(viewModel: ScheduledTasksViewModel, task: ScheduledTaskDto) {
        self.viewModel = viewModel
        self.task = task
        let presetDto = task.schedule.preset
        self.scheduleEditable = presetDto != nil
        self.preset = presetDto?.preset ?? "daily"
        self.selectedDays = Set(presetDto?.days ?? [1])
        // A "new" task that has already fired has a bound session; the binding,
        // not the creation mode, is what the scheduler resumes.
        self.targetMode = task.sessionId == nil ? "new" : "existing"
        self.targetSessionId = task.sessionId
        self.targetTitle = task.sessionTitle.flatMap { $0.isEmpty ? nil : $0 }
            ?? task.sessionId
            ?? "首次触发时新建会话"

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        let text = presetDto?.time ?? "09:00"
        if let parsed = formatter.date(from: text) {
            let parts = Calendar.current.dateComponents([.hour, .minute], from: parsed)
            var today = Calendar.current.dateComponents([.year, .month, .day], from: Date())
            today.hour = parts.hour
            today.minute = parts.minute
            self.initialTime = Calendar.current.date(from: today) ?? Date()
        } else {
            self.initialTime = Date()
        }
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.Colors.background
        title = "编辑定时任务"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped)
        )

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        stack.axis = .vertical
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.lg),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.xl),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -2 * Spacing.lg),
        ])

        buildForm()
        rebuildMenus()
        updateVisibility()

        viewModel.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self else { return }
                self.errorLabel.text = state.actionError
                self.errorLabel.isHidden = state.actionError == nil
            }
            .store(in: &cancellables)
    }

    private func buildForm() {
        metaLabel.font = Typography.caption
        metaLabel.textColor = Theme.Colors.textMuted
        metaLabel.numberOfLines = 0
        metaLabel.text = "\(task.type == "command" ? "命令任务" : "AI 会话任务") · 完全权限"

        nameField.borderStyle = .roundedRect
        nameField.font = Typography.body
        nameField.text = task.name

        targetButton.contentHorizontalAlignment = .leading
        targetButton.titleLabel?.font = Typography.body
        targetButton.setTitleColor(Theme.Colors.primary, for: .normal)
        targetButton.addAction(
            UIAction { [weak self] _ in self?.presentTargetPicker() },
            for: .touchUpInside
        )
        updateTargetButton()

        presetButton.contentHorizontalAlignment = .leading
        presetButton.showsMenuAsPrimaryAction = true

        contentLabel.text = task.type == "command" ? "命令（工作区根目录执行）" : "Prompt"
        contentTextView.font = Typography.body
        contentTextView.text = task.type == "command" ? (task.command ?? "") : (task.prompt ?? "")
        contentTextView.layer.borderWidth = 1
        contentTextView.layer.borderColor = Theme.Colors.border.cgColor
        contentTextView.layer.cornerRadius = 8
        contentTextView.heightAnchor.constraint(equalToConstant: 110).isActive = true

        timePicker.datePickerMode = .time
        timePicker.preferredDatePickerStyle = .compact
        timePicker.date = initialTime

        everyField.borderStyle = .roundedRect
        everyField.keyboardType = .numberPad
        everyField.font = Typography.body
        everyField.text = String(task.schedule.preset?.every ?? 6)

        daysStack.axis = .horizontal
        daysStack.spacing = 4
        daysStack.distribution = .fillEqually
        for (index, title) in ["日", "一", "二", "三", "四", "五", "六"].enumerated() {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = Typography.caption
            button.layer.cornerRadius = 8
            button.tag = index
            button.addAction(UIAction { [weak self] _ in
                self?.toggleDay(index)
            }, for: .touchUpInside)
            dayButtons.append(button)
            daysStack.addArrangedSubview(button)
        }
        updateDayButtons()

        cronLabel.font = Typography.caption
        cronLabel.textColor = Theme.Colors.textSecondary
        cronLabel.numberOfLines = 0
        cronLabel.text = "该任务使用自定义 cron（\(task.schedule.cron)），当前只能编辑名称和内容。"

        noteLabel.font = Typography.caption
        noteLabel.textColor = Theme.Colors.textSecondary
        noteLabel.numberOfLines = 0
        noteLabel.text = "修改（含目标会话）从下一次触发开始生效；正在运行的 run 不受影响。"

        errorLabel.font = Typography.caption
        errorLabel.textColor = Theme.Colors.error
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true

        var saveConfiguration = UIButton.Configuration.filled()
        saveConfiguration.title = "保存"
        saveConfiguration.baseBackgroundColor = Theme.Colors.primary
        saveConfiguration.baseForegroundColor = Theme.Colors.onPrimary
        saveButton.configuration = saveConfiguration
        saveButton.addAction(UIAction { [weak self] _ in self?.saveTapped() }, for: .touchUpInside)

        var fields: [UIView] = [metaLabel, makeCaption("名称"), nameField]
        if task.type == "ai" {
            fields.append(makeCaption("目标会话"))
            fields.append(targetButton)
        }
        fields.append(contentsOf: [
            contentLabel, contentTextView,
            makeCaption("计划"), presetButton, timePicker, daysStack, everyField,
            cronLabel, noteLabel, errorLabel, saveButton,
        ])
        fields.forEach { stack.addArrangedSubview($0) }
    }

    private func updateTargetButton() {
        let title = targetMode == "new" ? "下次运行新建会话" : "会话：\(targetTitle)"
        targetButton.setTitle("\(title)  ›", for: .normal)
    }

    private func presentTargetPicker() {
        let picker = TargetSessionPickerViewController(
            workspaceId: task.workspaceId,
            selectedSessionId: targetMode == "existing" ? targetSessionId : nil,
            newSelected: targetMode == "new"
        )
        picker.onSelect = { [weak self] mode, session in
            guard let self else { return }
            self.targetMode = mode
            self.targetSessionId = session?.id
            if let session {
                self.targetTitle = session.title.flatMap { $0.isEmpty ? nil : $0 } ?? session.cwd
            } else {
                self.targetTitle = "首次触发时新建会话"
            }
            self.updateTargetButton()
        }
        let navigation = UINavigationController(rootViewController: picker)
        navigation.modalPresentationStyle = .pageSheet
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func rebuildMenus() {
        presetButton.menu = UIMenu(children: presets.map { (value, label) in
            UIAction(title: label, state: value == preset ? .on : .off) { [weak self] _ in
                self?.preset = value
                self?.updateVisibility()
            }
        })
        presetButton.setTitle(presets.first { $0.0 == preset }?.1 ?? preset, for: .normal)
    }

    private func updateVisibility() {
        let usesClock = preset == "daily" || preset == "weekdays" || preset == "weekly"
        let usesInterval = preset == "every_minutes" || preset == "every_hours"
        presetButton.isHidden = !scheduleEditable
        timePicker.isHidden = !scheduleEditable || !usesClock
        daysStack.isHidden = !scheduleEditable || preset != "weekly"
        everyField.isHidden = !scheduleEditable || !usesInterval
        cronLabel.isHidden = scheduleEditable
        rebuildMenus()
    }

    private func toggleDay(_ index: Int) {
        if selectedDays.contains(index) {
            selectedDays.remove(index)
        } else {
            selectedDays.insert(index)
        }
        updateDayButtons()
    }

    private func updateDayButtons() {
        for (index, button) in dayButtons.enumerated() {
            let selected = selectedDays.contains(index)
            button.backgroundColor = selected ? Theme.Colors.primarySubtle : .clear
            button.setTitleColor(selected ? Theme.Colors.primaryDeep : Theme.Colors.textSecondary, for: .normal)
        }
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
    }

    private func saveTapped() {
        let name = (nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let content = contentTextView.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let isAI = task.type == "ai"
        guard !name.isEmpty else { return showError("请填写任务名称") }
        guard !content.isEmpty else { return showError(isAI ? "请填写 prompt" : "请填写命令") }
        if scheduleEditable && preset == "weekly" && selectedDays.isEmpty {
            return showError("请至少选择一个星期")
        }
        if isAI && targetMode == "existing" && targetSessionId == nil {
            return showError("请选择目标会话")
        }

        // Only send `target` when the binding actually changed; otherwise the
        // server would rewrite runtime/model on every save.
        let currentMode = task.sessionId == nil ? "new" : "existing"
        let targetChanged = isAI
            && (targetMode != currentMode
                || (targetMode == "existing" && targetSessionId != task.sessionId))
        let target: ScheduledTaskTargetInput?
        if !targetChanged {
            target = nil
        } else if targetMode == "existing", let sessionId = targetSessionId {
            target = ScheduledTaskTargetInput(mode: "existing", sessionId: sessionId)
        } else {
            target = ScheduledTaskTargetInput(mode: "new")
        }

        let draft = TaskDraft(
            name: name,
            type: task.type,
            prompt: isAI ? content : "",
            command: isAI ? "" : content,
            targetMode: targetMode,
            sessionId: targetSessionId,
            runtime: task.runtime,
            preset: preset,
            time: timeFormatter.string(from: timePicker.date),
            days: selectedDays.sorted(),
            every: Int(everyField.text ?? "") ?? 6
        )
        saveButton.isEnabled = false
        Task {
            let saved = await viewModel.update(
                taskId: task.id,
                draft: draft,
                scheduleEditable: scheduleEditable,
                target: target
            )
            saveButton.isEnabled = true
            if saved {
                dismiss(animated: true)
            }
        }
    }

    private func showError(_ message: String) {
        errorLabel.text = message
        errorLabel.isHidden = false
    }

    private func makeCaption(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        return label
    }
}

/// Picks the session a scheduled AI task runs in. Selecting "new session"
/// unbinds the task so the next fire creates one.
private final class TargetSessionPickerViewController: UITableViewController {
    private let workspaceId: String
    private let selectedSessionId: String?
    private let newSelected: Bool
    private var sessions: [SessionDto] = []
    private var loading = true
    var onSelect: ((String, SessionDto?) -> Void)?

    init(workspaceId: String, selectedSessionId: String?, newSelected: Bool) {
        self.workspaceId = workspaceId
        self.selectedSessionId = selectedSessionId
        self.newSelected = newSelected
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.Colors.background
        title = "目标会话"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped)
        )
        Task { [weak self] in
            guard let self else { return }
            let sessions = (try? await SessionRepository().loadSessions(workspaceId: workspaceId)) ?? []
            guard !Task.isCancelled else { return }
            // The reusable task-authoring chat is not a meaningful target.
            self.sessions = sessions.filter { $0.purpose == nil }
            self.loading = false
            self.tableView.reloadData()
        }
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section == 0 ? "运行方式" : "已有会话"
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? 1 : (loading ? 1 : sessions.count)
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.backgroundColor = Theme.Colors.surface
        cell.textLabel?.font = Typography.body
        cell.textLabel?.textColor = Theme.Colors.textPrimary
        cell.detailTextLabel?.font = Typography.caption
        cell.detailTextLabel?.textColor = Theme.Colors.textSecondary

        if indexPath.section == 0 {
            cell.textLabel?.text = "下次运行新建会话"
            cell.detailTextLabel?.text = "首次触发时创建，之后一直复用"
            cell.accessoryType = newSelected ? .checkmark : .none
        } else if loading {
            cell.textLabel?.text = "正在加载会话…"
            cell.selectionStyle = .none
        } else {
            let session = sessions[indexPath.row]
            cell.textLabel?.text = session.title.flatMap { $0.isEmpty ? nil : $0 } ?? session.cwd
            cell.detailTextLabel?.text = "\(session.runtime) · \(session.cwd)"
            cell.accessoryType = session.id == selectedSessionId ? .checkmark : .none
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if indexPath.section == 0 {
            onSelect?("new", nil)
        } else {
            guard !loading else { return }
            onSelect?("existing", sessions[indexPath.row])
        }
        dismiss(animated: true)
    }
}
