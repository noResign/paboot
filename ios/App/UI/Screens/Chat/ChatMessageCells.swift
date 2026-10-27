import Foundation
import PabootMarkdownUI
import PabootProtocol
import UIKit

// MARK: - User

final class UserMessageCell: UITableViewCell {
    static let reuseIdentifier = "UserMessageCell"

    private let bubble = UIView()
    private let label = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        selectionStyle = .none
        backgroundColor = .clear
        contentView.backgroundColor = .clear

        bubble.backgroundColor = Theme.Colors.primary
        bubble.layer.cornerRadius = Radius.bubble
        bubble.translatesAutoresizingMaskIntoConstraints = false

        label.numberOfLines = 0
        label.font = Typography.body
        label.textColor = Theme.Colors.onPrimary
        label.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(label)
        contentView.addSubview(bubble)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 9),
            label.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -9),
            label.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 13),
            label.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -13),

            bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
            bubble.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 56),
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: Spacing.xs),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -Spacing.xs),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(text: String) {
        label.text = text
    }
}

// MARK: - Assistant

enum AssistantRenderItem {
    case block(ContentBlock)
    case tools([ToolUseBlock])
}

final class AssistantMessageCell: UITableViewCell {
    static let reuseIdentifier = "AssistantMessageCell"

    private let stack = UIStackView()
    private let blockStack = UIStackView()
    private let loadingLabel = UILabel()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingRow = UIStackView()
    private let footerLabel = UILabel()

    private var itemViews: [ChatBlockView] = []
    private var itemKinds: [String] = []
    private var onAnswer: ((String, String) -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        selectionStyle = .none
        backgroundColor = .clear
        contentView.backgroundColor = .clear

        blockStack.axis = .vertical
        blockStack.spacing = 10

        loadingLabel.text = "正在生成…"
        loadingLabel.font = Typography.caption
        loadingLabel.textColor = Theme.Colors.textMuted
        // DeepSeek Harness emits its reasoning only after the server-side turn
        // finishes; this spinner is the only "working" signal during that wait.
        loadingSpinner.transform = CGAffineTransform(scaleX: 0.65, y: 0.65)
        loadingSpinner.color = Theme.Colors.thinking
        loadingRow.axis = .horizontal
        loadingRow.alignment = .center
        loadingRow.spacing = 6
        loadingRow.addArrangedSubview(loadingSpinner)
        loadingRow.addArrangedSubview(loadingLabel)
        loadingRow.isHidden = true

        footerLabel.font = Typography.caption
        footerLabel.numberOfLines = 0
        footerLabel.isHidden = true

        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(blockStack)
        stack.addArrangedSubview(loadingRow)
        stack.addArrangedSubview(footerLabel)
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: Spacing.xs),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -Spacing.sm),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        blockStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        itemViews = []
        itemKinds = []
        loadingRow.isHidden = true
        loadingSpinner.stopAnimating()
        footerLabel.isHidden = true
    }

    func configure(
        message: ChatUiMessage,
        streaming: Bool,
        onAnswer: @escaping (String, String) -> Void
    ) {
        self.onAnswer = onAnswer

        let items = Self.renderItems(message.blocks)
        let kinds = items.map(Self.kind)
        let structureChanged = kinds != itemKinds
        if structureChanged {
            rebuild(items: items)
        }

        for (view, item) in zip(itemViews, items) {
            view.updateItem(item, streaming: streaming)
        }

        let wasLoading = !loadingRow.isHidden
        let showsLoading = message.blocks.isEmpty && !message.done
        loadingRow.isHidden = !showsLoading
        if showsLoading {
            loadingSpinner.startAnimating()
        } else {
            loadingSpinner.stopAnimating()
        }
        let loadingChanged = wasLoading != !loadingRow.isHidden

        let wasFooterHidden = footerLabel.isHidden
        if let error = message.error, !error.isEmpty {
            footerLabel.text = error
            footerLabel.textColor = Theme.Colors.error
            footerLabel.isHidden = false
        } else if let usage = message.usage, let text = Self.usageText(usage) {
            footerLabel.text = text
            footerLabel.textColor = Theme.Colors.textMuted
            footerLabel.isHidden = false
        } else {
            footerLabel.isHidden = true
        }
        let footerChanged = wasFooterHidden != footerLabel.isHidden

        // Adding a block (or revealing the loading/footer line) changes the
        // cell's intrinsic height. A diffable reconfigure updates the cell in
        // place but does not re-query a self-sizing row, so without this the new
        // cards stay clipped inside the previous row height until the transcript
        // is rebuilt.
        if structureChanged || loadingChanged || footerChanged {
            notifyEnclosingTableHeightChanged(animated: false)
        }
    }

    private func rebuild(items: [AssistantRenderItem]) {
        let kinds = items.map(Self.kind)
        var unchangedCount = 0
        for (oldKind, newKind) in zip(itemKinds, kinds) {
            guard oldKind == newKind else { break }
            unchangedCount += 1
        }
        for view in itemViews.dropFirst(unchangedCount) {
            view.removeFromSuperview()
        }
        itemViews = Array(itemViews.prefix(unchangedCount))

        for item in items.dropFirst(unchangedCount) {
            let view: ChatBlockView
            switch item {
            case .tools:
                view = ChatToolGroupView(frame: .zero)
            case .block(.text):
                view = ChatTextBlockView(frame: .zero)
            case .block(.thinking):
                view = ChatThinkingBlockView(frame: .zero)
            case .block(.question):
                let questionView = ChatQuestionCardView(frame: .zero)
                questionView.onSubmit = { [weak self] toolUseId, text in
                    self?.onAnswer?(toolUseId, text)
                }
                view = questionView
            case .block(.tool):
                view = ChatBlockView(frame: .zero)
            }
            itemViews.append(view)
            blockStack.addArrangedSubview(view)
        }
        itemKinds = kinds
    }

    private static func renderItems(_ blocks: [ContentBlock]) -> [AssistantRenderItem] {
        var items: [AssistantRenderItem] = []
        var tools: [ToolUseBlock] = []

        func flushTools() {
            guard !tools.isEmpty else { return }
            items.append(.tools(tools))
            tools.removeAll()
        }

        for block in blocks {
            if case .tool(let tool) = block {
                tools.append(tool)
            } else {
                flushTools()
                items.append(.block(block))
            }
        }
        flushTools()
        return items
    }

    private static func kind(_ item: AssistantRenderItem) -> String {
        switch item {
        case .tools(let tools):
            return "tools:\(tools.first?.id ?? "")"
        case .block(.text):
            return "text"
        case .block(.thinking):
            return "thinking"
        case .block(.question(let question)):
            return "question:\(question.toolUseId)"
        case .block(.tool):
            return "tool"
        }
    }

    private static func usageText(_ usage: UsageInfo) -> String? {
        var parts: [String] = []
        if let input = usage.inputTokens {
            parts.append("输入 \(Formatters.tokens(input))")
        }
        if let output = usage.outputTokens {
            parts.append("输出 \(Formatters.tokens(output))")
        }
        if let cost = usage.costUsd {
            parts.append(String(format: "$%.4f", cost))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Block views

class ChatBlockView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateItem(_ item: AssistantRenderItem, streaming: Bool) {
        guard case .block(let block) = item else { return }
        update(block: block, streaming: streaming)
    }

    func update(block: ContentBlock, streaming: Bool) {}

    func applyCardBorder() {
        layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if layer.borderWidth > 0,
           traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            applyCardBorder()
        }
    }
}

final class ChatTextBlockView: ChatBlockView {
    /// Streaming deltas arrive roughly every 80ms. Re-parsing and re-laying out the
    /// whole Markdown document at that rate reads as flicker, so sample the text:
    /// Android does the same at ~200ms.
    private static let streamingInterval: TimeInterval = 0.2

    private let stack = UIStackView()
    private var displayedText: String?
    private var pendingText: String?
    private var pendingRender: DispatchWorkItem?
    private var lastRenderTime: TimeInterval = 0
    private lazy var documentView: MarkdownUIView = {
        let view = MarkdownUIView(style: Self.markdownStyle())
        view.translatesAutoresizingMaskIntoConstraints = false
        return view
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)

        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func update(block: ContentBlock, streaming: Bool) {
        guard case .text(let text) = block else { return }
        guard text != displayedText else {
            // Already shown; a queued sample is stale.
            pendingText = nil
            pendingRender?.cancel()
            pendingRender = nil
            return
        }
        pendingText = text

        guard streaming else {
            pendingRender?.cancel()
            pendingRender = nil
            renderPendingText()
            return
        }

        let elapsed = Date.timeIntervalSinceReferenceDate - lastRenderTime
        if elapsed >= Self.streamingInterval {
            renderPendingText()
            return
        }
        guard pendingRender == nil else { return }
        let item = DispatchWorkItem { [weak self] in self?.renderPendingText() }
        pendingRender = item
        DispatchQueue.main.asyncAfter(
            deadline: .now() + (Self.streamingInterval - elapsed),
            execute: item
        )
    }

    private func renderPendingText() {
        pendingRender = nil
        guard let text = pendingText, text != displayedText else { return }
        pendingText = nil
        displayedText = text
        lastRenderTime = Date.timeIntervalSinceReferenceDate

        if documentView.superview == nil {
            stack.addArrangedSubview(documentView)
        }
        documentView.update(markdown: text)
        // Re-query the row height, but never animate a streamed sample: that height
        // animation on every tick is what makes the transcript shimmer.
        notifyEnclosingTableHeightChanged(animated: false)
    }

    private static func markdownStyle() -> MarkdownUIStyle {
        MarkdownUIStyle(
            bodyFont: Typography.body,
            headingFonts: [
                UIFontMetrics(forTextStyle: .title1)
                    .scaledFont(for: .systemFont(ofSize: 20, weight: .bold)),
                UIFontMetrics(forTextStyle: .title2)
                    .scaledFont(for: .systemFont(ofSize: 17, weight: .semibold)),
                UIFontMetrics(forTextStyle: .title3)
                    .scaledFont(for: .systemFont(ofSize: 15, weight: .semibold)),
                UIFontMetrics(forTextStyle: .headline)
                    .scaledFont(for: .systemFont(ofSize: 14, weight: .semibold)),
            ],
            codeFont: Typography.code,
            textColor: Theme.Colors.textPrimary,
            secondaryTextColor: Theme.Colors.textSecondary,
            codeBackgroundColor: Theme.Colors.codeBackground,
            surfaceColor: Theme.Colors.surface2,
            borderColor: Theme.Colors.border,
            accentColor: Theme.Colors.primary,
            codeKeywordColor: Theme.Colors.primary,
            codeStringColor: Theme.Colors.success,
            codeNumberColor: Theme.Colors.warning,
            codeCommentColor: Theme.Colors.textMuted
        )
    }

    deinit {
        pendingRender?.cancel()
    }
}

/// Thinking marker. The reasoning text is never sent, so the card is a plain,
/// non-interactive status row whose spinner is the proof the model is working.
final class ChatThinkingBlockView: ChatBlockView {
    private let headerLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var displayedActive: Bool?

    override init(frame: CGRect) {
        super.init(frame: frame)

        backgroundColor = Theme.Colors.surface
        layer.cornerRadius = 8

        spinner.color = Theme.Colors.thinking
        spinner.hidesWhenStopped = true
        spinner.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)

        headerLabel.font = Typography.caption
        headerLabel.textColor = Theme.Colors.thinking

        let stack = UIStackView(arrangedSubviews: [spinner, headerLabel])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
        ])

        updateHeader(active: true)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func update(block: ContentBlock, streaming: Bool) {
        guard case .thinking(let block) = block else { return }
        guard block.active != displayedActive else { return }
        displayedActive = block.active
        if block.active {
            spinner.startAnimating()
        } else {
            spinner.stopAnimating()
        }
        updateHeader(active: block.active)
        // Hiding the spinner changes the header height by a couple of points.
        notifyEnclosingTableHeightChanged(animated: false)
    }

    private func updateHeader(active: Bool) {
        headerLabel.text = active ? "思考中" : "思考"
    }
}

/// Consecutive tool calls fold into one collapsible group.
final class ChatToolGroupView: ChatBlockView {
    private let chevronLabel = UILabel()
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let actionLabel = UILabel()
    private let cardsStack = UIStackView()

    private var tools: [ToolUseBlock] = []
    private var lastTools: [ToolUseBlock]?
    private var cards: [String: ChatToolCardView] = [:]
    private var expanded = false
    var isExpanded: Bool { expanded }

    override init(frame: CGRect) {
        super.init(frame: frame)

        backgroundColor = Theme.Colors.surface
        layer.cornerRadius = Radius.card
        layer.borderWidth = 1
        applyCardBorder()

        chevronLabel.font = Typography.caption
        chevronLabel.textColor = Theme.Colors.textSecondary
        chevronLabel.setContentHuggingPriority(.required, for: .horizontal)
        chevronLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        titleLabel.font = Typography.cardTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.textAlignment = .left
        // Only the title absorbs slack; otherwise the chevron stretches and pushes it right.
        titleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        statusLabel.font = Typography.caption
        statusLabel.textColor = Theme.Colors.textMuted
        statusLabel.setContentHuggingPriority(.required, for: .horizontal)

        actionLabel.font = Typography.caption
        actionLabel.textColor = Theme.Colors.primary
        actionLabel.setContentHuggingPriority(.required, for: .horizontal)

        let header = UIStackView(
            arrangedSubviews: [chevronLabel, titleLabel, statusLabel, actionLabel]
        )
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = 8
        header.isUserInteractionEnabled = true
        header.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(toggle))
        )

        cardsStack.axis = .vertical
        cardsStack.spacing = 8
        cardsStack.isHidden = true

        let stack = UIStackView(arrangedSubviews: [header, cardsStack])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.sm),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.sm),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.sm),
        ])

        updateHeader()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateItem(_ item: AssistantRenderItem, streaming: Bool) {
        guard case .tools(let tools) = item else { return }
        guard lastTools != tools else { return }
        lastTools = tools
        self.tools = tools
        updateHeader()
        updateCards()
    }

    private func updateHeader() {
        chevronLabel.text = expanded ? "▾" : "▸"
        titleLabel.text = Self.describe(tools).title

        let status = Self.describe(tools).status
        statusLabel.text = status
        statusLabel.isHidden = status.isEmpty
        actionLabel.text = expanded ? "收起" : "展开"
    }

    private func updateCards() {
        let incoming = Set(tools.map(\.id))
        for id in Set(cards.keys).subtracting(incoming) {
            cards[id]?.removeFromSuperview()
            cards.removeValue(forKey: id)
        }

        cardsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for tool in tools {
            let card: ChatToolCardView
            if let existing = cards[tool.id] {
                card = existing
            } else {
                card = ChatToolCardView(frame: .zero)
                cards[tool.id] = card
            }
            card.update(tool: tool)
            cardsStack.addArrangedSubview(card)
        }

        cardsStack.isHidden = !expanded
    }

    @objc private func toggle() {
        setExpanded(!expanded)
    }

    func setExpanded(_ value: Bool) {
        guard expanded != value else { return }
        expanded = value
        cardsStack.isHidden = !expanded
        updateHeader()
        notifyEnclosingTableHeightChanged()
    }

    private static func describe(_ tools: [ToolUseBlock]) -> (title: String, status: String) {
        var names: [String] = []
        for tool in tools where !names.contains(tool.name) {
            names.append(tool.name)
        }
        let shown = names.prefix(3).joined(separator: ", ")
        let suffix = names.count > 3 ? "…" : ""
        let title = "\(tools.count) 个工具调用 · \(shown)\(suffix)"

        var parts: [String] = []
        let running = tools.filter(\.running).count
        let failed = tools.filter(\.isError).count
        let interrupted = tools.filter(\.interrupted).count
        if running > 0 { parts.append("\(running) 个运行中") }
        if failed > 0 { parts.append("\(failed) 个失败") }
        if interrupted > 0 { parts.append("\(interrupted) 个中断") }

        return (title, parts.joined(separator: " · "))
    }
}

/// One tool inside a group; collapsed by default.
final class ChatToolCardView: ChatBlockView {
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let statusIcon = UIImageView()
    private let nameLabel = UILabel()
    private let actionLabel = UILabel()
    private let bodyStack = UIStackView()

    private var tool: ToolUseBlock?
    private var lastTool: ToolUseBlock?
    private var expanded = false
    var isExpanded: Bool { expanded }

    override init(frame: CGRect) {
        super.init(frame: frame)

        backgroundColor = Theme.Colors.surface
        layer.cornerRadius = Radius.card
        layer.borderWidth = 1
        applyCardBorder()

        spinner.color = Theme.Colors.textSecondary
        spinner.hidesWhenStopped = true
        spinner.setContentHuggingPriority(.required, for: .horizontal)
        spinner.setContentCompressionResistancePriority(.required, for: .horizontal)
        spinner.translatesAutoresizingMaskIntoConstraints = false

        statusIcon.contentMode = .scaleAspectFit
        statusIcon.setContentHuggingPriority(.required, for: .horizontal)
        statusIcon.setContentCompressionResistancePriority(.required, for: .horizontal)
        statusIcon.translatesAutoresizingMaskIntoConstraints = false
        statusIcon.widthAnchor.constraint(equalToConstant: 16).isActive = true
        statusIcon.heightAnchor.constraint(equalToConstant: 16).isActive = true

        nameLabel.font = Typography.cardTitle
        nameLabel.textColor = Theme.Colors.textPrimary
        nameLabel.numberOfLines = 1
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.textAlignment = .left
        // Android gives the name `weight(1f)`; make it the only view that grows so the
        // icon never pushes the text toward the trailing edge.
        nameLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        actionLabel.font = Typography.caption
        actionLabel.textColor = Theme.Colors.textSecondary
        actionLabel.setContentHuggingPriority(.required, for: .horizontal)

        let header = UIStackView(
            arrangedSubviews: [spinner, statusIcon, nameLabel, actionLabel]
        )
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = 6
        header.isUserInteractionEnabled = true
        header.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(toggle))
        )

        bodyStack.axis = .vertical
        bodyStack.spacing = 8
        bodyStack.isHidden = true

        let stack = UIStackView(arrangedSubviews: [header, bodyStack])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.sm),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.sm),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(tool: ToolUseBlock) {
        guard lastTool != tool else { return }
        lastTool = tool
        self.tool = tool

        nameLabel.text = tool.name

        if tool.running {
            spinner.isHidden = false
            spinner.startAnimating()
            statusIcon.isHidden = true
        } else {
            spinner.stopAnimating()
            spinner.isHidden = true
            statusIcon.isHidden = false
            if tool.interrupted {
                statusIcon.image = UIImage(systemName: "minus.circle")
                statusIcon.tintColor = Theme.Colors.warning
            } else if tool.isError {
                statusIcon.image = UIImage(systemName: "xmark.circle")
                statusIcon.tintColor = Theme.Colors.error
            } else {
                statusIcon.image = UIImage(systemName: "checkmark.circle")
                statusIcon.tintColor = Theme.Colors.success
            }
        }

        actionLabel.text = expanded ? "收起" : "展开"
        rebuildBody()
    }

    @objc private func toggle() {
        setExpanded(!expanded)
    }

    func setExpanded(_ value: Bool) {
        guard expanded != value else { return }
        expanded = value
        rebuildBody()
        notifyEnclosingTableHeightChanged()
    }

    private func rebuildBody() {
        bodyStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        bodyStack.isHidden = !expanded
        guard expanded, let tool else {
            actionLabel.text = expanded ? "收起" : "展开"
            return
        }

        if let input = tool.input {
            bodyStack.addArrangedSubview(
                CodeBlockView(text: Self.jsonText(input), language: "json")
            )
        }

        let result = tool.result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !result.isEmpty {
            bodyStack.addArrangedSubview(
                CodeBlockView(text: result, language: Self.language(for: result))
            )
        } else if tool.interrupted {
            bodyStack.addArrangedSubview(hint("已中断，未返回结果"))
        } else if tool.running {
            bodyStack.addArrangedSubview(hint("等待结果…"))
        }

        actionLabel.text = expanded ? "收起" : "展开"
    }

    private func hint(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        label.numberOfLines = 0
        return label
    }

    private static func jsonText(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }

    private static func language(for text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{") || trimmed.hasPrefix("[") else { return nil }
        guard let data = trimmed.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) != nil else {
            return nil
        }
        return "json"
    }
}

final class ChatQuestionCardView: ChatBlockView {
    var onSubmit: ((String, String) -> Void)?

    private let stack = UIStackView()
    private var toolUseId = ""
    private var questions: [QuestionDto] = []
    private var selections: [Int: Set<String>] = [:]
    private var answered = false
    private var streaming = false

    override init(frame: CGRect) {
        super.init(frame: frame)

        backgroundColor = Theme.Colors.surface2
        layer.cornerRadius = Radius.card

        stack.axis = .vertical
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.sm),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.sm),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.sm),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func update(block: ContentBlock, streaming: Bool) {
        guard case .question(let block) = block else { return }

        // Reconfigures fire on every stream tick; only rebuild the option rows
        // when the card's content or interaction state actually changed.
        guard block.toolUseId != toolUseId
            || block.questions != questions
            || block.answered != answered
            || streaming != self.streaming else {
            return
        }

        self.streaming = streaming

        if block.toolUseId != toolUseId {
            toolUseId = block.toolUseId
            questions = block.questions
            selections.removeAll()
        } else if block.questions != questions {
            questions = block.questions
        }
        answered = block.answered

        render()
        notifyEnclosingTableHeightChanged(animated: false)
    }

    private var allAnswered: Bool {
        !questions.isEmpty && questions.indices.allSatisfy { !(selections[$0] ?? []).isEmpty }
    }

    private func render() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for (index, question) in questions.enumerated() {
            if let header = question.header, !header.isEmpty {
                let headerLabel = UILabel()
                headerLabel.text = header
                headerLabel.font = Typography.caption
                headerLabel.textColor = Theme.Colors.primary
                stack.addArrangedSubview(headerLabel)
            }

            let questionLabel = UILabel()
            questionLabel.text = question.question
            questionLabel.font = Typography.cardTitle
            questionLabel.textColor = Theme.Colors.textPrimary
            questionLabel.numberOfLines = 0
            stack.addArrangedSubview(questionLabel)

            for option in question.options {
                let row = QuestionOptionRow(
                    label: option.label,
                    detail: option.description,
                    selected: selections[index]?.contains(option.label) == true
                )
                row.isEnabled = !answered
                row.onTap = { [weak self] in
                    self?.toggle(
                        index: index,
                        label: option.label,
                        multiSelect: question.multiSelect == true
                    )
                }
                stack.addArrangedSubview(row)
            }
        }

        if answered {
            stack.addArrangedSubview(statusLabel("已发送答案"))
        } else if streaming {
            stack.addArrangedSubview(statusLabel("等待本轮结束…"))
        } else {
            var configuration = UIButton.Configuration.tinted()
            configuration.title = "发送答案"
            configuration.baseForegroundColor = Theme.Colors.primary
            configuration.baseBackgroundColor = Theme.Colors.primary
            configuration.cornerStyle = .medium

            let button = UIButton(configuration: configuration)
            button.isEnabled = allAnswered
            button.addAction(
                UIAction { [weak self] _ in self?.submit() },
                for: .touchUpInside
            )
            stack.addArrangedSubview(button)

            if !allAnswered {
                stack.addArrangedSubview(statusLabel("还有问题未选择"))
            }
        }
    }

    private func statusLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        return label
    }

    private func toggle(index: Int, label: String, multiSelect: Bool) {
        guard !answered else { return }

        var current = selections[index] ?? []
        if multiSelect {
            if current.contains(label) {
                current.remove(label)
            } else {
                current.insert(label)
            }
        } else {
            current = [label]
        }
        selections[index] = current
        render()
    }

    private func submit() {
        guard allAnswered else { return }

        let answer = questions.enumerated().map { index, question in
            let selected = question.options
                .map(\.label)
                .filter { selections[index]?.contains($0) == true }
            return "关于「\(question.question)」，我的选择是：\(selected.joined(separator: "、"))"
        }
        .joined(separator: "\n")

        onSubmit?(toolUseId, answer)
    }
}

private final class QuestionOptionRow: UIControl {
    var onTap: (() -> Void)?

    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()

    init(label: String, detail: String?, selected: Bool) {
        super.init(frame: .zero)

        backgroundColor = selected ? Theme.Colors.primarySubtle : .clear
        layer.cornerRadius = 8

        iconView.image = UIImage(systemName: selected ? "checkmark.circle.fill" : "circle")
        iconView.tintColor = selected ? Theme.Colors.primary : Theme.Colors.textMuted
        iconView.contentMode = .scaleAspectFit
        iconView.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.text = label
        titleLabel.font = Typography.body
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.numberOfLines = 0

        var labels: [UILabel] = [titleLabel]
        if let detail, !detail.isEmpty {
            detailLabel.text = detail
            detailLabel.font = Typography.caption
            detailLabel.textColor = Theme.Colors.textSecondary
            detailLabel.numberOfLines = 0
            labels.append(detailLabel)
        }

        let textStack = UIStackView(arrangedSubviews: labels)
        textStack.axis = .vertical
        textStack.spacing = 2
        textStack.isUserInteractionEnabled = false
        textStack.translatesAutoresizingMaskIntoConstraints = false

        addSubview(iconView)
        addSubview(textStack)

        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.xs),
            iconView.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xs),
            iconView.widthAnchor.constraint(equalToConstant: 18),
            iconView.heightAnchor.constraint(equalToConstant: 18),

            textStack.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: Spacing.xs),
            textStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.xs),
            textStack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xs),
            textStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.xs),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        ])

        addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isHighlighted: Bool {
        didSet {
            alpha = isHighlighted ? 0.6 : 1
        }
    }
}

// MARK: - Code

final class CodeBlockView: UIView {
    private let scrollView = UIScrollView()
    private let label = UILabel()
    private var heightConstraint: NSLayoutConstraint!

    init(text: String, language: String? = nil) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        backgroundColor = Theme.Colors.codeBackground
        layer.cornerRadius = 6

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsVerticalScrollIndicator = true
        scrollView.alwaysBounceVertical = false
        addSubview(scrollView)

        label.attributedText = CodeHighlighter.highlight(
            text,
            language: language,
            font: Typography.code,
            textColor: Theme.Colors.textSecondary,
            keywordColor: Theme.Colors.primary,
            stringColor: Theme.Colors.success,
            numberColor: Theme.Colors.warning,
            commentColor: Theme.Colors.textMuted
        )
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(label)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),

            label.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            label.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            label.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            label.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
        ])

        heightConstraint = heightAnchor.constraint(equalToConstant: 40)
        heightConstraint.isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let width = max(scrollView.bounds.width, 1)
        let fit = label.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        let target = min(max(fit.height + 16, 28), 200)
        if abs(heightConstraint.constant - target) > 0.5 {
            heightConstraint.constant = target
        }
    }
}

private extension UIView {
    /// A collapsible block changes its intrinsic height without a snapshot update.
    /// Ask the enclosing table to re-query the row height on the next run loop, after
    /// the newly shown content has laid out.
    func notifyEnclosingTableHeightChanged(animated: Bool = true) {
        DispatchQueue.main.async { [weak self] in
            // The cell can outlive its controller (for example while a chat is being
            // popped). A batch update then runs against a table whose data source is
            // gone or has already changed, and UIKit throws "Invalid batch updates".
            guard let self, self.window != nil else { return }

            var current: UIView? = self
            var enclosingCell: UITableViewCell?

            while let view = current {
                if let cell = view as? UITableViewCell {
                    enclosingCell = cell
                }
                if let table = view as? UITableView {
                    guard let cell = enclosingCell,
                          table.dataSource != nil,
                          table.window != nil,
                          let indexPath = table.indexPath(for: cell),
                          indexPath.section < table.numberOfSections,
                          indexPath.row < table.numberOfRows(inSection: indexPath.section) else {
                        return
                    }

                    if animated {
                        table.beginUpdates()
                        table.endUpdates()
                    } else {
                        UIView.performWithoutAnimation {
                            table.beginUpdates()
                            table.endUpdates()
                        }
                    }
                    return
                }
                current = view.superview
            }
        }
    }
}
