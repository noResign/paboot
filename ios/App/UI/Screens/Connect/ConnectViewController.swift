import Combine
import UIKit

/// The entry screen: address + token, verify against `/api/health` and `/api/sessions`,
/// then remember the connection and hand off to the main tabs.
final class ConnectViewController: UIViewController {
    private let viewModel: ConnectViewModel
    private var cancellables = Set<AnyCancellable>()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let brandImage = UIImageView()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let addressField = FormField(
        label: "地址",
        placeholder: "192.168.1.2:4780",
        keyboardType: .URL
    )
    private let tokenField = FormField(
        label: "Token",
        placeholder: "从 ~/.paboot/token 读取",
        isSecure: true
    )
    private let nameField = FormField(
        label: "名称（可选）",
        placeholder: "这台电脑的名字",
        returnKeyType: .done
    )
    private let connectButton = UIButton(type: .system)
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let errorLabel = UILabel()
    private let savedTitleLabel = UILabel()
    private let savedStack = UIStackView()
    private let savedSection = UIStackView()
    private let hintLabel = UILabel()
    private var lastSaved: [SavedConnection] = []

    init(viewModel: ConnectViewModel) {
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
        configureViews()
        configureLayout()
        bind()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    private func configureViews() {
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        contentStack.axis = .vertical
        contentStack.spacing = Spacing.md
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        brandImage.image = UIImage(named: "BrandMark")
        brandImage.contentMode = .scaleAspectFit

        titleLabel.text = "Paboot"
        titleLabel.font = Typography.pageTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.textAlignment = .center

        subtitleLabel.text = "一个客户端，操纵你所有的 agent"
        subtitleLabel.font = Typography.caption
        subtitleLabel.textColor = Theme.Colors.textSecondary
        subtitleLabel.textAlignment = .center
        subtitleLabel.numberOfLines = 0

        addressField.textField.textContentType = .URL
        addressField.textField.delegate = self
        addressField.textField.addTarget(self, action: #selector(addressChanged), for: .editingChanged)

        tokenField.textField.delegate = self
        tokenField.textField.addTarget(self, action: #selector(tokenChanged), for: .editingChanged)

        nameField.textField.delegate = self
        nameField.textField.addTarget(self, action: #selector(nameChanged), for: .editingChanged)

        connectButton.setTitle("连接", for: .normal)
        connectButton.titleLabel?.font = Typography.cardTitle
        connectButton.setTitleColor(Theme.Colors.onPrimary, for: .normal)
        connectButton.backgroundColor = Theme.Colors.primary
        connectButton.layer.cornerRadius = Radius.card
        connectButton.contentEdgeInsets = UIEdgeInsets(
            top: Spacing.sm,
            left: Spacing.md,
            bottom: Spacing.sm,
            right: Spacing.md
        )
        connectButton.heightAnchor.constraint(equalToConstant: Layout.minTouchTarget).isActive = true
        connectButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        connectButton.addAction(UIAction { [weak self] _ in self?.viewModel.connect() }, for: .touchUpInside)

        activityIndicator.color = Theme.Colors.textSecondary
        activityIndicator.hidesWhenStopped = true

        errorLabel.font = Typography.caption
        errorLabel.textColor = Theme.Colors.error
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true

        savedTitleLabel.text = "最近连接"
        savedTitleLabel.font = Typography.cardTitle
        savedTitleLabel.textColor = Theme.Colors.textPrimary

        savedStack.axis = .vertical
        savedStack.spacing = Spacing.xs

        savedSection.axis = .vertical
        savedSection.spacing = Spacing.xs
        savedSection.addArrangedSubview(savedTitleLabel)
        savedSection.addArrangedSubview(savedStack)
        savedSection.isHidden = true

        hintLabel.text = "token 等同于在电脑上执行命令的权限，请只在可信网络或隧道中使用。"
        hintLabel.font = Typography.caption
        hintLabel.textColor = Theme.Colors.textMuted
        hintLabel.numberOfLines = 0

        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
    }

    private func configureLayout() {
        let header = UIStackView(arrangedSubviews: [brandImage, titleLabel, subtitleLabel])
        header.axis = .vertical
        header.alignment = .center
        header.spacing = Spacing.xs
        brandImage.heightAnchor.constraint(equalToConstant: 120).isActive = true

        let connectRow = UIStackView(arrangedSubviews: [connectButton, activityIndicator])
        connectRow.axis = .horizontal
        connectRow.alignment = .center
        connectRow.spacing = Spacing.xs

        contentStack.addArrangedSubview(header)
        contentStack.setCustomSpacing(Spacing.xl, after: header)
        contentStack.addArrangedSubview(addressField)
        contentStack.addArrangedSubview(tokenField)
        contentStack.addArrangedSubview(nameField)
        contentStack.addArrangedSubview(connectRow)
        contentStack.addArrangedSubview(errorLabel)
        contentStack.addArrangedSubview(savedSection)
        contentStack.addArrangedSubview(hintLabel)
        contentStack.setCustomSpacing(Spacing.xl, after: savedSection)

        view.addSubview(scrollView)
        scrollView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),

            contentStack.topAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.topAnchor,
                constant: Spacing.xl
            ),
            contentStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor,
                constant: -Spacing.xl
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
        ])
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: ConnectViewModel.State) {
        setText(addressField.textField, state.address)
        setText(tokenField.textField, state.token)
        setText(nameField.textField, state.name)

        connectButton.isEnabled = !state.isConnecting
        connectButton.alpha = state.isConnecting ? 0.5 : 1
        if state.isConnecting {
            activityIndicator.startAnimating()
        } else {
            activityIndicator.stopAnimating()
        }

        errorLabel.text = state.error
        errorLabel.isHidden = state.error == nil

        if state.saved != lastSaved {
            lastSaved = state.saved
            rebuildSavedRows(state.saved)
        }
    }

    private func setText(_ field: UITextField, _ value: String) {
        if field.text != value {
            field.text = value
        }
    }

    private func presentEdit(_ connection: SavedConnection) {
        let alert = UIAlertController(title: "编辑连接", message: nil, preferredStyle: .alert)

        alert.addTextField { field in
            field.text = connection.name
            field.placeholder = "名称（可选）"
            field.autocapitalizationType = .none
        }
        alert.addTextField { field in
            field.text = connection.baseUrl
            field.placeholder = "地址"
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addTextField { [weak self] field in
            field.text = self?.viewModel.token(for: connection) ?? ""
            field.placeholder = "Token"
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }

        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "保存", style: .default) { [weak self] _ in
            guard let self, let fields = alert.textFields, fields.count == 3 else { return }
            self.viewModel.update(
                connection,
                name: fields[0].text ?? "",
                address: fields[1].text ?? "",
                token: fields[2].text ?? ""
            )
        })
        present(alert, animated: true)
    }

    private func closeSavedRows(except row: SavedConnectionRow) {
        savedStack.arrangedSubviews
            .compactMap { $0 as? SavedConnectionRow }
            .filter { $0 !== row }
            .forEach { $0.close() }
    }

    private func rebuildSavedRows(_ connections: [SavedConnection]) {
        savedSection.isHidden = connections.isEmpty
        savedStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for connection in connections {
            let row = SavedConnectionRow(connection: connection)
            row.setContentHuggingPriority(.defaultLow, for: .horizontal)
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
            row.onSelect = { [weak self] in self?.viewModel.select(connection) }
            row.onEdit = { [weak self] in self?.presentEdit(connection) }
            row.onDelete = { [weak self] in self?.viewModel.forget(connection) }
            row.onOpen = { [weak self, weak row] in
                guard let self, let row else { return }
                self.closeSavedRows(except: row)
            }
            savedStack.addArrangedSubview(row)
        }
    }

    @objc private func addressChanged() {
        viewModel.updateAddress(addressField.text)
    }

    @objc private func tokenChanged() {
        viewModel.updateToken(tokenField.text)
    }

    @objc private func nameChanged() {
        viewModel.updateName(nameField.text)
    }

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }
}

extension ConnectViewController: UITextFieldDelegate {
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === addressField.textField {
            tokenField.textField.becomeFirstResponder()
        } else if textField === tokenField.textField {
            nameField.textField.becomeFirstResponder()
        } else {
            textField.resignFirstResponder()
            viewModel.connect()
        }
        return true
    }
}

/// One saved connection: name + URL, tap to fill the form, swipe left to reveal delete.
private final class SavedConnectionRow: UIControl, UIGestureRecognizerDelegate {
    private let actionWidth: CGFloat = 80
    private var revealWidth: CGFloat { actionWidth * 2 }
    private let cardView = UIView()
    private let editButton = UIButton(type: .system)
    private let deleteButton = UIButton(type: .system)
    private var isOpen = false
    private var isDragging = false

    var onSelect: (() -> Void)?
    var onEdit: (() -> Void)?
    var onDelete: (() -> Void)?
    /// Called when this row starts opening, so the list can close the others.
    var onOpen: (() -> Void)?

    init(connection: SavedConnection) {
        super.init(frame: .zero)

        clipsToBounds = true
        layer.cornerRadius = Radius.card

        editButton.setTitle("编辑", for: .normal)
        editButton.titleLabel?.font = Typography.cardTitle
        editButton.setTitleColor(Theme.Colors.onPrimary, for: .normal)
        editButton.backgroundColor = Theme.Colors.primary
        editButton.accessibilityLabel = "编辑连接"
        editButton.isAccessibilityElement = false
        editButton.translatesAutoresizingMaskIntoConstraints = false
        editButton.addAction(
            UIAction { [weak self] _ in
                self?.setOpen(false, animated: false)
                self?.onEdit?()
            },
            for: .touchUpInside
        )
        addSubview(editButton)

        deleteButton.setTitle("删除", for: .normal)
        deleteButton.titleLabel?.font = Typography.cardTitle
        deleteButton.setTitleColor(.white, for: .normal)
        deleteButton.backgroundColor = Theme.Colors.error
        deleteButton.accessibilityLabel = "删除连接"
        deleteButton.isAccessibilityElement = false
        deleteButton.translatesAutoresizingMaskIntoConstraints = false
        deleteButton.addAction(
            UIAction { [weak self] _ in self?.onDelete?() },
            for: .touchUpInside
        )
        addSubview(deleteButton)

        cardView.backgroundColor = Theme.Colors.surface
        cardView.layer.cornerRadius = Radius.card
        cardView.clipsToBounds = true
        // Must stay interactive: while closed it shields the edit/delete buttons
        // underneath, so a tap on the row cannot trigger an action without swiping.
        cardView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(cardView)

        let nameLabel = UILabel()
        nameLabel.text = connection.displayName
        nameLabel.font = Typography.cardTitle
        nameLabel.textColor = Theme.Colors.textPrimary

        let urlLabel = UILabel()
        urlLabel.text = AddressMask.mask(connection.baseUrl)
        urlLabel.font = Typography.caption
        urlLabel.textColor = Theme.Colors.textSecondary

        let stack = UIStackView(arrangedSubviews: [nameLabel, urlLabel])
        stack.axis = .vertical
        stack.spacing = 2
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        cardView.addSubview(stack)

        NSLayoutConstraint.activate([
            deleteButton.trailingAnchor.constraint(equalTo: trailingAnchor),
            deleteButton.topAnchor.constraint(equalTo: topAnchor),
            deleteButton.bottomAnchor.constraint(equalTo: bottomAnchor),
            deleteButton.widthAnchor.constraint(equalToConstant: actionWidth),

            editButton.trailingAnchor.constraint(equalTo: deleteButton.leadingAnchor),
            editButton.topAnchor.constraint(equalTo: topAnchor),
            editButton.bottomAnchor.constraint(equalTo: bottomAnchor),
            editButton.widthAnchor.constraint(equalToConstant: actionWidth),

            cardView.leadingAnchor.constraint(equalTo: leadingAnchor),
            cardView.trailingAnchor.constraint(equalTo: trailingAnchor),
            cardView.topAnchor.constraint(equalTo: topAnchor),
            cardView.bottomAnchor.constraint(equalTo: bottomAnchor),

            stack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: Spacing.sm),
            stack.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -Spacing.sm),
            stack.topAnchor.constraint(equalTo: cardView.topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -Spacing.sm),
        ])

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan))
        pan.delegate = self
        addGestureRecognizer(pan)

        addAction(UIAction { [weak self] _ in self?.handleTap() }, for: .touchUpInside)

        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = "\(connection.displayName), \(AddressMask.mask(connection.baseUrl))"
        accessibilityHint = "左滑可编辑或删除"
        accessibilityCustomActions = [
            UIAccessibilityCustomAction(
                name: "编辑连接",
                target: self,
                selector: #selector(handleEditAction)
            ),
            UIAccessibilityCustomAction(
                name: "删除连接",
                target: self,
                selector: #selector(handleDeleteAction)
            ),
        ]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isHighlighted: Bool {
        didSet {
            alpha = isHighlighted && !isOpen && !isDragging ? 0.6 : 1
        }
    }

    private func handleTap() {
        if isOpen {
            setOpen(false, animated: true)
        } else {
            onSelect?()
        }
    }

    func close(animated: Bool = true) {
        guard isOpen else { return }
        setOpen(false, animated: animated)
    }

    @objc private func handleEditAction() -> Bool {
        setOpen(false, animated: false)
        onEdit?()
        return true
    }

    @objc private func handleDeleteAction() -> Bool {
        onDelete?()
        return true
    }

    private func setOpen(_ next: Bool, animated: Bool) {
        if next { onOpen?() }
        isOpen = next
        let changes = {
            self.cardView.transform = CGAffineTransform(translationX: next ? -self.revealWidth : 0, y: 0)
            self.alpha = 1
        }
        if animated {
            UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut], animations: changes)
        } else {
            changes()
        }
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: self).x
        let base: CGFloat = isOpen ? -revealWidth : 0

        switch gesture.state {
        case .began:
            isDragging = true
            alpha = 1
        case .changed:
            let x = min(0, max(-revealWidth, base + translation))
            cardView.transform = CGAffineTransform(translationX: x, y: 0)
        case .ended, .cancelled, .failed:
            isDragging = false
            let velocity = gesture.velocity(in: self).x
            let current = base + translation
            let next: Bool
            if velocity < -300 {
                next = true
            } else if velocity > 300 {
                next = false
            } else {
                next = current < -revealWidth / 2
            }
            setOpen(next, animated: true)
        default:
            break
        }
    }

    /// A horizontal pan belongs to the row; a vertical one belongs to the scroll view.
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: self)
        return abs(velocity.x) > abs(velocity.y)
    }
}
