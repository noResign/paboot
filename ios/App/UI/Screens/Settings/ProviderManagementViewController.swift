import Combine
import PabootProtocol
import UIKit

/// Provider catalog management for builtin runtime + Memory.
final class ProviderManagementViewController: UIViewController {
    private let viewModel = ProviderViewModel()
    private var cancellables = Set<AnyCancellable>()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "模型 Provider"
        view.backgroundColor = Theme.Colors.background
        configureLayout()
        bind()
        Task { await viewModel.load() }
    }

    private func configureLayout() {
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.spacing = Spacing.md
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(scrollView)
        scrollView.addSubview(contentStack)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
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
            .sink { [weak self] state in self?.render(state) }
            .store(in: &cancellables)
    }

    private func render(_ state: ProviderViewModel.State) {
        contentStack.arrangedSubviews.forEach { view in
            contentStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        let hint = UILabel()
        hint.text = "builtin runtime 与 Memory 共用这份配置。API Key 只写入 daemon 本机，不会回传客户端。"
        hint.font = Typography.caption
        hint.textColor = Theme.Colors.textSecondary
        hint.numberOfLines = 0
        contentStack.addArrangedSubview(hint)

        let addButton = makeButton("新增 Provider", filled: true)
        addButton.addAction(UIAction { [weak self] _ in
            self?.viewModel.clearMessages()
            self?.presentEditor(provider: nil)
        }, for: .touchUpInside)
        contentStack.addArrangedSubview(addButton)

        if let error = state.error {
            contentStack.addArrangedSubview(messageLabel(error, color: Theme.Colors.error))
        }
        if let notice = state.notice {
            contentStack.addArrangedSubview(messageLabel(notice, color: Theme.Colors.primary))
        }
        if state.isLoading {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            contentStack.addArrangedSubview(spinner)
        }

        for provider in state.providers {
            contentStack.addArrangedSubview(makeProviderCard(provider, busy: state.busy))
        }
    }

    private func makeProviderCard(_ provider: ProviderDto, busy: Bool) -> UIView {
        let card = UIView()
        card.backgroundColor = Theme.Colors.surface
        card.layer.cornerRadius = Radius.card
        card.layer.borderWidth = 1
        card.layer.borderColor = Theme.Colors.border.cgColor

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.md),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.md),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.md),
        ])

        let titleRow = UIStackView()
        titleRow.axis = .horizontal
        titleRow.alignment = .center
        titleRow.spacing = Spacing.sm
        let title = UILabel()
        title.text = provider.label.isEmpty ? provider.id : provider.label
        title.font = Typography.cardTitle
        title.textColor = Theme.Colors.textPrimary
        titleRow.addArrangedSubview(title)
        if provider.builtin {
            let badge = UILabel()
            badge.text = "内置"
            badge.font = Typography.caption
            badge.textColor = Theme.Colors.textSecondary
            titleRow.addArrangedSubview(badge)
        }
        let spacer = UIView()
        titleRow.addArrangedSubview(spacer)
        let keyLabel = UILabel()
        keyLabel.text = provider.hasApiKey
            ? "Key 已配置 · \(provider.apiKeySource ?? "unknown")"
            : "未配置 Key"
        keyLabel.font = Typography.caption
        keyLabel.textColor = provider.hasApiKey ? Theme.Colors.textSecondary : Theme.Colors.error
        titleRow.addArrangedSubview(keyLabel)
        stack.addArrangedSubview(titleRow)

        stack.addArrangedSubview(monoLabel(provider.id))
        stack.addArrangedSubview(monoLabel(provider.baseUrl))
        let models = provider.models.filter { $0.enabled != false }
        stack.addArrangedSubview(messageLabel("\(provider.models.count) 个模型 · 已启用 \(models.count)", color: Theme.Colors.textSecondary))

        let actions = UIStackView()
        actions.axis = .horizontal
        actions.spacing = Spacing.sm
        let edit = makeButton("编辑")
        edit.addAction(UIAction { [weak self] _ in
            self?.viewModel.clearMessages()
            self?.presentEditor(provider: provider)
        }, for: .touchUpInside)
        let test = makeButton("测试")
        test.isEnabled = provider.hasApiKey && !busy
        test.addAction(UIAction { [weak self] _ in
            Task { await self?.viewModel.test(provider) }
        }, for: .touchUpInside)
        let refresh = makeButton("刷新")
        refresh.isEnabled = provider.hasApiKey && !busy
        refresh.addAction(UIAction { [weak self] _ in
            Task { await self?.viewModel.refreshModels(provider) }
        }, for: .touchUpInside)
        actions.addArrangedSubview(edit)
        actions.addArrangedSubview(test)
        actions.addArrangedSubview(refresh)
        if !provider.builtin {
            let delete = makeButton("删除", destructive: true)
            delete.isEnabled = !busy
            delete.addAction(UIAction { [weak self] _ in
                self?.confirmDelete(provider)
            }, for: .touchUpInside)
            actions.addArrangedSubview(delete)
        }
        stack.addArrangedSubview(actions)
        return card
    }

    private func presentEditor(provider: ProviderDto?) {
        let editor = ProviderEditorViewController(provider: provider)
        editor.onSave = { [weak self] draft in
            Task {
                await self?.viewModel.save(original: provider, draft: draft)
            }
        }
        let nav = UINavigationController(rootViewController: editor)
        present(nav, animated: true)
    }

    private func confirmDelete(_ provider: ProviderDto) {
        let alert = UIAlertController(
            title: "删除 Provider",
            message: "删除「\(provider.label.isEmpty ? provider.id : provider.label)」？历史会话保留，但之后使用该模型的 run 会失败。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "删除", style: .destructive) { [weak self] _ in
            Task { await self?.viewModel.delete(provider) }
        })
        present(alert, animated: true)
    }

    private func monoLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.code
        label.textColor = Theme.Colors.textSecondary
        label.numberOfLines = 1
        label.lineBreakMode = .byTruncatingMiddle
        return label
    }

    private func messageLabel(_ text: String, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = color
        label.numberOfLines = 0
        return label
    }

    private func makeButton(_ title: String, filled: Bool = false, destructive: Bool = false) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = Typography.caption
        button.layer.cornerRadius = Radius.card
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 34).isActive = true
        if filled {
            button.backgroundColor = Theme.Colors.primary
            button.setTitleColor(.white, for: .normal)
        } else {
            button.layer.borderWidth = 1
            button.layer.borderColor = Theme.Colors.border.cgColor
            button.setTitleColor(destructive ? Theme.Colors.error : Theme.Colors.textPrimary, for: .normal)
        }
        return button
    }
}

private final class ProviderEditorViewController: UIViewController {
    var onSave: ((ProviderDraft) -> Void)?
    private let provider: ProviderDto?
    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let kindControl = UISegmentedControl(items: ["OpenAI-compatible", "Anthropic"])
    private let idField = UITextField()
    private let labelField = UITextField()
    private let baseUrlField = UITextField()
    private let apiKeyField = UITextField()
    private let clearKeySwitch = UISwitch()
    private let clearKeyRow = UIStackView()
    private let modelIdsView = UITextView()

    init(provider: ProviderDto?) {
        self.provider = provider
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = provider == nil ? "新增 Provider" : "编辑 Provider"
        view.backgroundColor = Theme.Colors.background
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "取消",
            style: .plain,
            target: self,
            action: #selector(cancelTapped)
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "保存",
            style: .done,
            target: self,
            action: #selector(saveTapped)
        )
        configureLayout()
        populate()
    }

    private func configureLayout() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = Spacing.md
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.lg),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.lg),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -Spacing.lg * 2),
        ])

        configureField(idField, placeholder: "Provider id")
        configureField(labelField, placeholder: "显示名称")
        configureField(baseUrlField, placeholder: "https://api.deepseek.com")
        configureField(apiKeyField, placeholder: "API Key（留空不修改）", secure: true)
        idField.autocapitalizationType = .none
        idField.autocorrectionType = .no
        baseUrlField.keyboardType = .URL

        stack.addArrangedSubview(captionLabel("类型"))
        stack.addArrangedSubview(kindControl)
        stack.addArrangedSubview(captionLabel("ID"))
        stack.addArrangedSubview(idField)
        stack.addArrangedSubview(captionLabel("显示名称"))
        stack.addArrangedSubview(labelField)
        stack.addArrangedSubview(captionLabel("Base URL"))
        stack.addArrangedSubview(baseUrlField)
        stack.addArrangedSubview(captionLabel("API Key"))
        stack.addArrangedSubview(apiKeyField)

        clearKeyRow.axis = .horizontal
        clearKeyRow.spacing = Spacing.sm
        clearKeyRow.alignment = .center
        clearKeyRow.addArrangedSubview(clearKeySwitch)
        clearKeyRow.addArrangedSubview(captionLabel("清除已保存的 Key（环境变量 fallback 仍可生效）"))
        stack.addArrangedSubview(clearKeyRow)

        stack.addArrangedSubview(captionLabel("模型 ID（每行一个）"))
        modelIdsView.font = Typography.code
        modelIdsView.textColor = Theme.Colors.textPrimary
        modelIdsView.backgroundColor = Theme.Colors.surface
        modelIdsView.layer.borderWidth = 1
        modelIdsView.layer.borderColor = Theme.Colors.border.cgColor
        modelIdsView.layer.cornerRadius = Radius.card
        modelIdsView.heightAnchor.constraint(equalToConstant: 120).isActive = true
        stack.addArrangedSubview(modelIdsView)

        let hint = captionLabel("已有模型会按 id 保留 tools / 图片 / 上下文配置；新模型默认支持 tools、不支持图片。")
        stack.addArrangedSubview(hint)
    }

    private func populate() {
        guard let provider else {
            kindControl.selectedSegmentIndex = 0
            baseUrlField.text = "https://api.deepseek.com"
            clearKeyRow.isHidden = true
            return
        }
        idField.text = provider.id
        idField.isEnabled = false
        labelField.text = provider.label
        baseUrlField.text = provider.baseUrl
        kindControl.selectedSegmentIndex = provider.kind == "anthropic" ? 1 : 0
        modelIdsView.text = provider.models.map(\.id).joined(separator: "\n")
        clearKeyRow.isHidden = !provider.hasApiKey
        clearKeySwitch.isOn = false
    }

    @objc private func saveTapped() {
        let draft = ProviderDraft(
            id: idField.text ?? "",
            kind: kindControl.selectedSegmentIndex == 1 ? "anthropic" : "openai",
            label: labelField.text ?? "",
            baseUrl: baseUrlField.text ?? "",
            apiKey: apiKeyField.text ?? "",
            clearKey: clearKeySwitch.isOn,
            modelIds: modelIdsView.text
        )
        onSave?(draft)
        dismiss(animated: true)
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
    }

    private func configureField(_ field: UITextField, placeholder: String, secure: Bool = false) {
        field.placeholder = placeholder
        field.isSecureTextEntry = secure
        field.font = Typography.body
        field.textColor = Theme.Colors.textPrimary
        field.backgroundColor = Theme.Colors.surface
        field.layer.cornerRadius = Radius.card
        field.layer.borderWidth = 1
        field.layer.borderColor = Theme.Colors.border.cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
        field.leftViewMode = .always
        field.heightAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true
    }

    private func captionLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        label.numberOfLines = 0
        return label
    }
}
