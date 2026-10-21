import UIKit

/// Bottom composer: text field + send/stop button.
final class ChatInputBar: UIView {
    var onSend: ((String) -> Void)?
    var onStop: (() -> Void)?
    var onBeginEditing: (() -> Void)?
    var isEditingText: Bool { textField.isFirstResponder }

    private let textField = UITextField()
    private let actionButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.Colors.surface

        let topBorder = UIView()
        topBorder.backgroundColor = Theme.Colors.border
        topBorder.translatesAutoresizingMaskIntoConstraints = false

        let fieldContainer = UIView()
        fieldContainer.backgroundColor = Theme.Colors.codeBackground
        fieldContainer.layer.cornerRadius = 18
        fieldContainer.translatesAutoresizingMaskIntoConstraints = false

        textField.placeholder = "输入指令…"
        textField.font = Typography.body
        textField.textColor = Theme.Colors.textPrimary
        textField.tintColor = Theme.Colors.primary
        textField.returnKeyType = .send
        textField.delegate = self
        textField.addTarget(self, action: #selector(textChanged), for: .editingChanged)
        textField.translatesAutoresizingMaskIntoConstraints = false
        fieldContainer.addSubview(textField)

        actionButton.layer.cornerRadius = 18
        actionButton.tintColor = Theme.Colors.onPrimary
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.addAction(
            UIAction { [weak self] _ in self?.handleAction() },
            for: .touchUpInside
        )

        let row = UIStackView(arrangedSubviews: [fieldContainer, actionButton])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Spacing.xs
        row.translatesAutoresizingMaskIntoConstraints = false

        addSubview(topBorder)
        addSubview(row)

        // Allow the arranged view to collapse without conflicting with its row height.
        let rowBottom = row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.xs)
        rowBottom.priority = .defaultHigh

        NSLayoutConstraint.activate([
            topBorder.topAnchor.constraint(equalTo: topAnchor),
            topBorder.leadingAnchor.constraint(equalTo: leadingAnchor),
            topBorder.trailingAnchor.constraint(equalTo: trailingAnchor),
            topBorder.heightAnchor.constraint(equalToConstant: 1),

            row.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xs),
            rowBottom,
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.sm),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.sm),

            fieldContainer.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
            textField.leadingAnchor.constraint(equalTo: fieldContainer.leadingAnchor, constant: Spacing.sm),
            textField.trailingAnchor.constraint(equalTo: fieldContainer.trailingAnchor, constant: -Spacing.sm),
            textField.topAnchor.constraint(equalTo: fieldContainer.topAnchor),
            textField.bottomAnchor.constraint(equalTo: fieldContainer.bottomAnchor),

            actionButton.widthAnchor.constraint(equalToConstant: 36),
            actionButton.heightAnchor.constraint(equalToConstant: 36),
        ])

        updateAction()
        updateEnabled()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private var isStreaming = false

    func setStreaming(_ streaming: Bool) {
        isStreaming = streaming
        updateAction()
        updateEnabled()
    }

    @objc private func textChanged() {
        updateEnabled()
    }

    private func handleAction() {
        if isStreaming {
            onStop?()
        } else {
            send()
        }
    }

    private func send() {
        let text = textField.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return }
        textField.text = ""
        updateEnabled()
        onSend?(text)
    }

    private func updateAction() {
        let imageName = isStreaming ? "stop.fill" : "arrow.up"
        actionButton.setImage(
            UIImage(
                systemName: imageName,
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
            ),
            for: .normal
        )
        actionButton.backgroundColor = isStreaming ? Theme.Colors.surface2 : Theme.Colors.primary
        actionButton.tintColor = isStreaming ? Theme.Colors.textPrimary : Theme.Colors.onPrimary
        actionButton.accessibilityLabel = isStreaming ? "停止" : "发送"
    }

    private func updateEnabled() {
        let hasText = !(textField.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        actionButton.isEnabled = isStreaming || hasText
        actionButton.alpha = actionButton.isEnabled ? 1 : 0.4
    }
}

extension ChatInputBar: UITextFieldDelegate {
    func textFieldDidBeginEditing(_ textField: UITextField) {
        onBeginEditing?()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        guard !isStreaming else { return false }
        send()
        return true
    }
}

/// Compact TODO panel shown above the composer.
final class TodoPanelView: UIView {
    private let headerButton = UIButton(type: .system)
    private let rowsStack = UIStackView()
    private var todos: [TodoItem] = []
    private var expanded = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.Colors.surface
        isHidden = true

        headerButton.titleLabel?.font = Typography.caption
        headerButton.setTitleColor(Theme.Colors.textSecondary, for: .normal)
        headerButton.contentHorizontalAlignment = .leading
        headerButton.addAction(
            UIAction { [weak self] _ in self?.toggle() },
            for: .touchUpInside
        )

        rowsStack.axis = .vertical
        rowsStack.spacing = Spacing.xxs

        let stack = UIStackView(arrangedSubviews: [headerButton, rowsStack])
        stack.axis = .vertical
        stack.spacing = Spacing.xxs
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xs),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.xs),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.md),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(_ todos: [TodoItem]) {
        self.todos = todos
        isHidden = todos.isEmpty
        guard !todos.isEmpty else { return }
        update()
    }

    private func toggle() {
        expanded.toggle()
        update()
    }

    private func update() {
        let completed = todos.filter { $0.status == "completed" }.count
        headerButton.setTitle(
            "任务 \(completed)/\(todos.count) \(expanded ? "▾" : "▸")",
            for: .normal
        )
        rowsStack.isHidden = !expanded
        rowsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        guard expanded else { return }

        for todo in todos.prefix(6) {
            rowsStack.addArrangedSubview(row(for: todo))
        }
        if todos.count > 6 {
            let more = UILabel()
            more.text = "还有 \(todos.count - 6) 项…"
            more.font = Typography.caption
            more.textColor = Theme.Colors.textMuted
            rowsStack.addArrangedSubview(more)
        }
    }

    private func row(for todo: TodoItem) -> UIView {
        let icon = UIImageView()
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false

        switch todo.status {
        case "completed":
            icon.image = UIImage(systemName: "checkmark.circle.fill")
            icon.tintColor = Theme.Colors.success
        case "in_progress":
            icon.image = UIImage(systemName: "circle.dotted")
            icon.tintColor = Theme.Colors.primary
        default:
            icon.image = UIImage(systemName: "circle")
            icon.tintColor = Theme.Colors.textMuted
        }

        let label = UILabel()
        label.text = todo.content
        label.font = Typography.caption
        label.numberOfLines = 0
        if todo.status == "completed" {
            label.textColor = Theme.Colors.textMuted
            label.attributedText = NSAttributedString(
                string: todo.content,
                attributes: [
                    .font: Typography.caption,
                    .foregroundColor: Theme.Colors.textMuted,
                    .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                ]
            )
        } else {
            label.textColor = Theme.Colors.textSecondary
        }

        let row = UIStackView(arrangedSubviews: [icon, label])
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = Spacing.xs

        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 14),
            icon.heightAnchor.constraint(equalToConstant: 14),
        ])

        return row
    }
}
