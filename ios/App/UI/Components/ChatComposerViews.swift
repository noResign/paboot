import UIKit

/// Bottom composer: text field + send/stop button.
final class ChatInputBar: UIView {
    var onSend: ((String) -> Void)?
    var onStop: (() -> Void)?

    private let textField = UITextField()
    private let actionButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = .clear

        let fieldContainer = UIView()
        fieldContainer.backgroundColor = .clear
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

        actionButton.layer.cornerRadius = 22
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

        addSubview(row)

        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),

            fieldContainer.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            textField.leadingAnchor.constraint(equalTo: fieldContainer.leadingAnchor, constant: Spacing.sm),
            textField.trailingAnchor.constraint(equalTo: fieldContainer.trailingAnchor, constant: -Spacing.sm),
            textField.topAnchor.constraint(equalTo: fieldContainer.topAnchor),
            textField.bottomAnchor.constraint(equalTo: fieldContainer.bottomAnchor),

            actionButton.widthAnchor.constraint(equalToConstant: 44),
            actionButton.heightAnchor.constraint(equalToConstant: 44),
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
        actionButton.backgroundColor = isStreaming ? Theme.Colors.surface2 : Theme.Colors.primarySubtle
        actionButton.tintColor = isStreaming ? Theme.Colors.textPrimary : Theme.Colors.primaryDeep
        actionButton.accessibilityLabel = isStreaming ? "停止" : "发送"
    }

    private func updateEnabled() {
        let hasText = !(textField.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        actionButton.isEnabled = isStreaming || hasText
        actionButton.alpha = actionButton.isEnabled ? 1 : 0.4
    }
}

extension ChatInputBar: UITextFieldDelegate {
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        guard !isStreaming else { return false }
        send()
        return true
    }
}

/// Two modes share one footprint; swapping content never changes transcript height.
final class ChatBottomBar: UIView {
    enum Mode { case input, navigation }
    enum Destination: Int { case sessions, files, settings }

    let inputBar = ChatInputBar()
    private(set) var mode: Mode = .input
    var onNavigate: ((Destination) -> Void)?
    private let toggleButton = UIButton(type: .system)
    private let navigationRow = UIStackView()
    private let navigationOnly: Bool
    private var navigationButtons: [Destination: UIButton] = [:]
    private var selectedDestination: Destination?
    static let minimumHeight: CGFloat = 64
    static let bottomOffset: CGFloat = 8

    init(navigationOnly: Bool = false) {
        self.navigationOnly = navigationOnly
        super.init(frame: .zero)
        mode = navigationOnly ? .navigation : .input
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = .clear
        let material = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        material.translatesAutoresizingMaskIntoConstraints = false
        material.layer.cornerRadius = 28
        material.layer.cornerCurve = .continuous
        material.clipsToBounds = true
        addSubview(material)

        toggleButton.translatesAutoresizingMaskIntoConstraints = false
        toggleButton.accessibilityIdentifier = "chat.bottom.toggle"
        toggleButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.setMode(self.mode == .input ? .navigation : .input, animated: true)
        }, for: .touchUpInside)
        material.contentView.addSubview(toggleButton)

        let divider = UIView()
        divider.backgroundColor = Theme.Colors.border
        divider.translatesAutoresizingMaskIntoConstraints = false
        material.contentView.addSubview(divider)
        toggleButton.isHidden = navigationOnly
        divider.isHidden = navigationOnly

        navigationRow.axis = .horizontal
        navigationRow.distribution = .fillEqually
        navigationRow.translatesAutoresizingMaskIntoConstraints = false
        for (destination, title, symbol) in [
            (Destination.sessions, "会话", "bubble.left.and.bubble.right"),
            (.files, "文件", "folder"),
            (.settings, "设置", "gearshape"),
        ] {
            let button = UIButton(type: .system)
            button.configuration = Self.buttonConfiguration(title: title, symbol: symbol)
            button.accessibilityIdentifier = "chat.bottom.\(destination)"
            button.addAction(UIAction { [weak self] _ in
                self?.onNavigate?(destination)
            }, for: .touchUpInside)
            navigationRow.addArrangedSubview(button)
            navigationButtons[destination] = button
        }
        material.contentView.addSubview(navigationRow)
        material.contentView.addSubview(inputBar)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(greaterThanOrEqualToConstant: Self.minimumHeight),
            material.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xxs),
            material.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.xxs),
            material.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.lg),
            material.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.lg),
            toggleButton.leadingAnchor.constraint(equalTo: material.contentView.leadingAnchor, constant: Spacing.xxs),
            toggleButton.topAnchor.constraint(equalTo: material.contentView.topAnchor, constant: Spacing.xxs),
            toggleButton.bottomAnchor.constraint(equalTo: material.contentView.bottomAnchor, constant: -Spacing.xxs),
            toggleButton.widthAnchor.constraint(equalToConstant: Layout.minTouchTarget),
            divider.leadingAnchor.constraint(equalTo: toggleButton.trailingAnchor, constant: Spacing.xxs),
            divider.centerYAnchor.constraint(equalTo: material.contentView.centerYAnchor),
            divider.widthAnchor.constraint(equalToConstant: 1),
            divider.heightAnchor.constraint(equalToConstant: 24),
        ])
        // Both views stay constrained even while hidden. UIKit does not collapse
        // ordinary subviews as it would arrangedSubviews in a UIStackView.
        for content in [inputBar as UIView, navigationRow] {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(
                    equalTo: navigationOnly ? material.contentView.leadingAnchor : divider.trailingAnchor,
                    constant: Spacing.xxs
                ),
                content.trailingAnchor.constraint(equalTo: material.contentView.trailingAnchor, constant: -Spacing.xxs),
                content.topAnchor.constraint(equalTo: material.contentView.topAnchor, constant: Spacing.xxs),
                content.bottomAnchor.constraint(equalTo: material.contentView.bottomAnchor, constant: -Spacing.xxs),
            ])
        }
        applyMode()
        setSelectedDestination(.sessions)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setMode(_ mode: Mode, animated: Bool) {
        guard !navigationOnly, self.mode != mode else { return }
        if mode == .navigation { inputBar.endEditing(true) }
        self.mode = mode
        if animated && !UIAccessibility.isReduceMotionEnabled {
            UIView.transition(with: self, duration: 0.18,
                              options: [.transitionCrossDissolve, .beginFromCurrentState, .allowUserInteraction]) {
                self.applyMode()
            }
        } else {
            applyMode()
        }
        // Deliberately do not becomeFirstResponder: returning from Files or toggling
        // the controls should not open the keyboard until the text field is tapped.
    }

    func setSelectedDestination(_ destination: Destination) {
        guard selectedDestination != destination else { return }
        selectedDestination = destination
        for (item, button) in navigationButtons {
            var configuration = button.configuration
            configuration?.baseForegroundColor = item == destination ? Theme.Colors.primary : Theme.Colors.textSecondary
            button.configuration = configuration
            button.accessibilityTraits = item == destination ? [.button, .selected] : [.button]
        }
    }

    private func applyMode() {
        inputBar.isHidden = mode != .input
        navigationRow.isHidden = mode != .navigation
        let symbol = mode == .input ? "square.grid.2x2" : "square.and.pencil"
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: symbol)
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 20)
        configuration.baseForegroundColor = Theme.Colors.textPrimary
        toggleButton.configuration = configuration
        toggleButton.accessibilityLabel = mode == .input ? "切换到导航" : "切换到输入框"
    }

    private static func buttonConfiguration(title: String, symbol: String) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        configuration.image = UIImage(systemName: symbol)
        configuration.imagePlacement = .top
        configuration.imagePadding = 2
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 18)
        configuration.baseForegroundColor = Theme.Colors.textPrimary
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 2, leading: 2, bottom: 2, trailing: 2)
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var result = attributes
            result.font = UIFont.systemFont(ofSize: 11, weight: .medium)
            return result
        }
        return configuration
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
