import PabootProtocol
import UIKit

/// Mobile workspace switcher, aligned with the Android bottom sheet:
/// selected workspace highlighted, paths/session counts visible, overview action pinned.
final class WorkspaceSwitcherViewController: UIViewController {
    var onSelect: ((WorkspaceDto) -> Void)?
    var onOpenOverview: ((WorkspaceDto) -> Void)?
    var onDismiss: (() -> Void)?

    private let workspaces: [WorkspaceDto]
    private let selectedWorkspaceId: String?
    private var currentWorkspace: WorkspaceDto?

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let footerAction = UIView()
    private let handleArea = UIView()
    private let grabber = UIView()

    init(workspaces: [WorkspaceDto], selectedWorkspaceId: String?) {
        self.workspaces = workspaces
        self.selectedWorkspaceId = selectedWorkspaceId
        self.currentWorkspace = workspaces.first { $0.id == selectedWorkspaceId }
        super.init(nibName: nil, bundle: nil)
        // A custom bottom sheet instead of `.pageSheet`: iOS 26 renders partial
        // detents as inset floating cards, and this one must stay flush with the
        // screen edges at a content-fitted height.
        modalPresentationStyle = .custom
        transitioningDelegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.Colors.background
        view.layer.cornerRadius = Radius.sheet
        view.layer.cornerCurve = .continuous
        view.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        view.clipsToBounds = true
        configureLayout()
        // Added last so the grabber strip sits above the header and keeps its
        // full touch height.
        addGrabber()
    }

    private func addGrabber() {
        // Pull-to-dismiss only from the grabber strip: the list keeps the rest
        // of the sheet's vertical gestures for scrolling.
        handleArea.backgroundColor = .clear
        handleArea.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(handleArea)
        handleArea.addGestureRecognizer(
            UIPanGestureRecognizer(target: self, action: #selector(handleDismissPan))
        )

        grabber.backgroundColor = Theme.Colors.textMuted
        grabber.layer.cornerRadius = 2.5
        grabber.translatesAutoresizingMaskIntoConstraints = false
        handleArea.addSubview(grabber)

        NSLayoutConstraint.activate([
            handleArea.topAnchor.constraint(equalTo: view.topAnchor),
            handleArea.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            handleArea.widthAnchor.constraint(equalToConstant: 88),
            handleArea.heightAnchor.constraint(equalToConstant: 24),
            grabber.centerXAnchor.constraint(equalTo: handleArea.centerXAnchor),
            grabber.centerYAnchor.constraint(equalTo: handleArea.centerYAnchor),
            grabber.widthAnchor.constraint(equalToConstant: 36),
            grabber.heightAnchor.constraint(equalToConstant: 5),
        ])
    }

    @objc private func handleDismissPan(_ gesture: UIPanGestureRecognizer) {
        // Measure in the superview: the sheet itself moves under the finger.
        let translation = max(0, gesture.translation(in: view.superview).y)
        switch gesture.state {
        case .changed:
            view.transform = CGAffineTransform(translationX: 0, y: translation)
        case .ended, .cancelled:
            let velocity = gesture.velocity(in: view.superview).y
            if translation > 80 || velocity > 800 {
                dismiss(animated: true)
            } else {
                UIView.animate(
                    withDuration: 0.2,
                    delay: 0,
                    options: [.curveEaseOut]
                ) {
                    self.view.transform = .identity
                }
            }
        default:
            break
        }
    }

    /// Height this sheet needs so every row and the footer sit together with no
    /// dead space. Measured from a throwaway layout at the presentation width;
    /// the sheet otherwise defaults to `.large` and leaves a gap in the middle.
    func fittedHeight(forWidth width: CGFloat, bottomInset: CGFloat) -> CGFloat {
        view.frame = CGRect(x: 0, y: 0, width: width, height: 1000)
        view.layoutIfNeeded()
        return scrollView.frame.minY
            + scrollView.contentSize.height
            + Spacing.xs + 1 + Spacing.xs
            + footerAction.frame.height
            + Spacing.md
            + bottomInset
    }

    private func configureLayout() {
        let title = UILabel()
        title.text = "切换工作区"
        title.font = Typography.pageTitle
        title.textColor = Theme.Colors.textPrimary

        let subtitle = UILabel()
        subtitle.text = "选择会话、文件和设置所属的工作区"
        subtitle.font = Typography.caption
        subtitle.textColor = Theme.Colors.textSecondary
        subtitle.numberOfLines = 0

        let titleStack = UIStackView(arrangedSubviews: [title, subtitle])
        titleStack.axis = .vertical
        titleStack.spacing = 2
        titleStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let closeButton = UIButton(type: .system)
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = Theme.Colors.textSecondary
        closeButton.backgroundColor = Theme.Colors.textPrimary.withAlphaComponent(0.06)
        closeButton.layer.cornerRadius = 16
        closeButton.layer.cornerCurve = .continuous
        closeButton.accessibilityLabel = "关闭"
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.widthAnchor.constraint(equalToConstant: 32).isActive = true
        closeButton.heightAnchor.constraint(equalToConstant: 32).isActive = true
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        let header = UIStackView(arrangedSubviews: [titleStack, closeButton])
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = Spacing.sm
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        scrollView.showsVerticalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 8
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        let sectionHeader = makeSectionHeader()
        contentStack.addArrangedSubview(sectionHeader)

        for workspace in workspaces {
            let row = WorkspaceSwitcherRow(
                workspace: workspace,
                selected: workspace.id == selectedWorkspaceId
            )
            row.addAction(
                UIAction { [weak self] _ in
                    guard let self else { return }
                    self.onSelect?(workspace)
                },
                for: .touchUpInside
            )
            contentStack.addArrangedSubview(row)
        }

        let divider = UIView()
        divider.backgroundColor = Theme.Colors.border
        divider.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(divider)

        configureFooterAction()
        view.addSubview(footerAction)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Spacing.lg),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),

            scrollView.topAnchor.constraint(equalTo: header.bottomAnchor, constant: Spacing.md),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: divider.topAnchor, constant: -Spacing.xs),

            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -Spacing.sm),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: Spacing.lg),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -Spacing.lg),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -Spacing.lg * 2),

            divider.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            divider.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
            divider.heightAnchor.constraint(equalToConstant: 1),
            divider.bottomAnchor.constraint(equalTo: footerAction.topAnchor, constant: -Spacing.xs),

            footerAction.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Spacing.lg),
            footerAction.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Spacing.lg),
            footerAction.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -Spacing.md),
        ])
    }

    private func makeSectionHeader() -> UIView {
        let label = UILabel()
        label.text = "全部工作区"
        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary

        let count = makePill(
            "\(workspaces.count)",
            background: Theme.Colors.surface2,
            foreground: Theme.Colors.textSecondary
        )
        let row = UIStackView(arrangedSubviews: [label, UIView(), count])
        row.axis = .horizontal
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        row.heightAnchor.constraint(greaterThanOrEqualToConstant: 26).isActive = true
        return row
    }

    private func configureFooterAction() {
        footerAction.translatesAutoresizingMaskIntoConstraints = false
        footerAction.isAccessibilityElement = true
        footerAction.accessibilityTraits = .button
        footerAction.accessibilityLabel = "工作区概览"
        footerAction.accessibilityHint = "查看目录、知识入口和工作区信息"
        footerAction.isUserInteractionEnabled = currentWorkspace != nil
        footerAction.alpha = currentWorkspace == nil ? 0.5 : 1

        let iconBox = UIView()
        iconBox.backgroundColor = Theme.Colors.surface2
        iconBox.layer.cornerRadius = 10
        iconBox.layer.cornerCurve = .continuous
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        let icon = makeImage("info.circle", size: 19, tint: Theme.Colors.textSecondary)
        iconBox.addSubview(icon)
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 36),
            iconBox.heightAnchor.constraint(equalToConstant: 36),
            icon.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor),
        ])

        let title = UILabel()
        title.text = "工作区概览"
        title.font = Typography.cardTitle
        title.textColor = Theme.Colors.textPrimary

        let subtitle = UILabel()
        subtitle.text = "查看目录、知识入口和工作区信息"
        subtitle.font = Typography.caption
        subtitle.textColor = Theme.Colors.textSecondary
        subtitle.numberOfLines = 0

        let textStack = UIStackView(arrangedSubviews: [title, subtitle])
        textStack.axis = .vertical
        textStack.spacing = 1

        let chevron = makeImage("chevron.right", size: 15, tint: Theme.Colors.textSecondary)
        let row = UIStackView(arrangedSubviews: [iconBox, textStack, chevron])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Spacing.sm
        row.translatesAutoresizingMaskIntoConstraints = false
        footerAction.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: footerAction.topAnchor),
            row.bottomAnchor.constraint(equalTo: footerAction.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: footerAction.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: footerAction.trailingAnchor),
            footerAction.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
        ])

        footerAction.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(overviewTapped))
        )
    }

    @objc private func closeTapped() {
        onDismiss?()
    }

    @objc private func overviewTapped() {
        guard let currentWorkspace else { return }
        onOpenOverview?(currentWorkspace)
    }
}

extension WorkspaceSwitcherViewController: UIViewControllerTransitioningDelegate {
    func presentationController(
        forPresented presented: UIViewController,
        presenting: UIViewController?,
        source: UIViewController
    ) -> UIPresentationController? {
        WorkspaceSheetPresentationController(presentedViewController: presented, presenting: presenting)
    }

    func animationController(
        forPresented presented: UIViewController,
        presenting: UIViewController?,
        source: UIViewController
    ) -> UIViewControllerAnimatedTransitioning? {
        WorkspaceSheetSlideAnimator(isPresenting: true)
    }

    func animationController(
        forDismissed dismissed: UIViewController
    ) -> UIViewControllerAnimatedTransitioning? {
        WorkspaceSheetSlideAnimator(isPresenting: false)
    }
}

/// Bottom sheet that hugs the left, right and bottom screen edges while taking
/// only the content's height; the system page sheet insets partial detents.
private final class WorkspaceSheetPresentationController: UIPresentationController {
    private let dimmingView = UIView()

    /// Keep the session list visible behind the dimming view, like a sheet.
    override var shouldRemovePresentersView: Bool { false }

    override var frameOfPresentedViewInContainerView: CGRect {
        guard let containerView else { return .zero }
        let preferred = presentedViewController.preferredContentSize.height
        let height = preferred > 0
            ? min(preferred, containerView.bounds.height - 64)
            : containerView.bounds.height * 0.6
        return CGRect(
            x: 0,
            y: containerView.bounds.height - height,
            width: containerView.bounds.width,
            height: height
        )
    }

    override func presentationTransitionWillBegin() {
        guard let containerView else { return }
        dimmingView.backgroundColor = UIColor.black.withAlphaComponent(0.28)
        dimmingView.frame = containerView.bounds
        dimmingView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dimmingView.alpha = 0
        dimmingView.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(dimmingTapped))
        )
        containerView.addSubview(dimmingView)

        if let coordinator = presentedViewController.transitionCoordinator {
            coordinator.animate(alongsideTransition: { _ in self.dimmingView.alpha = 1 })
        } else {
            dimmingView.alpha = 1
        }
    }

    override func dismissalTransitionWillBegin() {
        if let coordinator = presentedViewController.transitionCoordinator {
            coordinator.animate(
                alongsideTransition: { _ in self.dimmingView.alpha = 0 },
                completion: { _ in self.dimmingView.removeFromSuperview() }
            )
        } else {
            dimmingView.removeFromSuperview()
        }
    }

    override func containerViewWillLayoutSubviews() {
        super.containerViewWillLayoutSubviews()
        // Don't stamp the final frame while the slide transition is running, or
        // while a grabber pan has the sheet translated.
        let isTranslated = presentedView.map { $0.transform != .identity } ?? false
        guard presentedViewController.transitionCoordinator == nil, !isTranslated else { return }
        presentedView?.frame = frameOfPresentedViewInContainerView
    }

    @objc private func dimmingTapped() {
        presentedViewController.dismiss(animated: true)
    }
}

private final class WorkspaceSheetSlideAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    private let isPresenting: Bool

    init(isPresenting: Bool) {
        self.isPresenting = isPresenting
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval {
        0.28
    }

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        let container = transitionContext.containerView
        let duration = transitionDuration(using: transitionContext)

        if isPresenting {
            guard let toView = transitionContext.view(forKey: .to),
                  let toController = transitionContext.viewController(forKey: .to) else {
                transitionContext.completeTransition(false)
                return
            }
            container.addSubview(toView)
            let final = transitionContext.finalFrame(for: toController)
            toView.frame = final.offsetBy(dx: 0, dy: final.height)
            UIView.animate(
                withDuration: duration,
                delay: 0,
                options: [.curveEaseOut]
            ) {
                toView.frame = final
            } completion: { _ in
                transitionContext.completeTransition(!transitionContext.transitionWasCancelled)
            }
        } else {
            guard let fromView = transitionContext.view(forKey: .from) else {
                transitionContext.completeTransition(false)
                return
            }
            // Animate the transform so a partially dragged sheet continues
            // smoothly from wherever the pan left it.
            let height = transitionContext.containerView.bounds.height
            UIView.animate(
                withDuration: duration,
                delay: 0,
                options: [.curveEaseIn]
            ) {
                fromView.transform = CGAffineTransform(translationX: 0, y: height)
            } completion: { _ in
                transitionContext.completeTransition(!transitionContext.transitionWasCancelled)
            }
        }
    }
}

/// A single tappable workspace card in the switcher.
private final class WorkspaceSwitcherRow: UIControl {
    init(workspace: WorkspaceDto, selected: Bool) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = selected ? Theme.Colors.primarySubtle : Theme.Colors.surface
        layer.cornerRadius = 14
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = (
            selected ? Theme.Colors.primary.withAlphaComponent(0.45) : Theme.Colors.border
        ).cgColor
        layer.masksToBounds = true
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = "\(workspace.displayName)，\(workspace.sessionCount) 个会话"
        if selected { accessibilityValue = "当前工作区" }
        heightAnchor.constraint(greaterThanOrEqualToConstant: 62).isActive = true

        let iconBox = UIView()
        iconBox.backgroundColor = workspace.family == "life"
            ? Theme.Colors.primarySubtle
            : Theme.Colors.surface2
        iconBox.layer.cornerRadius = 10
        iconBox.layer.cornerCurve = .continuous
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        let icon = makeImage(
            workspace.family == "life" ? "person.fill" : "folder.fill",
            size: 19,
            tint: workspace.family == "life" ? Theme.Colors.primaryDeep : Theme.Colors.textSecondary
        )
        iconBox.addSubview(icon)
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 36),
            iconBox.heightAnchor.constraint(equalToConstant: 36),
            icon.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor),
        ])

        let name = UILabel()
        name.text = workspace.displayName
        name.font = Typography.cardTitle
        name.textColor = Theme.Colors.textPrimary
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var textViews: [UIView] = [name]
        if let visiblePath = workspace.displayPath {
            let path = UILabel()
            path.text = visiblePath
            path.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(
                for: .monospacedSystemFont(ofSize: 12, weight: .regular)
            )
            path.textColor = Theme.Colors.textSecondary
            path.lineBreakMode = .byTruncatingMiddle
            path.numberOfLines = 1
            textViews.append(path)
        }

        let textStack = UIStackView(arrangedSubviews: textViews)
        textStack.axis = .vertical
        textStack.spacing = 2
        textStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let check = UIImageView(
            image: UIImage(systemName: selected ? "checkmark.circle.fill" : "circle")
        )
        check.tintColor = selected ? Theme.Colors.primary : Theme.Colors.textMuted
        check.contentMode = .scaleAspectFit
        check.translatesAutoresizingMaskIntoConstraints = false
        check.widthAnchor.constraint(equalToConstant: 22).isActive = true
        check.heightAnchor.constraint(equalToConstant: 22).isActive = true

        let count = UILabel()
        count.text = "\(workspace.sessionCount) 会话"
        count.font = Typography.caption
        count.textColor = Theme.Colors.textSecondary
        count.textAlignment = .right

        let trailing = UIStackView(arrangedSubviews: [check, count])
        trailing.axis = .vertical
        trailing.alignment = .trailing
        trailing.spacing = 4
        trailing.setContentHuggingPriority(.required, for: .horizontal)
        trailing.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = UIStackView(arrangedSubviews: [iconBox, textStack, trailing])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Spacing.sm
        row.isUserInteractionEnabled = false
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 11),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -11),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // `point` is the parameter here, so the UIView method needs `self.`.
        guard isUserInteractionEnabled && !isHidden && alpha > 0.01 && self.point(inside: point, with: event) else {
            return nil
        }
        return self
    }
}

private func makeImage(_ systemName: String, size: CGFloat, tint: UIColor) -> UIImageView {
    let image = UIImageView(image: UIImage(systemName: systemName))
    image.tintColor = tint
    image.contentMode = .scaleAspectFit
    image.translatesAutoresizingMaskIntoConstraints = false
    image.widthAnchor.constraint(equalToConstant: size).isActive = true
    image.heightAnchor.constraint(equalToConstant: size).isActive = true
    return image
}

private func makePill(_ text: String, background: UIColor, foreground: UIColor) -> UIView {
    let label = UILabel()
    label.text = text
    label.font = Typography.caption
    label.textColor = foreground
    label.translatesAutoresizingMaskIntoConstraints = false

    let pill = UIView()
    pill.backgroundColor = background
    pill.layer.cornerRadius = 10
    pill.layer.cornerCurve = .continuous
    pill.translatesAutoresizingMaskIntoConstraints = false
    pill.setContentHuggingPriority(.required, for: .horizontal)
    pill.setContentCompressionResistancePriority(.required, for: .horizontal)
    pill.addSubview(label)
    NSLayoutConstraint.activate([
        label.topAnchor.constraint(equalTo: pill.topAnchor, constant: 2),
        label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -2),
        label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 8),
        label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -8),
    ])
    return pill
}
