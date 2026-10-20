import Foundation
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

final class AssistantMessageCell: UITableViewCell {
    static let reuseIdentifier = "AssistantMessageCell"

    private let stack = UIStackView()
    private let blockStack = UIStackView()
    private let loadingLabel = UILabel()
    private let footerLabel = UILabel()

    private var blockViews: [ChatBlockView] = []
    private var blockKinds: [String] = []
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
        loadingLabel.isHidden = true

        footerLabel.font = Typography.caption
        footerLabel.numberOfLines = 0
        footerLabel.isHidden = true

        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(blockStack)
        stack.addArrangedSubview(loadingLabel)
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

    func configure(
        message: ChatUiMessage,
        streaming: Bool,
        onAnswer: @escaping (String, String) -> Void
    ) {
        self.onAnswer = onAnswer

        let kinds = message.blocks.map(Self.kind)
        if kinds != blockKinds {
            rebuild(blocks: message.blocks)
        }

        for (view, block) in zip(blockViews, message.blocks) {
            view.update(block: block, streaming: streaming)
        }

        loadingLabel.isHidden = !(message.blocks.isEmpty && !message.done)

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
    }

    private func rebuild(blocks: [ContentBlock]) {
        blockStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        blockViews = blocks.map { block in
            switch block {
            case .text:
                return ChatTextBlockView(frame: .zero)
            case .thinking:
                return ChatThinkingBlockView(frame: .zero)
            case .tool:
                return ChatToolCardView(frame: .zero)
            case .question:
                let view = ChatQuestionCardView(frame: .zero)
                view.onSubmit = { [weak self] toolUseId, text in
                    self?.onAnswer?(toolUseId, text)
                }
                return view
            }
        }

        for view in blockViews {
            blockStack.addArrangedSubview(view)
        }
        blockKinds = blocks.map(Self.kind)
    }

    private static func kind(_ block: ContentBlock) -> String {
        switch block {
        case .text:
            return "text"
        case .thinking:
            return "thinking"
        case .tool(let tool):
            return "tool:\(tool.id)"
        case .question(let question):
            return "question:\(question.toolUseId)"
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

    func update(block: ContentBlock, streaming: Bool) {}
}

final class ChatTextBlockView: ChatBlockView {
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)

        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func update(block: ContentBlock, streaming: Bool) {
        guard case .text(let text) = block else { return }
        label.attributedText = MarkdownRenderer.render(text)
    }
}

final class ChatThinkingBlockView: ChatBlockView {
    private let headerLabel = UILabel()
    private let bodyLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)

        headerLabel.text = "思考"
        headerLabel.font = Typography.caption
        headerLabel.textColor = Theme.Colors.thinking

        bodyLabel.font = Typography.caption
        bodyLabel.textColor = Theme.Colors.thinking
        bodyLabel.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [headerLabel, bodyLabel])
        stack.axis = .vertical
        stack.spacing = Spacing.xxs
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
        guard case .thinking(let text) = block else { return }
        bodyLabel.text = text
    }
}

final class ChatToolCardView: ChatBlockView {
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let detailLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)

        backgroundColor = Theme.Colors.surface2
        layer.cornerRadius = Radius.card

        titleLabel.font = Typography.cardTitle
        titleLabel.textColor = Theme.Colors.textPrimary

        statusLabel.font = Typography.caption
        statusLabel.setContentHuggingPriority(.required, for: .horizontal)

        detailLabel.font = Typography.code
        detailLabel.textColor = Theme.Colors.textSecondary
        detailLabel.numberOfLines = 8

        let header = UIStackView(arrangedSubviews: [titleLabel, statusLabel])
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = Spacing.xs

        let stack = UIStackView(arrangedSubviews: [header, detailLabel])
        stack.axis = .vertical
        stack.spacing = Spacing.xs
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
        guard case .tool(let tool) = block else { return }

        titleLabel.text = tool.name

        if tool.running {
            statusLabel.text = "运行中"
            statusLabel.textColor = Theme.Colors.primary
        } else if tool.interrupted {
            statusLabel.text = "中断"
            statusLabel.textColor = Theme.Colors.warning
        } else if tool.isError {
            statusLabel.text = "失败"
            statusLabel.textColor = Theme.Colors.error
        } else {
            statusLabel.text = "完成"
            statusLabel.textColor = Theme.Colors.success
        }

        let output = tool.result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let input = tool.input.map(Self.jsonText) ?? ""
        let detail = output.isEmpty ? input : output

        detailLabel.text = detail.isEmpty
            ? (tool.running ? "等待结果…" : "无输出")
            : String(detail.prefix(2_000))
    }

    private static func jsonText(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
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

// MARK: - Markdown

enum MarkdownRenderer {
    static func render(_ text: String) -> NSAttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )

        guard let markdown = try? AttributedString(markdown: text, options: options) else {
            return plain(text)
        }

        let mutable = NSMutableAttributedString(attributedString: NSAttributedString(markdown))
        if mutable.length > 0 {
            let fullRange = NSRange(location: 0, length: mutable.length)
            mutable.addAttribute(
                .foregroundColor,
                value: Theme.Colors.textPrimary,
                range: fullRange
            )

            var missingFont: [NSRange] = []
            mutable.enumerateAttribute(.font, in: fullRange) { value, range, _ in
                if value == nil {
                    missingFont.append(range)
                }
            }
            for range in missingFont {
                mutable.addAttribute(.font, value: Typography.body, range: range)
            }
        }
        return mutable
    }

    private static func plain(_ text: String) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: [
                .font: Typography.body,
                .foregroundColor: Theme.Colors.textPrimary,
            ]
        )
    }
}
