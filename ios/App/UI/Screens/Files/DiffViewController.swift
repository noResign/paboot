import Combine
import PabootProtocol
import UIKit

/// Side-by-side (default) or unified diff for one changed file.
final class DiffViewController: UIViewController {
    private let viewModel: DiffViewModel
    private let status: String
    private var cancellables = Set<AnyCancellable>()

    private let bannerLabel = UILabel()
    private let contentContainer = UIView()
    private let textView = UITextView()
    private let splitView = SplitDiffView()
    private let stateContainer = UIView()
    private let loadingStack = UIStackView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private var emptyStateView: EmptyStateView?

    private var isSplit = true
    private var currentPatch = ""
    private var unifiedBuilt = false

    private lazy var modeItem = UIBarButtonItem(
        title: "统一",
        style: .plain,
        target: self,
        action: #selector(toggleMode)
    )

    private lazy var fullTextItem = UIBarButtonItem(
        title: "全文",
        style: .plain,
        target: self,
        action: #selector(openFullText)
    )

    init(workspaceId: String?, root: String?, path: String, status: String) {
        self.viewModel = DiffViewModel(workspaceId: workspaceId, root: root, path: path)
        self.status = status
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        title = FilePathDisplay.fileName(viewModel.path)
        view.backgroundColor = Theme.Colors.background

        var items: [UIBarButtonItem] = [modeItem]
        if status != "deleted" {
            items.append(fullTextItem)
        }
        navigationItem.rightBarButtonItems = items
        modeItem.isEnabled = false

        configureContent()
        bind()

        Task { await viewModel.load() }
    }

    private func configureContent() {
        bannerLabel.font = Typography.caption
        bannerLabel.textColor = Theme.Colors.warning
        bannerLabel.numberOfLines = 0
        bannerLabel.isHidden = true

        textView.isEditable = false
        textView.isSelectable = true
        textView.alwaysBounceVertical = true
        textView.backgroundColor = Theme.Editor.background
        textView.textColor = Theme.Editor.text
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        textView.textContainer.lineFragmentPadding = 0
        textView.font = Typography.code
        textView.layer.cornerRadius = Radius.card
        textView.clipsToBounds = true
        textView.adjustsFontForContentSizeCategory = true
        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.isHidden = true

        splitView.layer.cornerRadius = Radius.card
        splitView.clipsToBounds = true
        splitView.translatesAutoresizingMaskIntoConstraints = false
        splitView.isHidden = true

        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(textView)
        contentContainer.addSubview(splitView)

        let stack = UIStackView(arrangedSubviews: [bannerLabel, contentContainer])
        stack.axis = .vertical
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        loadingSpinner.color = Theme.Colors.textSecondary
        loadingLabel.text = "正在加载 diff…"
        loadingLabel.font = Typography.body
        loadingLabel.textColor = Theme.Colors.textSecondary

        loadingStack.axis = .vertical
        loadingStack.alignment = .center
        loadingStack.spacing = Spacing.sm
        loadingStack.addArrangedSubview(loadingSpinner)
        loadingStack.addArrangedSubview(loadingLabel)
        loadingStack.translatesAutoresizingMaskIntoConstraints = false
        loadingStack.isHidden = true
        stateContainer.addSubview(loadingStack)

        stateContainer.translatesAutoresizingMaskIntoConstraints = false
        stateContainer.isHidden = true
        view.addSubview(stateContainer)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Spacing.xs),
            stack.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -Spacing.xs
            ),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.md),

            textView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            textView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            textView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            splitView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            splitView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            splitView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            splitView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            stateContainer.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            stateContainer.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            stateContainer.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            stateContainer.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            loadingStack.centerXAnchor.constraint(equalTo: stateContainer.centerXAnchor),
            loadingStack.centerYAnchor.constraint(equalTo: stateContainer.centerYAnchor),
        ])
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: DiffViewModel.State) {
        if state.isLoading {
            hideDiffContent()
            stateContainer.isHidden = false
            modeItem.isEnabled = false
            showLoading()
            return
        }

        if let error = state.error {
            hideDiffContent()
            stateContainer.isHidden = false
            modeItem.isEnabled = false
            showEmpty(title: "加载失败", message: error, retry: true)
            return
        }

        guard let diff = state.diff else {
            hideDiffContent()
            stateContainer.isHidden = false
            modeItem.isEnabled = false
            showEmpty(title: "没有可显示的 diff", message: nil, retry: false)
            return
        }

        if diff.binary {
            hideDiffContent()
            stateContainer.isHidden = false
            modeItem.isEnabled = false
            showEmpty(title: "暂不支持预览二进制文件", message: nil, retry: false)
            return
        }

        if diff.patch.isEmpty {
            hideDiffContent()
            stateContainer.isHidden = false
            modeItem.isEnabled = false
            showEmpty(title: "没有可显示的 diff", message: nil, retry: false)
            return
        }

        stateContainer.isHidden = true
        emptyStateView?.removeFromSuperview()
        emptyStateView = nil
        loadingSpinner.stopAnimating()
        loadingStack.isHidden = true

        currentPatch = diff.patch
        unifiedBuilt = false
        splitView.configure(rows: SplitDiff.parse(diff.patch))
        modeItem.isEnabled = true
        modeItem.title = isSplit ? "统一" : "并排"

        var notes: [String] = []
        if diff.truncated {
            notes.append("内容过大，已截断")
        }
        if let oldPath = diff.oldPath, oldPath != diff.path {
            notes.append("旧路径：\(oldPath)")
        }
        bannerLabel.text = notes.joined(separator: " · ")
        bannerLabel.isHidden = notes.isEmpty

        applyModeVisibility()
    }

    private func hideDiffContent() {
        textView.isHidden = true
        splitView.isHidden = true
        bannerLabel.isHidden = true
    }

    private func applyModeVisibility() {
        textView.isHidden = isSplit
        splitView.isHidden = !isSplit

        if !isSplit {
            ensureUnifiedText()
        }
    }

    private func ensureUnifiedText() {
        guard !unifiedBuilt else { return }
        textView.attributedText = attributedPatch(currentPatch)
        textView.setContentOffset(.zero, animated: false)
        unifiedBuilt = true
    }

    private func showLoading() {
        emptyStateView?.removeFromSuperview()
        emptyStateView = nil
        loadingStack.isHidden = false
        loadingSpinner.startAnimating()
    }

    private func showEmpty(title: String, message: String?, retry: Bool) {
        loadingSpinner.stopAnimating()
        loadingStack.isHidden = true
        emptyStateView?.removeFromSuperview()

        var action: (() -> Void)?
        if retry {
            action = { [weak self] in Task { await self?.viewModel.load() } }
        }

        let empty = EmptyStateView(
            symbolName: "doc.text",
            title: title,
            message: message,
            actionTitle: retry ? "重试" : nil,
            onAction: action
        )
        empty.translatesAutoresizingMaskIntoConstraints = false
        stateContainer.addSubview(empty)
        NSLayoutConstraint.activate([
            empty.topAnchor.constraint(equalTo: stateContainer.topAnchor),
            empty.bottomAnchor.constraint(equalTo: stateContainer.bottomAnchor),
            empty.leadingAnchor.constraint(equalTo: stateContainer.leadingAnchor),
            empty.trailingAnchor.constraint(equalTo: stateContainer.trailingAnchor),
        ])
        emptyStateView = empty
    }

    private func attributedPatch(_ patch: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let lines = patch.components(separatedBy: "\n")

        for (index, line) in lines.enumerated() {
            var attributes: [NSAttributedString.Key: Any] = [
                .font: Typography.code,
                .foregroundColor: color(for: line),
            ]
            if line.hasPrefix("@@") {
                attributes[.backgroundColor] = Theme.Editor.hunkBackground
            }

            let text = index == lines.count - 1 ? line : line + "\n"
            result.append(NSAttributedString(string: text, attributes: attributes))
        }

        return result
    }

    private func color(for line: String) -> UIColor {
        if line.hasPrefix("@@") {
            return Theme.Editor.hunk
        }
        if line.hasPrefix("+++")
            || line.hasPrefix("---")
            || line.hasPrefix("diff ")
            || line.hasPrefix("index ")
            || line.hasPrefix("new file")
            || line.hasPrefix("deleted file")
            || line.hasPrefix("old mode")
            || line.hasPrefix("new mode")
            || line.hasPrefix("similarity index")
            || line.hasPrefix("rename ")
            || line.hasPrefix("Binary files") {
            return Theme.Editor.muted
        }
        if line.hasPrefix("+") {
            return Theme.Editor.added
        }
        if line.hasPrefix("-") {
            return Theme.Editor.deleted
        }
        return Theme.Editor.text
    }

    @objc private func toggleMode() {
        guard modeItem.isEnabled else { return }

        isSplit.toggle()
        modeItem.title = isSplit ? "统一" : "并排"
        applyModeVisibility()
    }

    @objc private func openFullText() {
        let controller = FileContentViewController(
            workspaceId: viewModel.workspaceId,
            root: viewModel.root,
            path: viewModel.path
        )
        navigationController?.pushViewController(controller, animated: true)
    }
}
