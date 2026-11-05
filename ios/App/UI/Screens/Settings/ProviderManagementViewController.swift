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
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "+ 新增",
            style: .plain,
            target: self,
            action: #selector(addProvider)
        )
        configureLayout()
        bind()
        Task { await viewModel.load() }
    }

    private func configureLayout() {
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.spacing = Spacing.sm
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(scrollView)
        scrollView.addSubview(contentStack)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: Spacing.md),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.lg),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.md),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.md),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -Spacing.md * 2),
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

        if let error = state.error {
            contentStack.addArrangedSubview(messageLabel(error, color: Theme.Colors.error))
        }
        if let notice = state.notice {
            contentStack.addArrangedSubview(messageLabel(notice, color: Theme.Colors.primary))
        }

        if state.isLoading && state.providers.isEmpty {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            contentStack.addArrangedSubview(spinner)
            return
        }

        if state.providers.isEmpty {
            let empty = UILabel()
            empty.text = "还没有 Provider，点右上角「+ 新增」添加一个。"
            empty.font = Typography.body
            empty.textColor = Theme.Colors.textSecondary
            empty.textAlignment = .center
            empty.numberOfLines = 0
            empty.heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
            contentStack.addArrangedSubview(empty)
            return
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
        card.layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.xs),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.md),
        ])

        let header = UIStackView()
        header.axis = .horizontal
        header.alignment = .top
        header.spacing = Spacing.sm

        let titleStack = UIStackView()
        titleStack.axis = .vertical
        titleStack.spacing = 1
        let title = UILabel()
        title.text = provider.label.isEmpty ? provider.id : provider.label
        title.font = Typography.cardTitle
        title.textColor = Theme.Colors.textPrimary
        title.numberOfLines = 1
        titleStack.addArrangedSubview(title)
        if showProviderId(provider) {
            let id = UILabel()
            id.text = provider.id
            id.font = Typography.caption
            id.textColor = Theme.Colors.textMuted
            titleStack.addArrangedSubview(id)
        }
        header.addArrangedSubview(titleStack)

        let keyLabel = UILabel()
        keyLabel.text = provider.hasApiKey
            ? "● Key 已配置\(provider.apiKeySource.map { " · \($0)" } ?? "")"
            : "● 未配置 Key"
        keyLabel.font = Typography.caption
        keyLabel.textColor = provider.hasApiKey ? Theme.Colors.success : Theme.Colors.warning
        keyLabel.setContentHuggingPriority(.required, for: .horizontal)
        keyLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let headerSpacer = UIView()
        header.addArrangedSubview(headerSpacer)
        header.addArrangedSubview(keyLabel)
        stack.addArrangedSubview(header)

        let baseUrl = UILabel()
        baseUrl.text = provider.baseUrl
        baseUrl.font = Typography.code
        baseUrl.textColor = Theme.Colors.textSecondary
        baseUrl.numberOfLines = 1
        baseUrl.lineBreakMode = .byTruncatingMiddle
        stack.addArrangedSubview(baseUrl)

        let enabledModels = provider.models.filter { $0.enabled != false }.count
        let supportsImages = provider.models.contains { $0.supportsImages == true }
        var meta = "\(providerKindLabel(provider.kind))"
        if provider.builtin { meta += " · 内置" }
        meta += " · \(provider.models.count) 个模型 · 已启用 \(enabledModels) 个"
        if supportsImages { meta += " · 支持图片" }
        let metaLabel = UILabel()
        metaLabel.text = meta
        metaLabel.font = Typography.caption
        metaLabel.textColor = Theme.Colors.textSecondary
        metaLabel.numberOfLines = 0
        stack.addArrangedSubview(metaLabel)

        let divider = UIView()
        divider.backgroundColor = Theme.Colors.border
        divider.heightAnchor.constraint(equalToConstant: 1).isActive = true
        stack.addArrangedSubview(divider)

        let actions = UIStackView()
        actions.axis = .horizontal
        actions.alignment = .center
        actions.spacing = 2
        let edit = makeActionButton("编辑", color: Theme.Colors.primary)
        edit.addAction(UIAction { [weak self] _ in
            self?.viewModel.clearMessages()
            self?.presentEditor(provider: provider)
        }, for: .touchUpInside)
        let test = makeActionButton("测试", color: Theme.Colors.textPrimary)
        test.isEnabled = provider.hasApiKey && !busy
        test.addAction(UIAction { [weak self] _ in
            Task { await self?.viewModel.test(provider) }
        }, for: .touchUpInside)
        let refresh = makeActionButton("刷新", color: Theme.Colors.textPrimary)
        refresh.isEnabled = provider.hasApiKey && !busy
        refresh.addAction(UIAction { [weak self] _ in
            Task { await self?.viewModel.refreshModels(provider) }
        }, for: .touchUpInside)
        actions.addArrangedSubview(edit)
        actions.addArrangedSubview(test)
        actions.addArrangedSubview(refresh)
        let spacer = UIView()
        actions.addArrangedSubview(spacer)
        if !provider.builtin {
            let delete = makeActionButton("删除", color: Theme.Colors.error)
            delete.isEnabled = !busy
            delete.addAction(UIAction { [weak self] _ in
                self?.confirmDelete(provider)
            }, for: .touchUpInside)
            actions.addArrangedSubview(delete)
        }
        stack.addArrangedSubview(actions)
        return card
    }

    @objc private func addProvider() {
        viewModel.clearMessages()
        presentEditor(provider: nil)
    }

    private func presentEditor(provider: ProviderDto?) {
        let editor = ProviderEditorViewController(provider: provider)
        editor.onSave = { [weak self] draft in
            Task { await self?.viewModel.save(original: provider, draft: draft) }
        }
        let nav = UINavigationController(rootViewController: editor)
        nav.modalPresentationStyle = .pageSheet
        if let sheet = nav.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
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

    private func messageLabel(_ text: String, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.caption
        label.textColor = color
        label.numberOfLines = 0
        return label
    }

    private func makeActionButton(_ title: String, color: UIColor) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        configuration.baseForegroundColor = color
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 8, bottom: 5, trailing: 8)
        let button = UIButton(configuration: configuration)
        button.titleLabel?.font = Typography.caption
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
        if let provider {
            title = "编辑 \(provider.label.isEmpty ? provider.id : provider.label)"
        } else {
            title = "新增 Provider"
        }
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
        stack.spacing = Spacing.sm
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

        configureField(idField, placeholder: "my-provider")
        configureField(labelField, placeholder: "我的 Provider")
        configureField(baseUrlField, placeholder: "https://api.example.com")
        configureField(apiKeyField, placeholder: "可选，也可以稍后设置", secure: true)
        idField.autocapitalizationType = .none
        idField.autocorrectionType = .no
        baseUrlField.keyboardType = .URL

        stack.addArrangedSubview(sectionLabel("连接"))
        stack.addArrangedSubview(captionLabel("协议类型"))
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

        stack.addArrangedSubview(sectionLabel("模型目录"))
        stack.addArrangedSubview(captionLabel("模型 ID（每行一个）"))
        modelIdsView.font = Typography.code
        modelIdsView.textColor = Theme.Colors.textPrimary
        modelIdsView.backgroundColor = Theme.Colors.surface
        modelIdsView.layer.borderWidth = 1
        modelIdsView.layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor
        modelIdsView.layer.cornerRadius = Radius.card
        modelIdsView.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        modelIdsView.heightAnchor.constraint(equalToConstant: 130).isActive = true
        stack.addArrangedSubview(modelIdsView)
        stack.addArrangedSubview(
            captionLabel("已有模型会按 id 保留 Tools / 图片 / 上下文配置；新模型默认支持 Tools、不支持图片。")
        )
    }

    private func populate() {
        guard let provider else {
            kindControl.selectedSegmentIndex = 0
            clearKeyRow.isHidden = true
            return
        }
        idField.text = provider.id
        idField.isEnabled = false
        labelField.text = provider.label
        baseUrlField.text = provider.baseUrl
        kindControl.selectedSegmentIndex = provider.kind == "anthropic" ? 1 : 0
        apiKeyField.placeholder = provider.hasApiKey ? "已配置；留空不修改" : "未配置；输入新 Key"
        modelIdsView.text = provider.models.map(\.id).joined(separator: "\n")
        clearKeyRow.isHidden = !provider.hasApiKey
        clearKeySwitch.isOn = false
    }

    @objc private func saveTapped() {
        let id = (idField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let baseUrl = (baseUrlField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            presentValidation("Provider ID 不能为空")
            return
        }
        guard !baseUrl.isEmpty else {
            presentValidation("Base URL 不能为空")
            return
        }
        let draft = ProviderDraft(
            id: id,
            kind: kindControl.selectedSegmentIndex == 1 ? "anthropic" : "openai",
            label: labelField.text ?? "",
            baseUrl: baseUrl,
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

    private func presentValidation(_ message: String) {
        let alert = UIAlertController(title: "无法保存", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }

    private func configureField(_ field: UITextField, placeholder: String, secure: Bool = false) {
        field.placeholder = placeholder
        field.isSecureTextEntry = secure
        field.font = Typography.body
        field.textColor = Theme.Colors.textPrimary
        field.backgroundColor = Theme.Colors.surface
        field.layer.cornerRadius = Radius.card
        field.layer.borderWidth = 1
        field.layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        field.leftViewMode = .always
        field.heightAnchor.constraint(greaterThanOrEqualToConstant: 46).isActive = true
    }

    private func sectionLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = Typography.cardTitle
        label.textColor = Theme.Colors.textPrimary
        return label
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

private func providerKindLabel(_ kind: String) -> String {
    kind == "anthropic" ? "Anthropic" : "OpenAI-compatible"
}

private func normalizedProviderLabel(_ value: String) -> String {
    value.replacingOccurrences(of: #"[\s_-]+"#, with: "", options: .regularExpression).lowercased()
}

private func showProviderId(_ provider: ProviderDto) -> Bool {
    normalizedProviderLabel(provider.id)
        != normalizedProviderLabel(provider.label.isEmpty ? provider.id : provider.label)
}
