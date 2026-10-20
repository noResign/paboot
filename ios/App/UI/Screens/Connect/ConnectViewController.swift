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

    private func rebuildSavedRows(_ connections: [SavedConnection]) {
        savedSection.isHidden = connections.isEmpty
        savedStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for connection in connections {
            let row = SavedConnectionRow(connection: connection)
            row.setContentHuggingPriority(.defaultLow, for: .horizontal)
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
            row.addAction(
                UIAction { [weak self] _ in self?.viewModel.select(connection) },
                for: .touchUpInside
            )

            let deleteButton = UIButton(type: .system)
            deleteButton.setImage(UIImage(systemName: "trash"), for: .normal)
            deleteButton.tintColor = Theme.Colors.error
            deleteButton.accessibilityLabel = "删除连接"
            deleteButton.setContentHuggingPriority(.required, for: .horizontal)
            deleteButton.widthAnchor.constraint(equalToConstant: Layout.minTouchTarget).isActive = true
            deleteButton.heightAnchor.constraint(equalToConstant: Layout.minTouchTarget).isActive = true
            deleteButton.addAction(
                UIAction { [weak self] _ in self?.viewModel.forget(connection) },
                for: .touchUpInside
            )

            let line = UIStackView(arrangedSubviews: [row, deleteButton])
            line.axis = .horizontal
            line.alignment = .center
            line.spacing = Spacing.xs
            savedStack.addArrangedSubview(line)
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

/// One saved connection: name + URL, tappable to fill the form.
private final class SavedConnectionRow: UIControl {
    init(connection: SavedConnection) {
        super.init(frame: .zero)

        backgroundColor = Theme.Colors.surface
        layer.cornerRadius = Radius.card

        let nameLabel = UILabel()
        nameLabel.text = connection.displayName
        nameLabel.font = Typography.cardTitle
        nameLabel.textColor = Theme.Colors.textPrimary

        let urlLabel = UILabel()
        urlLabel.text = connection.baseUrl
        urlLabel.font = Typography.caption
        urlLabel.textColor = Theme.Colors.textSecondary

        let stack = UIStackView(arrangedSubviews: [nameLabel, urlLabel])
        stack.axis = .vertical
        stack.spacing = 2
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.sm),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.sm),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.sm),
        ])

        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = "\(connection.displayName), \(connection.baseUrl)"
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
