import PabootProtocol
import UIKit

/// Keeps answers in place while the daemon validates a permission decision.
final class UserInputViewController: UIViewController {
    var onDecision: ((String, JSONValue?) -> Void)?

    private let request: UserInputRequest
    private let stack = UIStackView()
    private let errorLabel = UILabel()
    private let submitButton = UIButton(type: .system)
    private var textFields: [String: UITextField] = [:]
    private var controls: [UIControl] = []

    init(input: JSONValue?) {
        request = UserInputRequest(input)
        super.init(nibName: nil, bundle: nil)
        isModalInPresentation = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "需要你的回答"
        view.backgroundColor = Theme.Colors.background
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "拒绝", style: .plain, target: self, action: #selector(deny)
        )

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        stack.axis = .vertical
        stack.spacing = Spacing.md
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Spacing.md),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Spacing.md),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -Spacing.md),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -Spacing.md * 2),
        ])

        if let message = request.message { addLabel(message) }
        for field in request.fields {
            addLabel(field.title + (field.required ? " *" : "（可选）"))
            if let description = field.description { addLabel(description) }
            let text = UITextField()
            text.borderStyle = .roundedRect
            text.font = Typography.body
            text.isSecureTextEntry = field.secret
            text.autocorrectionType = .no
            text.autocapitalizationType = .none
            switch field.type {
            case "boolean": text.placeholder = "true 或 false"
            case "number", "integer": text.placeholder = "数字"
            case "array": text.placeholder = "JSON 数组，如 [\"A\",\"B\"]"
            default: text.placeholder = "填写回答"
            }
            text.heightAnchor.constraint(greaterThanOrEqualToConstant: Layout.minTouchTarget).isActive = true
            stack.addArrangedSubview(text)
            textFields[field.id] = text
            controls.append(text)
            if !field.options.isEmpty {
                if field.type == "array" {
                    addLabel("可选值：" + field.options.joined(separator: "、"))
                } else {
                    let choices = UIButton(type: .system)
                    choices.setTitle("选择建议答案", for: .normal)
                    choices.showsMenuAsPrimaryAction = true
                    choices.menu = UIMenu(children: field.options.map { option in
                        UIAction(title: option) { [weak text] _ in text?.text = option }
                    })
                    stack.addArrangedSubview(choices)
                    controls.append(choices)
                }
            }
        }

        if request.kind == "url" {
            addLabel(request.url ?? "未提供链接")
            let open = UIButton(type: .system)
            open.setTitle("打开链接", for: .normal)
            let url = request.url.flatMap(URL.init(string:))
            open.isEnabled = url.map { ["http", "https"].contains($0.scheme?.lowercased() ?? "") } ?? false
            open.addAction(UIAction { _ in
                guard let url else { return }
                UIApplication.shared.open(url)
            }, for: .touchUpInside)
            stack.addArrangedSubview(open)
            addLabel("请在浏览器完成操作后再确认。")
        } else if !request.canSubmit {
            addLabel("暂不支持这种验证方式，请拒绝请求。")
        }

        errorLabel.numberOfLines = 0
        errorLabel.textColor = Theme.Colors.error
        errorLabel.font = Typography.body
        errorLabel.isHidden = true
        stack.addArrangedSubview(errorLabel)
        submitButton.setTitle("提交回答", for: .normal)
        submitButton.heightAnchor.constraint(greaterThanOrEqualToConstant: Layout.minTouchTarget).isActive = true
        submitButton.addAction(UIAction { [weak self] _ in self?.submit() }, for: .touchUpInside)
        stack.addArrangedSubview(submitButton)
        submitButton.isEnabled = request.canSubmit
    }

    func update(submitting: Bool, error: String?) {
        loadViewIfNeeded()
        controls.forEach { $0.isEnabled = !submitting }
        navigationItem.leftBarButtonItem?.isEnabled = !submitting
        submitButton.isEnabled = request.canSubmit && !submitting
        submitButton.setTitle(submitting ? "提交中…" : "提交回答", for: .normal)
        if submitting || error != nil { showError(error) }
    }

    private func addLabel(_ text: String) {
        let label = UILabel()
        label.text = text
        label.font = Typography.body
        label.textColor = Theme.Colors.textPrimary
        label.numberOfLines = 0
        stack.addArrangedSubview(label)
    }

    private func showError(_ message: String?) {
        errorLabel.text = message
        errorLabel.isHidden = message == nil
    }

    private func submit() {
        do {
            let response = try request.response(values: textFields.mapValues { $0.text ?? "" })
            showError(nil)
            onDecision?("allow", response)
        } catch {
            showError(error.localizedDescription)
        }
    }

    @objc private func deny() { onDecision?("deny", nil) }
}
