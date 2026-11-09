import UIKit
import PabootProtocol

private struct MemoryGroup {
    let kind: String
    let label: String
    let claims: [MemoryClaimDto]
}

private let memoryGroupSpec: [(kind: String, label: String)] = [
    ("fact", "关于你"),
    ("preference", "偏好"),
    ("relation", "关系"),
    ("profile", "画像"),
]

private func memoryKindLabel(_ kind: String) -> String {
    memoryGroupSpec.first { $0.kind == kind }?.label ?? kind
}

private func shortClaimId(_ id: String) -> String {
    String(id.replacingOccurrences(of: "-", with: "").prefix(4))
}

private func entityKindLabel(_ kind: String) -> String {
    switch kind {
    case "person": return "人物"
    case "place": return "地点"
    case "org": return "组织"
    case "pet": return "宠物"
    case "project": return "项目"
    case "thing": return "事物"
    default: return kind
    }
}

private func memoryAuthorityLabel(_ claim: MemoryClaimDto) -> String {
    claim.authority == "user_confirmed" ? "你已确认" : "自动整理"
}

private func memoryDateLabel(_ timestamp: Int64?) -> String {
    guard let timestamp, timestamp > 0 else { return "—" }
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000))
}

/// validFrom = 事实开始生效；validTo 为空表示仍然有效。
private func memoryValidityLabel(_ claim: MemoryClaimDto) -> String {
    let from = claim.validFrom.flatMap { $0 > 0 ? $0 : nil }
    let to = claim.validTo.flatMap { $0 > 0 ? $0 : nil }
    switch (from, to) {
    case (nil, nil):
        return "未知"
    case let (from?, to?):
        return "\(memoryDateLabel(from)) – \(memoryDateLabel(to))"
    case let (from?, nil):
        return "\(memoryDateLabel(from)) 起"
    case let (nil, to?):
        return "至 \(memoryDateLabel(to))"
    }
}

private func memoryMatches(_ claim: MemoryClaimDto, query: String) -> Bool {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if needle.isEmpty { return true }
    let haystack = [
        claim.summary,
        claim.objectText ?? "",
        claim.predicate,
        claim.evidence.map { $0.quote ?? "" }.joined(separator: "\n"),
    ].joined(separator: "\n").lowercased()
    return haystack.contains(needle)
}

private func groupedMemory(_ claims: [MemoryClaimDto], query: String) -> [MemoryGroup] {
    memoryGroupSpec.compactMap { spec in
        let rows = claims
            .filter { $0.kind == spec.kind && memoryMatches($0, query: query) }
            .sorted { lhs, rhs in
                let leftConfirmed = lhs.authority == "user_confirmed" ? 1 : 0
                let rightConfirmed = rhs.authority == "user_confirmed" ? 1 : 0
                if leftConfirmed != rightConfirmed { return leftConfirmed > rightConfirmed }
                if lhs.importance != rhs.importance { return lhs.importance > rhs.importance }
                return lhs.updatedAt > rhs.updatedAt
            }
        return rows.isEmpty ? nil : MemoryGroup(kind: spec.kind, label: spec.label, claims: rows)
    }
}

/// Memory M0「关于你」: grouped compact list + search + detail page.
final class MemoryViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UISearchBarDelegate {
    private let repository = MemoryRepository()
    private let workspaceId: String
    private let workspaceName: String
    private let family: String

    private let statusLabel = UILabel()
    private let searchBar = UISearchBar()
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let emptyLabel = UILabel()

    private var claims: [MemoryClaimDto] = []
    private var groups: [MemoryGroup] = []
    private var status: MemoryStatusDto?
    private var settings: WorkspaceMemoryDto?
    private var timeline: [MemoryTimelineItemDto] = []
    private var duplicates: [MemoryDuplicateDto] = []
    private var entities: [MemoryEntityDto] = []
    private var disputes: [MemoryDisputeDto] = []
    private var statusUnavailable = false
    private var query = ""
    private var hasLoaded = false
    private var loadGeneration = 0

    init(workspaceId: String, workspaceName: String, family: String = "life") {
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.family = family
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = family == "life" ? "关于你" : "项目记忆"
        view.backgroundColor = Theme.Colors.background
        configureLayout()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    private func configureLayout() {
        statusLabel.numberOfLines = 0
        statusLabel.font = Typography.caption
        statusLabel.textColor = Theme.Colors.textSecondary
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        searchBar.placeholder = "搜索摘要、内容或来源原话"
        searchBar.delegate = self
        searchBar.searchBarStyle = .minimal
        searchBar.translatesAutoresizingMaskIntoConstraints = false

        tableView.dataSource = self
        tableView.delegate = self
        tableView.backgroundColor = Theme.Colors.background
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 64
        tableView.translatesAutoresizingMaskIntoConstraints = false

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true

        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.numberOfLines = 0
        emptyLabel.textAlignment = .center
        emptyLabel.font = Typography.caption
        emptyLabel.textColor = Theme.Colors.textSecondary
        emptyLabel.isHidden = true

        view.addSubview(statusLabel)
        view.addSubview(searchBar)
        view.addSubview(tableView)
        view.addSubview(spinner)
        view.addSubview(emptyLabel)

        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Spacing.xs),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),

            searchBar.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: Spacing.xxs),
            searchBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.sm),
            searchBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.sm),

            tableView.topAnchor.constraint(equalTo: searchBar.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),

            emptyLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 30),
            emptyLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            emptyLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
        ])
    }

    private func load() {
        loadGeneration += 1
        let generation = loadGeneration
        if !hasLoaded {
            spinner.startAnimating()
        }
        Task {
            if let currentSettings = try? await repository.settings(workspaceId: workspaceId) {
                guard generation == loadGeneration else { return }
                settings = currentSettings
                if !currentSettings.enabled {
                    hasLoaded = true
                    spinner.stopAnimating()
                    claims = []
                    timeline = []
                    statusUnavailable = true
                    updateStatusLabel()
                    rebuildGroups()
                    return
                }
            }

            do {
                let rows = try await repository.list(workspaceId: workspaceId)
                guard generation == loadGeneration else { return }
                hasLoaded = true
                spinner.stopAnimating()
                claims = rows
                rebuildGroups()
            } catch {
                guard generation == loadGeneration else { return }
                spinner.stopAnimating()
                presentError(error)
                return
            }

            do {
                let currentStatus = try await repository.status(workspaceId: workspaceId)
                guard generation == loadGeneration else { return }
                status = currentStatus
                statusUnavailable = false
                updateStatusLabel()
            } catch {
                guard generation == loadGeneration else { return }
                statusUnavailable = true
                updateStatusLabel()
            }

            if let currentSettings = try? await repository.settings(workspaceId: workspaceId) {
                guard generation == loadGeneration else { return }
                settings = currentSettings
                updateStatusLabel()
            }
            if let items = try? await repository.timeline(workspaceId: workspaceId) {
                guard generation == loadGeneration else { return }
                timeline = items
                UIView.performWithoutAnimation { tableView.reloadData() }
            }
            if let items = try? await repository.disputes(workspaceId: workspaceId) {
                guard generation == loadGeneration else { return }
                disputes = items
                UIView.performWithoutAnimation { tableView.reloadData() }
            }
            if let items = try? await repository.duplicates(workspaceId: workspaceId) {
                guard generation == loadGeneration else { return }
                duplicates = items
                UIView.performWithoutAnimation { tableView.reloadData() }
            }
            if let items = try? await repository.entities(workspaceId: workspaceId) {
                guard generation == loadGeneration else { return }
                entities = items
                rebuildGroups()
            }
        }
    }

    private func updateStatusLabel() {
        let base: String
        if settings?.enabled == false {
            base = "记忆未启用；请在桌面端启用后使用。"
        } else if statusUnavailable {
            base = "记忆状态暂不可用；列表仍可正常浏览。"
        } else {
            let pending = status?.pendingSources ?? 0
            if let model = status?.extractionModel, !model.isEmpty {
                base = status?.modelAvailable == true
                    ? "自动整理（\(model)）· \(pending) 条待整理"
                    : "记忆模型配置不可用（\(model)）：请检查 Provider 的 Key、启用状态和模型目录。"
            } else {
                base = "仅记录，未整理：在桌面设置 → 模型 Provider 里勾选「用于记忆」后会自动补齐。"
            }
        }
        statusLabel.text = base + settingsSummary()
    }

    /// Read-only view of the workspace switches; desktop owns the edits.
    private func settingsSummary() -> String {
        guard let settings, settings.enabled else { return "" }
        var parts = ["记忆已启用"]
        if settings.enabled {
            parts.append(settings.injectionEnabled ? "注入开" : "只记录")
            if let profile = settings.profileMode { parts.append("画像 \(profile)") }
            if let readable = settings.lifeReadable {
                parts.append(readable ? "生活可读" : "生活不可读")
            }
        }
        return "\n" + parts.joined(separator: " · ")
    }

    private func rebuildGroups() {
        groups = groupedMemory(claims, query: query)
        emptyLabel.isHidden =
            !groups.isEmpty || showsTimeline || showsDisputes || showsDuplicates || showsEntities
        emptyLabel.text = query.isEmpty
            ? (family == "life"
                ? "还没有记忆。在「生活」里正常聊天即可，消息会在后台整理。"
                : "还没有记忆。先在桌面端启用这个工作区的记忆，再正常聊天。")
            : "没有匹配的记忆。"
        UIView.performWithoutAnimation { tableView.reloadData() }
    }

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        query = searchText
        rebuildGroups()
    }

    private var showsTimeline: Bool { !timeline.isEmpty }
    private var showsDisputes: Bool { !disputes.isEmpty }
    private var showsDuplicates: Bool { !duplicates.isEmpty }
    private var showsEntities: Bool { !entities.isEmpty }
    private var fixedSections: Int {
        (showsTimeline ? 1 : 0) + (showsDisputes ? 1 : 0) +
            (showsDuplicates ? 1 : 0) + (showsEntities ? 1 : 0)
    }
    private var disputesSection: Int? {
        guard showsDisputes else { return nil }
        return showsTimeline ? 1 : 0
    }
    private var duplicatesSection: Int? {
        guard showsDuplicates else { return nil }
        return (showsTimeline ? 1 : 0) + (showsDisputes ? 1 : 0)
    }
    private var entitiesSection: Int? {
        guard showsEntities else { return nil }
        return (showsTimeline ? 1 : 0) + (showsDisputes ? 1 : 0) + (showsDuplicates ? 1 : 0)
    }

    private func groupIndex(for section: Int) -> Int {
        section - fixedSections
    }

    func numberOfSections(in tableView: UITableView) -> Int {
        groups.count + fixedSections
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        if showsTimeline && section == 0 { return "最近工作（只读）" }
        if let disputesSection, section == disputesSection {
            return "待裁决（只读，共 \(disputes.count)）"
        }
        if let duplicatesSection, section == duplicatesSection {
            return "重复候选（只读，共 \(duplicates.count)）"
        }
        if let entitiesSection, section == entitiesSection {
            return "实体（只读，共 \(entities.count)）"
        }
        let group = groups[groupIndex(for: section)]
        return "\(group.label)（\(group.claims.count)）"
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        if showsTimeline && section == 0 { return timeline.count }
        if let disputesSection, section == disputesSection { return disputes.count }
        if let duplicatesSection, section == duplicatesSection { return duplicates.count }
        if let entitiesSection, section == entitiesSection { return entities.count }
        return groups[groupIndex(for: section)].claims.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        if showsTimeline && indexPath.section == 0 {
            let item = timeline[indexPath.row]
            let cell = tableView.dequeueReusableCell(withIdentifier: "memory-timeline")
                ?? UITableViewCell(style: .subtitle, reuseIdentifier: "memory-timeline")
            cell.textLabel?.text = item.title
            cell.textLabel?.numberOfLines = 2
            cell.textLabel?.font = Typography.body
            cell.textLabel?.textColor = Theme.Colors.textPrimary
            let sessionHint = item.sessionId.map {
                " · 会话 \(String($0.replacingOccurrences(of: "-", with: "").prefix(4)))"
            } ?? ""
            cell.detailTextLabel?.text =
                "\(item.kind == "summary" ? "摘要" : "观察") · \(memoryDateLabel(item.at))" +
                sessionHint +
                (item.files.isEmpty ? "" : " · \(item.files.count) 个文件")
            cell.detailTextLabel?.font = Typography.caption
            cell.detailTextLabel?.textColor = Theme.Colors.textSecondary
            cell.accessoryType = .none
            cell.backgroundColor = Theme.Colors.surface
            return cell
        }
        if let disputesSection, indexPath.section == disputesSection {
            let item = disputes[indexPath.row]
            let cell = tableView.dequeueReusableCell(withIdentifier: "memory-dispute")
                ?? UITableViewCell(style: .subtitle, reuseIdentifier: "memory-dispute")
            cell.textLabel?.text = "新：\(item.newClaim.summary)"
            cell.textLabel?.numberOfLines = 2
            cell.textLabel?.font = Typography.body
            cell.textLabel?.textColor = Theme.Colors.textPrimary
            cell.detailTextLabel?.text =
                "旧：\(item.oldClaim.summary) · \(item.predicate) · 请在桌面端裁决"
            cell.detailTextLabel?.font = Typography.caption
            cell.detailTextLabel?.textColor = Theme.Colors.textSecondary
            cell.accessoryType = .none
            cell.backgroundColor = Theme.Colors.surface
            return cell
        }
        if let duplicatesSection, indexPath.section == duplicatesSection {
            let item = duplicates[indexPath.row]
            let cell = tableView.dequeueReusableCell(withIdentifier: "memory-duplicate")
                ?? UITableViewCell(style: .subtitle, reuseIdentifier: "memory-duplicate")
            cell.textLabel?.text = item.claimSummary
            cell.textLabel?.numberOfLines = 2
            cell.textLabel?.font = Typography.body
            cell.textLabel?.textColor = Theme.Colors.textPrimary
            cell.detailTextLabel?.text =
                "与「\(item.duplicateSummary)」相似 \(Int((item.score * 100).rounded()))%" +
                " · 请在桌面端合并或忽略"
            cell.detailTextLabel?.font = Typography.caption
            cell.detailTextLabel?.textColor = Theme.Colors.textSecondary
            cell.accessoryType = .none
            cell.backgroundColor = Theme.Colors.surface
            return cell
        }
        if let entitiesSection, indexPath.section == entitiesSection {
            let item = entities[indexPath.row]
            let cell = tableView.dequeueReusableCell(withIdentifier: "memory-entity")
                ?? UITableViewCell(style: .subtitle, reuseIdentifier: "memory-entity")
            cell.textLabel?.text = item.canonicalName
            cell.textLabel?.numberOfLines = 1
            cell.textLabel?.font = Typography.body
            cell.textLabel?.textColor = Theme.Colors.textPrimary
            let aliasLabel = item.aliases.isEmpty ? "" : "\(item.aliases.count) 个别名 · "
            cell.detailTextLabel?.text =
                "\(entityKindLabel(item.kind)) · \(aliasLabel)\(item.claimCount) 条记忆" +
                " · 合并请在桌面端处理"
            cell.detailTextLabel?.font = Typography.caption
            cell.detailTextLabel?.textColor = Theme.Colors.textSecondary
            cell.accessoryType = .none
            cell.backgroundColor = Theme.Colors.surface
            return cell
        }
        let claim = groups[groupIndex(for: indexPath.section)].claims[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "memory-row")
            ?? UITableViewCell(style: .subtitle, reuseIdentifier: "memory-row")
        cell.textLabel?.text = claim.summary
        cell.textLabel?.numberOfLines = 2
        cell.textLabel?.font = Typography.body
        cell.textLabel?.textColor = Theme.Colors.textPrimary
        let privateLabel = claim.sensitivity == "private" ? " · 私密" : ""
        cell.detailTextLabel?.text =
            "\(memoryAuthorityLabel(claim))\(privateLabel) · #\(shortClaimId(claim.id)) · \(memoryDateLabel(claim.updatedAt))"
        cell.detailTextLabel?.font = Typography.caption
        cell.detailTextLabel?.textColor = Theme.Colors.textSecondary
        cell.accessoryType = .disclosureIndicator
        cell.backgroundColor = Theme.Colors.surface
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if indexPath.section < fixedSections { return }
        let claim = groups[groupIndex(for: indexPath.section)].claims[indexPath.row]
        let detail = MemoryDetailViewController(
            claim: claim,
            repository: repository,
            workspaceId: workspaceId,
            workspaceName: workspaceName
        ) { [weak self] in
            self?.load()
        }
        navigationController?.pushViewController(detail, animated: true)
    }

    private func presentError(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        let alert = UIAlertController(title: "操作失败", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}

/// Detail page: full source quotes, confidence and the only place with edit/forget.
private final class MemoryDetailViewController: UIViewController {
    private let repository: MemoryRepository
    private let workspaceId: String
    private let workspaceName: String
    private var claim: MemoryClaimDto
    private let onChanged: () -> Void

    private let scrollView = UIScrollView()
    private let stack = UIStackView()

    init(
        claim: MemoryClaimDto,
        repository: MemoryRepository,
        workspaceId: String,
        workspaceName: String,
        onChanged: @escaping () -> Void
    ) {
        self.claim = claim
        self.repository = repository
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.onChanged = onChanged
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "记忆详情"
        view.backgroundColor = Theme.Colors.background
        configureLayout()
        render()
    }

    private func configureLayout() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.md),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.xl),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -Spacing.lg * 2),
        ])
    }

    private func render() {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        let badge = UILabel()
        let privateLabel = claim.sensitivity == "private" ? " · 私密" : ""
        badge.text =
            "\(memoryKindLabel(claim.kind)) · \(memoryAuthorityLabel(claim))\(privateLabel) · #claim_\(shortClaimId(claim.id))"
        badge.font = Typography.caption
        badge.textColor = Theme.Colors.textSecondary
        stack.addArrangedSubview(badge)

        let titleLabel = UILabel()
        titleLabel.text = claim.summary
        titleLabel.font = Typography.pageTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.numberOfLines = 0
        stack.addArrangedSubview(titleLabel)

        if let object = claim.objectText, object != claim.summary {
            let objectLabel = UILabel()
            objectLabel.text = object
            objectLabel.font = Typography.body
            objectLabel.textColor = Theme.Colors.textSecondary
            objectLabel.numberOfLines = 0
            stack.addArrangedSubview(objectLabel)
        }

        let meta = UILabel()
        meta.text =
            "置信度 \(Int((claim.confidence * 100).rounded()))% · 更新 \(memoryDateLabel(claim.updatedAt)) · 生效 \(memoryValidityLabel(claim))"
        meta.font = Typography.caption
        meta.textColor = Theme.Colors.textMuted
        stack.addArrangedSubview(meta)

        let sourceTitle = UILabel()
        sourceTitle.text = "来源原话"
        sourceTitle.font = Typography.caption
        sourceTitle.textColor = Theme.Colors.textSecondary
        stack.addArrangedSubview(sourceTitle)

        if claim.evidence.isEmpty {
            let empty = UILabel()
            empty.text = "这条记忆没有可展示的来源。"
            empty.font = Typography.caption
            empty.textColor = Theme.Colors.textSecondary
            empty.numberOfLines = 0
            stack.addArrangedSubview(empty)
        } else {
            for item in claim.evidence {
                let quote = UILabel()
                // Keep the fallback out of the interpolation: a nested string
                // literal there terminates the outer one in the Swift lexer.
                let quoted = item.quote ?? "（无原话）"
                quote.text = "“\(quoted)”"
                quote.font = Typography.body
                quote.textColor = Theme.Colors.textSecondary
                quote.numberOfLines = 0
                quote.backgroundColor = Theme.Colors.surface
                quote.layer.cornerRadius = Radius.card / 2
                quote.layer.masksToBounds = true
                quote.setContentHuggingPriority(.required, for: .vertical)
                let padded = UIView()
                padded.backgroundColor = Theme.Colors.surface
                padded.layer.cornerRadius = Radius.card / 2
                quote.translatesAutoresizingMaskIntoConstraints = false
                padded.addSubview(quote)
                NSLayoutConstraint.activate([
                    quote.topAnchor.constraint(equalTo: padded.topAnchor, constant: Spacing.xs),
                    quote.bottomAnchor.constraint(equalTo: padded.bottomAnchor, constant: -Spacing.xs),
                    quote.leadingAnchor.constraint(equalTo: padded.leadingAnchor, constant: Spacing.sm),
                    quote.trailingAnchor.constraint(equalTo: padded.trailingAnchor, constant: -Spacing.sm),
                ])
                stack.addArrangedSubview(padded)
            }
        }

        let actions = UIStackView()
        actions.axis = .horizontal
        actions.spacing = Spacing.sm
        let edit = UIButton(type: .system)
        edit.setTitle("改正", for: .normal)
        edit.titleLabel?.font = Typography.body
        edit.addTarget(self, action: #selector(startEdit), for: .touchUpInside)
        let forget = UIButton(type: .system)
        forget.setTitle("忘记", for: .normal)
        forget.titleLabel?.font = Typography.body
        forget.tintColor = Theme.Colors.error
        forget.addTarget(self, action: #selector(confirmForget), for: .touchUpInside)
        actions.addArrangedSubview(edit)
        actions.addArrangedSubview(forget)
        actions.addArrangedSubview(UIView())
        stack.addArrangedSubview(actions)
    }

    @objc private func startEdit() {
        let alert = UIAlertController(
            title: "改正记忆",
            message: "改正后标记为「你已确认」，自动抽取不会覆盖。",
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.text = self.claim.summary
            field.placeholder = "摘要"
        }
        alert.addTextField { field in
            field.text = self.claim.objectText
            field.placeholder = "内容"
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "保存改正", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let summary = alert?.textFields?.first?.text ?? ""
            let object = alert?.textFields?.last?.text ?? ""
            Task {
                do {
                    self.claim = try await self.repository.correct(
                        workspaceId: self.workspaceId,
                        id: self.claim.id,
                        summary: summary,
                        objectText: object
                    )
                    self.onChanged()
                    self.render()
                } catch {
                    self.presentError(error)
                }
            }
        })
        present(alert, animated: true)
    }

    @objc private func confirmForget() {
        let alert = UIAlertController(
            title: "忘记这条记忆？",
            message: "会删除这条记忆，并阻止后续从相同原话重新抽取。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "确认忘记", style: .destructive) { [weak self] _ in
            guard let self else { return }
            Task {
                do {
                    try await self.repository.forget(workspaceId: self.workspaceId, id: self.claim.id)
                    self.onChanged()
                    self.navigationController?.popViewController(animated: true)
                } catch {
                    self.presentError(error)
                }
            }
        })
        present(alert, animated: true)
    }

    private func presentError(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        let alert = UIAlertController(title: "操作失败", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}
