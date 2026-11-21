import Combine
import PabootProtocol
import UIKit

/// 会话的「助手」面板。
///
/// 房间里有哪些助手、谁现在能用、谁已经有自己的对话，以及拉人进来 / 移出去 /
/// 重置某个人的对话。
///
/// 两样东西刻意不显示：
///   - **谁是主答**：对用户不可感知。新建会话时选的那个就是它，不需要一个标签，
///     也不需要在这里换；
///   - 机制字段（权限上限 / 只读 / 工具白名单）：那是 agent 编辑页的事，混进成员
///     列表只会让人以为是房间级设置。
final class AssistantSheetViewController: UIViewController {
    private let viewModel: ChatViewModel
    private var cancellables = Set<AnyCancellable>()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let headerLabel = UILabel()
    private let membersStack = UIStackView()
    private let addButton = UIButton(type: .system)

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

        title = "助手"
        view.backgroundColor = Theme.Colors.background
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "完成",
            style: .done,
            target: self,
            action: #selector(close)
        )

        configureViews()
        configureLayout()
        bind()
        viewModel.loadSessionAgents()
        viewModel.refreshWorkspaceAgents()
    }

    private func configureViews() {
        headerLabel.font = Typography.caption
        headerLabel.textColor = Theme.Colors.textSecondary
        headerLabel.numberOfLines = 0

        membersStack.axis = .vertical
        membersStack.spacing = Spacing.sm

        addButton.setTitle("添加助手", for: .normal)
        addButton.titleLabel?.font = Typography.body
        addButton.setTitleColor(Theme.Colors.primary, for: .normal)
        addButton.contentHorizontalAlignment = .leading
        addButton.showsMenuAsPrimaryAction = true
    }

    private func configureLayout() {
        contentStack.axis = .vertical
        contentStack.spacing = Spacing.md
        contentStack.addArrangedSubview(headerLabel)
        contentStack.addArrangedSubview(membersStack)
        contentStack.addArrangedSubview(addButton)

        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)
        view.addSubview(scrollView)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.lg),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.lg),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -Spacing.lg * 2),
        ])
    }

    private func bind() {
        viewModel.$state
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.render() }
            .store(in: &cancellables)
    }

    private func render() {
        let state = viewModel.state
        headerLabel.text = "\(state.sessionAgents.count) 个助手"

        membersStack.arrangedSubviews.forEach { view in
            membersStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for agent in state.sessionAgents {
            membersStack.addArrangedSubview(makeMemberRow(agent))
        }

        // 只在有可选成员时显示添加按钮：一个点了没反应的动作比没有更糟。
        let addable = state.workspaceAgents.filter { candidate in
            !state.sessionAgents.contains { $0.id == candidate.id }
        }
        addButton.isHidden = addable.isEmpty
        addButton.setTitle("添加助手（\(addable.count) 个可选）", for: .normal)
        addButton.menu = UIMenu(
            title: "添加助手",
            children: addable.map { candidate in
                UIAction(
                    title: "\(candidate.name) · \(candidate.summary)",
                    // 不可用的仍列出来但置灰：直接不显示会让人以为它被删了。
                    attributes: candidate.available ? [] : .disabled
                ) { [weak self] _ in
                    self?.viewModel.addSessionAgent(candidate.id)
                }
            }
        )
    }

    private func makeMemberRow(_ agent: SessionAgentDto) -> UIView {
        let card = UIView()
        card.backgroundColor = Theme.Colors.surface
        card.layer.cornerRadius = Radius.card

        let dot = UIView()
        dot.backgroundColor = dotColor(for: agent)
        dot.layer.cornerRadius = 5
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 10).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 10).isActive = true

        let nameLabel = UILabel()
        nameLabel.font = Typography.body
        nameLabel.textColor = Theme.Colors.textPrimary
        nameLabel.text = agent.heavy ? "\(agent.name) · 外部 CLI" : agent.name

        let summaryLabel = UILabel()
        summaryLabel.font = Typography.caption
        summaryLabel.textColor = Theme.Colors.textSecondary
        summaryLabel.numberOfLines = 2
        // 不可用要说清原因，否则用户只会看到「它不说话」。
        if !agent.available {
            summaryLabel.text = agent.enabled ? "当前离线" : "已停用"
            summaryLabel.textColor = Theme.Colors.error
        } else {
            summaryLabel.text = agent.summary.isEmpty ? agent.backend : agent.summary
        }

        let textStack = UIStackView(arrangedSubviews: [nameLabel, summaryLabel])
        textStack.axis = .vertical
        textStack.spacing = 2

        let header = UIStackView(arrangedSubviews: [dot, textStack])
        header.axis = .horizontal
        header.spacing = Spacing.sm
        header.alignment = .top

        let actions = UIStackView()
        actions.axis = .horizontal
        actions.spacing = Spacing.sm
        if agent.hasContext {
            actions.addArrangedSubview(actionButton("重置对话") { [weak self] in
                self?.confirmReset(agent)
            })
        }
        // 主答移不掉（daemon 会 409）：它是这个会话的归属者，而 UI 没有「换主答」的
        // 入口 —— 那是刻意的，对用户不可感知。
        actions.addArrangedSubview(actionButton("移出") { [weak self] in
            self?.viewModel.removeSessionAgent(agent.id)
        })

        let stack = UIStackView(arrangedSubviews: [header, actions])
        stack.axis = .vertical
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.sm),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.sm),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.sm),
        ])
        return card
    }

    private func actionButton(_ title: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = Typography.caption
        button.setTitleColor(Theme.Colors.primary, for: .normal)
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    /// 重置对话框：文案必须说清清得掉什么、清不掉什么，否则就是假承诺。
    private func confirmReset(_ agent: SessionAgentDto) {
        let alert = UIAlertController(
            title: "重置「\(agent.name)」的对话？",
            message: "它的历史记录会保留，但下一次发言会从新对话开始。\n\n"
                + "这不会清掉 runtime 自己保存的记忆（例如 Claude 的项目记忆）—— 那部分不归 paboot 管。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "重置", style: .destructive) { [weak self] _ in
            self?.viewModel.resetAgentContext(agent.id)
        })
        present(alert, animated: true)
    }

    /// 稳定散布色：同一个 agent 在任何界面都是同一个颜色。用 id 而不是名字，
    /// 改名不该换颜色，否则用户会以为那是另一个助手。
    private func dotColor(for agent: SessionAgentDto) -> UIColor {
        if !agent.available { return Theme.Colors.textSecondary }
        let palette: [UIColor] = [
            UIColor(red: 0.36, green: 0.55, blue: 0.94, alpha: 1),
            UIColor(red: 0.08, green: 0.72, blue: 0.65, alpha: 1),
            UIColor(red: 0.96, green: 0.62, blue: 0.04, alpha: 1),
            UIColor(red: 0.93, green: 0.28, blue: 0.59, alpha: 1),
            UIColor(red: 0.55, green: 0.36, blue: 0.96, alpha: 1),
        ]
        let hash = agent.id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7FFF_FFFF }
        return palette[hash % palette.count]
    }

    @objc private func close() {
        dismiss(animated: true)
    }
}
