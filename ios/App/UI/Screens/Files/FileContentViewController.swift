import Combine
import UIKit

/// Read-only file viewer: text, image, or an explicit "not supported" message.
final class FileContentViewController: UIViewController {
    private let viewModel: FileContentViewModel
    private var cancellables = Set<AnyCancellable>()

    private let bannerLabel = UILabel()
    private let contentContainer = UIView()
    private let fileTextView = FileTextView()
    private let imageView = UIImageView()
    private let stateContainer = UIView()
    private let loadingStack = UIStackView()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private var emptyStateView: EmptyStateView?
    private var wrapsText = true
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
        view.backgroundColor = Theme.Editor.background
        configureContent()
        bind()

        Task { await viewModel.load() }
    }

    private func configureContent() {
        bannerLabel.font = Typography.caption
        bannerLabel.textColor = Theme.Colors.warning
        bannerLabel.numberOfLines = 0
        bannerLabel.isHidden = true

        fileTextView.translatesAutoresizingMaskIntoConstraints = false
        fileTextView.isHidden = true

        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.isHidden = true

        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(fileTextView)
        contentContainer.addSubview(imageView)

        let stack = UIStackView(arrangedSubviews: [bannerLabel, contentContainer])
        stack.axis = .vertical
        stack.spacing = 0
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
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            fileTextView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            fileTextView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
            fileTextView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            fileTextView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),

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

    @objc private func toggleWrapping() {
        wrapsText.toggle()
        wrapItem.title = wrapsText ? "不换行" : "自动换行"
        fileTextView.setWrapping(wrapsText)
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
            fileTextView.isHidden = true
            imageView.isHidden = true
            stateContainer.isHidden = false
            showLoading()
            return
        }

        if let error = state.error {
            fileTextView.isHidden = true
            imageView.isHidden = true
            stateContainer.isHidden = false
            showEmpty(title: "加载失败", message: error, retry: true)
            return
        }

        guard let content = state.content else {
            fileTextView.isHidden = true
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
            fileTextView.isHidden = false
            fileTextView.setText(file.content)
            navigationItem.rightBarButtonItem = wrapItem
            wrapItem.isEnabled = true

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

            fileTextView.isHidden = true
            imageView.isHidden = false
            imageView.image = image
            bannerLabel.isHidden = true
        case .unsupported(let message):
            fileTextView.isHidden = true
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

/// Orthogonal native scroll views: the outer view owns horizontal motion and the
/// text view owns vertical motion/selection. Width is explicit, not a text-container side effect.
final class FileTextView: UIView {
    private let horizontalScrollView = FileHorizontalScrollView()
    private let textView = FileVerticalTextView()
    private var preferredWidth: NSLayoutConstraint!
    private var wrapsText = true
    private var naturalWidth: CGFloat = 0
    private var measuredFont: UIFont?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.Editor.background
        horizontalScrollView.backgroundColor = Theme.Editor.background
        horizontalScrollView.translatesAutoresizingMaskIntoConstraints = false
        horizontalScrollView.contentInsetAdjustmentBehavior = .never
        horizontalScrollView.isDirectionalLockEnabled = true
        horizontalScrollView.showsVerticalScrollIndicator = false
        horizontalScrollView.showsHorizontalScrollIndicator = false
        addSubview(horizontalScrollView)

        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.alwaysBounceVertical = true
        textView.showsHorizontalScrollIndicator = false
        textView.contentInsetAdjustmentBehavior = .never
        textView.backgroundColor = Theme.Editor.background
        textView.textColor = Theme.Editor.text
        textView.font = Typography.code
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        textView.textContainer.lineFragmentPadding = 0
        textView.textContainer.widthTracksTextView = true
        horizontalScrollView.addSubview(textView)

        // The required minimum fills the viewport. This lower-priority width expands
        // to the longest line in no-wrap mode, producing real horizontal content width.
        preferredWidth = textView.widthAnchor.constraint(equalToConstant: 0)
        preferredWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            horizontalScrollView.topAnchor.constraint(equalTo: topAnchor),
            horizontalScrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            horizontalScrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            horizontalScrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            textView.topAnchor.constraint(equalTo: horizontalScrollView.contentLayoutGuide.topAnchor),
            textView.bottomAnchor.constraint(equalTo: horizontalScrollView.contentLayoutGuide.bottomAnchor),
            textView.leadingAnchor.constraint(equalTo: horizontalScrollView.contentLayoutGuide.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: horizontalScrollView.contentLayoutGuide.trailingAnchor),
            textView.heightAnchor.constraint(equalTo: horizontalScrollView.frameLayoutGuide.heightAnchor),
            textView.widthAnchor.constraint(greaterThanOrEqualTo: horizontalScrollView.frameLayoutGuide.widthAnchor),
            preferredWidth,
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setText(_ text: String) {
        textView.text = text
        measureText()
        textView.setContentOffset(.zero, animated: false)
        horizontalScrollView.setContentOffset(.zero, animated: false)
    }

    func setWrapping(_ wraps: Bool) {
        wrapsText = wraps
        textView.textContainer.lineBreakMode = wraps ? .byWordWrapping : .byClipping
        horizontalScrollView.showsHorizontalScrollIndicator = !wraps
        preferredWidth.constant = wraps ? 0 : naturalWidth
        horizontalScrollView.setContentOffset(.zero, animated: false)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        // Re-measure only when Dynamic Type changes the font, never on every scroll frame.
        if textView.font != measuredFont { measureText() }
        super.layoutSubviews()
    }

    private func measureText() {
        let font = textView.font ?? Typography.code
        measuredFont = font
        naturalWidth = (textView.text ?? "").components(separatedBy: "\n").reduce(CGFloat(0)) {
            max($0, ceil(($1 as NSString).size(withAttributes: [.font: font]).width) + 2)
        } + textView.textContainerInset.left + textView.textContainerInset.right
        preferredWidth.constant = wrapsText ? 0 : naturalWidth
        setNeedsLayout()
    }
}

/// Route a sideways drag to the horizontal container rather than the text selection scroller.
private final class FileVerticalTextView: UITextView {
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let velocity = panGestureRecognizer.velocity(in: self)
            if abs(velocity.x) > abs(velocity.y) { return false }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}

private final class FileHorizontalScrollView: UIScrollView {
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let velocity = panGestureRecognizer.velocity(in: self)
            guard contentSize.width > bounds.width,
                  abs(velocity.x) > abs(velocity.y) else { return false }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}
