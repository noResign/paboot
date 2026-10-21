import Combine
import UIKit

/// Read-only file viewer: text, image, or an explicit "not supported" message.
final class FileContentViewController: UIViewController {
    private let viewModel: FileContentViewModel
    private var cancellables = Set<AnyCancellable>()

    private let bannerLabel = UILabel()
    private let contentContainer = UIView()
    private let textView = UITextView()
    private let imageView = UIImageView()
    private let stateContainer = UIView()
    private let loadingStack = UIStackView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private var emptyStateView: EmptyStateView?
    private var wrapsText = true
    private var unwrappedTextWidth: CGFloat = 0
    private var lastTextViewportWidth: CGFloat = 0
    private lazy var wrapItem = UIBarButtonItem(
        title: "不换行", style: .plain, target: self, action: #selector(toggleWrapping)
    )

    init(workspaceId: String?, root: String?, path: String) {
        self.viewModel = FileContentViewModel(workspaceId: workspaceId, root: root, path: path)
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
        textView.contentInsetAdjustmentBehavior = .never
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        textView.textContainer.lineFragmentPadding = 0
        textView.font = Typography.code
        textView.layer.cornerRadius = Radius.card
        textView.clipsToBounds = true
        textView.adjustsFontForContentSizeCategory = true
        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.isHidden = true

        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.isHidden = true

        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(textView)
        contentContainer.addSubview(imageView)

        let stack = UIStackView(arrangedSubviews: [bannerLabel, contentContainer])
        stack.axis = .vertical
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        loadingSpinner.color = Theme.Colors.textSecondary
        loadingLabel.text = "正在加载文件…"
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

            imageView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            imageView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            stateContainer.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            stateContainer.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            stateContainer.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            stateContainer.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

            loadingStack.centerXAnchor.constraint(equalTo: stateContainer.centerXAnchor),
            loadingStack.centerYAnchor.constraint(equalTo: stateContainer.centerYAnchor),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = textView.bounds.width
        guard abs(width - lastTextViewportWidth) > 0.5 else { return }
        lastTextViewportWidth = width
        applyTextWrapping()
    }

    @objc private func toggleWrapping() {
        wrapsText.toggle()
        wrapItem.title = wrapsText ? "不换行" : "自动换行"
        applyTextWrapping()
    }

    private func applyTextWrapping() {
        let viewport = textView.bounds.width - textView.textContainerInset.left - textView.textContainerInset.right
        guard viewport > 0 else { return }
        let verticalOffset = textView.contentOffset.y
        textView.textContainer.widthTracksTextView = wrapsText
        textView.textContainer.lineBreakMode = wrapsText ? .byWordWrapping : .byClipping
        textView.textContainer.size = CGSize(
            width: wrapsText ? viewport : max(viewport, unwrappedTextWidth),
            height: .greatestFiniteMagnitude
        )
        textView.alwaysBounceHorizontal = !wrapsText && unwrappedTextWidth > viewport
        textView.showsHorizontalScrollIndicator = !wrapsText
        textView.setNeedsLayout()
        textView.layoutIfNeeded()
        let maxY = max(0, textView.contentSize.height - textView.bounds.height)
        textView.setContentOffset(CGPoint(x: 0, y: min(max(verticalOffset, 0), maxY)), animated: false)
    }

    private func bind() {
        viewModel.$state
            .sink { [weak self] state in
                self?.render(state)
            }
            .store(in: &cancellables)
    }

    private func render(_ state: FileContentViewModel.State) {
        navigationItem.rightBarButtonItem = nil
        wrapItem.isEnabled = false
        if state.isLoading {
            textView.isHidden = true
            imageView.isHidden = true
            stateContainer.isHidden = false
            showLoading()
            return
        }

        if let error = state.error {
            textView.isHidden = true
            imageView.isHidden = true
            stateContainer.isHidden = false
            showEmpty(title: "加载失败", message: error, retry: true)
            return
        }

        guard let content = state.content else {
            textView.isHidden = true
            imageView.isHidden = true
            stateContainer.isHidden = false
            showEmpty(title: "没有可显示的内容", message: nil, retry: false)
            return
        }

        switch content {
        case .text(let file):
            stateContainer.isHidden = true
            emptyStateView?.removeFromSuperview()
            emptyStateView = nil
            loadingSpinner.stopAnimating()
            loadingStack.isHidden = true

            imageView.isHidden = true
            textView.isHidden = false
            textView.text = file.content
            let attributes: [NSAttributedString.Key: Any] = [.font: textView.font ?? Typography.code]
            unwrappedTextWidth = file.content.components(separatedBy: "\n").reduce(CGFloat(0)) {
                max($0, ceil(($1 as NSString).size(withAttributes: attributes).width) + 2)
            }
            navigationItem.rightBarButtonItem = wrapItem
            wrapItem.isEnabled = true
            applyTextWrapping()
            textView.setContentOffset(.zero, animated: false)

            if file.truncated {
                bannerLabel.text = "内容过大，已截断（仅显示前 1 MB）"
                bannerLabel.isHidden = false
            } else {
                bannerLabel.isHidden = true
            }
        case .image(let image):
            stateContainer.isHidden = true
            emptyStateView?.removeFromSuperview()
            emptyStateView = nil
            loadingSpinner.stopAnimating()
            loadingStack.isHidden = true

            textView.isHidden = true
            imageView.isHidden = false
            imageView.image = image
            bannerLabel.isHidden = true
        case .unsupported(let message):
            textView.isHidden = true
            imageView.isHidden = true
            stateContainer.isHidden = false
            showEmpty(title: message, message: nil, retry: false)
        }
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
            symbolName: "doc",
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
}
