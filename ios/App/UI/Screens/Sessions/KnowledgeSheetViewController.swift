import PabootProtocol
import UIKit

private func knowledgeVerificationLabel(_ doc: KnowledgeDocDto) -> String {
    if doc.reviewStatus == "missing" { return "文件缺失" }
    return doc.authority == "curated" ? "已核验" : "未核验"
}

private func knowledgeKindLabel(_ kind: String) -> String {
    switch kind {
    case "workspace_context": return "工作区总览"
    case "convention": return "规范"
    case "requirement": return "需求"
    case "tech_doc": return "技术文档"
    case "adr": return "ADR"
    case "decision": return "决策"
    case "gotcha": return "踩坑"
    case "contract": return "契约"
    case "runbook": return "Runbook"
    case "note": return "笔记"
    default: return kind
    }
}

/// K0 knowledge list (auto-collected; iOS only toggles the human-verification marker).
final class KnowledgeListViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let repository = KnowledgeRepository()
    private let workspaceId: String
    private let workspaceName: String

    private let filterControl = UISegmentedControl(items: ["全部", "未核验", "已核验", "缺失"])
    private let searchBar = UISearchBar()
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let emptyLabel = UILabel()

    private var documents: [KnowledgeDocDto] = []
    private var filterVerified: Bool?
    private var filterStatus: String?
    private var query = ""
    private var hasLoaded = false
    private var loadGeneration = 0

    init(workspaceId: String, workspaceName: String) {
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "知识"
        view.backgroundColor = Theme.Colors.background
        configureLayout()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    private func configureLayout() {
        filterControl.selectedSegmentIndex = 0
        filterControl.addTarget(self, action: #selector(filterChanged), for: .valueChanged)

        searchBar.placeholder = "搜索标题、摘要、标签、正文"
        searchBar.delegate = self
        searchBar.searchBarStyle = .minimal

        tableView.dataSource = self
        tableView.delegate = self
        tableView.backgroundColor = Theme.Colors.background
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 76

        let header = UIStackView(arrangedSubviews: [filterControl, searchBar])
        header.axis = .vertical
        header.spacing = Spacing.xs
        header.translatesAutoresizingMaskIntoConstraints = false

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.isHidden = true
        emptyLabel.numberOfLines = 0
        emptyLabel.textAlignment = .center
        emptyLabel.font = Typography.caption
        emptyLabel.textColor = Theme.Colors.textSecondary

        view.addSubview(header)
        view.addSubview(tableView)
        view.addSubview(spinner)
        view.addSubview(emptyLabel)
        tableView.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Spacing.sm),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),

            tableView.topAnchor.constraint(equalTo: header.bottomAnchor, constant: Spacing.xs),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),

            emptyLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            emptyLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            emptyLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
        ])
    }

    @objc private func filterChanged() {
        switch filterControl.selectedSegmentIndex {
        case 1:
            filterVerified = false
            filterStatus = nil
        case 2:
            filterVerified = true
            filterStatus = nil
        case 3:
            filterVerified = nil
            filterStatus = "missing"
        default:
            filterVerified = nil
            filterStatus = nil
        }
        load()
    }

    @objc private func load() {
        // Keep the current rows/empty state on tab or search refresh. Only the
        // first load uses the centered spinner; later requests swap rows once
        // the response lands, so the list does not blink through a spinner.
        loadGeneration += 1
        let generation = loadGeneration
        if !hasLoaded {
            spinner.startAnimating()
        }
        Task {
            do {
                let docs = try await repository.list(
                    workspaceId: workspaceId,
                    status: filterStatus,
                    verified: filterVerified,
                    query: query.isEmpty ? nil : query
                )
                guard generation == loadGeneration else { return }
                hasLoaded = true
                if docs != documents {
                    documents = docs
                    UIView.performWithoutAnimation { tableView.reloadData() }
                }
                emptyLabel.text = "没有匹配的知识文档。\n放到知识目录的文件会自动收录，并标注核验状态。"
                emptyLabel.isHidden = !docs.isEmpty
            } catch {
                guard generation == loadGeneration else { return }
                hasLoaded = true
                presentError(error)
            }
            if generation == loadGeneration {
                spinner.stopAnimating()
            }
        }
    }

    private func presentError(_ error: Error) {
        let alert = UIAlertController(
            title: "加载失败",
            message: error.localizedDescription,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        documents.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "knowledge")
            ?? UITableViewCell(style: .subtitle, reuseIdentifier: "knowledge")
        let doc = documents[indexPath.row]
        cell.textLabel?.text = doc.title
        cell.textLabel?.font = Typography.body
        cell.textLabel?.textColor = Theme.Colors.textPrimary

        let meta: [String] = [
            knowledgeVerificationLabel(doc),
            knowledgeKindLabel(doc.kind),
            doc.endId,
            doc.path,
        ].compactMap { $0 }
        cell.detailTextLabel?.text = meta.joined(separator: " · ")
        cell.detailTextLabel?.font = Typography.caption
        cell.detailTextLabel?.textColor = doc.reviewStatus == "missing"
            ? Theme.Colors.error
            : doc.authority == "curated" ? Theme.Colors.primary : Theme.Colors.warning
        cell.detailTextLabel?.numberOfLines = 2
        cell.accessoryType = .disclosureIndicator
        cell.backgroundColor = Theme.Colors.surface
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let doc = documents[indexPath.row]
        let detail = KnowledgeDetailViewController(workspaceId: workspaceId, documentId: doc.id)
        navigationController?.pushViewController(detail, animated: true)
    }
}

extension KnowledgeListViewController: UISearchBarDelegate {
    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(load), object: nil)
        perform(#selector(load), with: nil, afterDelay: 0.3)
    }

    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
        searchBar.resignFirstResponder()
        load()
    }
}

/// Detail + verification toggle. The body is read-only here; desktop owns editing.
final class KnowledgeDetailViewController: UIViewController {
    private let repository = KnowledgeRepository()
    private let workspaceId: String
    private let documentId: String

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var detail: KnowledgeDocDetailDto?

    init(workspaceId: String, documentId: String) {
        self.workspaceId = workspaceId
        self.documentId = documentId
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "知识详情"
        view.backgroundColor = Theme.Colors.background
        configureLayout()
        load()
    }

    private func configureLayout() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.spacing = Spacing.sm
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(scrollView)
        view.addSubview(spinner)
        scrollView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.lg),
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

            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func load() {
        spinner.startAnimating()
        Task {
            do {
                detail = try await repository.detail(workspaceId: workspaceId, id: documentId)
                rebuild()
            } catch {
                presentError(error)
            }
            spinner.stopAnimating()
        }
    }

    private func rebuild() {
        contentStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let detail else { return }
        let doc = detail.doc

        let titleLabel = UILabel()
        titleLabel.text = doc.title
        titleLabel.font = Typography.cardTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.numberOfLines = 0
        contentStack.addArrangedSubview(titleLabel)

        let meta = UILabel()
        meta.text = [
            knowledgeVerificationLabel(doc),
            knowledgeKindLabel(doc.kind),
            doc.endId,
            doc.path,
        ].compactMap { $0 }.joined(separator: " · ")
        meta.font = Typography.caption
        meta.textColor = doc.reviewStatus == "missing"
            ? Theme.Colors.error
            : doc.authority == "curated" ? Theme.Colors.primary : Theme.Colors.warning
        meta.numberOfLines = 0
        contentStack.addArrangedSubview(meta)

        if doc.reviewStatus != "missing" && doc.authority != "curated" {
            let warning = UILabel()
            warning.text = "未核验：这条知识是自动收录的，会被注入但会带「未核验」标记；看完可以标记核验。"
            warning.font = Typography.caption
            warning.textColor = Theme.Colors.warning
            warning.numberOfLines = 0
            contentStack.addArrangedSubview(warning)
        }

        let body = UILabel()
        body.text = detail.body.isEmpty ? "（正文为空）" : detail.body
        body.font = Typography.code
        body.textColor = Theme.Colors.textPrimary
        body.numberOfLines = 0
        contentStack.addArrangedSubview(body)

        if doc.reviewStatus != "missing" {
            let actions = UIStackView()
            actions.axis = .horizontal
            actions.spacing = Spacing.sm
            let toggle = UIButton(type: .system)
            toggle.setTitle(doc.authority == "curated" ? "取消核验" : "标记已核验", for: .normal)
            toggle.addTarget(self, action: #selector(verifyTapped), for: .touchUpInside)
            actions.addArrangedSubview(toggle)
            contentStack.addArrangedSubview(actions)
        }

        let hint = UILabel()
        hint.text = "知识只对新会话重新收集指针；已注入文档的正文更新在 agent 读取路径时自然生效。"
        hint.font = Typography.caption
        hint.textColor = Theme.Colors.textMuted
        hint.numberOfLines = 0
        contentStack.addArrangedSubview(hint)
    }

    @objc private func verifyTapped() {
        setVerified(detail?.doc.authority != "curated")
    }

    private func setVerified(_ verified: Bool) {
        Task {
            do {
                _ = try await repository.setVerified(
                    workspaceId: workspaceId,
                    id: documentId,
                    verified: verified
                )
                load()
            } catch {
                presentError(error)
            }
        }
    }

    private func presentError(_ error: Error) {
        let alert = UIAlertController(
            title: "操作失败",
            message: error.localizedDescription,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}
