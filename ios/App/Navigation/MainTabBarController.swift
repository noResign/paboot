import UIKit

/// Persistent navigation stacks with one shared floating navigation style.
/// The selected conversation provides its own instance with composer switching.
final class MainTabBarController: UIViewController, UINavigationControllerDelegate {
    private let navigationControllers: [UINavigationController]
    private let contentView = UIView()
    private let bottomBar = ChatBottomBar(navigationOnly: true)
    private var activeIndex = 0
    private var isVisible = false

    var viewControllers: [UIViewController]? { navigationControllers }
    var selectedViewController: UIViewController? { navigationControllers[activeIndex] }
    var selectedIndex: Int {
        get { activeIndex }
        set {
            guard navigationControllers.indices.contains(newValue), newValue != activeIndex else { return }
            let previous = navigationControllers[activeIndex]
            activeIndex = newValue
            if isViewLoaded { displaySelected(previous: previous) }
        }
    }

    init(navigationControllers: [UINavigationController]? = nil) {
        self.navigationControllers = navigationControllers ?? [
            Self.makeNavigation(root: SessionsViewController()),
            Self.makeNavigation(root: FilesViewController()),
            Self.makeNavigation(root: SettingsViewController()),
        ]
        precondition(self.navigationControllers.count == 3)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.Colors.background
        contentView.frame = view.bounds
        contentView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(contentView)
        for navigation in navigationControllers {
            // Keep parentage stable across tabs: changing tabs must not detach a chat
            // stream or discard the navigation stack, input mode, or draft.
            addChild(navigation)
            navigation.delegate = self
            navigation.didMove(toParent: self)
        }
        bottomBar.onNavigate = { [weak self] destination in
            self?.selectedIndex = destination.rawValue
        }
        view.addSubview(bottomBar)
        let restingBottom = bottomBar.bottomAnchor.constraint(
            equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: ChatBottomBar.bottomOffset
        )
        restingBottom.priority = .defaultHigh
        NSLayoutConstraint.activate([
            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            restingBottom,
            bottomBar.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor),
        ])
        displaySelected(previous: nil)
    }

    // Only the selected stack receives appearance events, even though all stacks
    // remain children so that their state survives switching tabs.
    override var shouldAutomaticallyForwardAppearanceMethods: Bool { false }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        selectedViewController?.beginAppearanceTransition(true, animated: animated)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        selectedViewController?.endAppearanceTransition()
        isVisible = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        isVisible = false
        selectedViewController?.beginAppearanceTransition(false, animated: animated)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        selectedViewController?.endAppearanceTransition()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateBottomBar(for: navigationControllers[activeIndex].topViewController)
    }

    private func displaySelected(previous: UINavigationController?) {
        let current = navigationControllers[activeIndex]
        previous?.viewIfLoaded?.endEditing(true)
        if isVisible {
            previous?.beginAppearanceTransition(false, animated: false)
            current.beginAppearanceTransition(true, animated: false)
        }
        previous?.viewIfLoaded?.isHidden = true
        if current.view.superview !== contentView {
            current.view.frame = contentView.bounds
            current.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            contentView.addSubview(current.view)
        }
        current.view.isHidden = false
        updateBottomBar(for: current.topViewController)
        if isVisible {
            previous?.endAppearanceTransition()
            current.endAppearanceTransition()
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    private func updateBottomBar(for screen: UIViewController?) {
        let isChat = screen is ChatViewController
        bottomBar.isHidden = isChat
        bottomBar.setSelectedDestination(ChatBottomBar.Destination(rawValue: activeIndex)!)
        let navigation = navigationControllers[activeIndex]
        // Scroll views extend behind the transparent bar; safe-area insets keep
        // their final rows and fixed actions reachable above it.
        let offset = min(ChatBottomBar.bottomOffset, view.safeAreaInsets.bottom)
        let inset = isChat ? 0 : max(ChatBottomBar.minimumHeight, bottomBar.bounds.height) - offset
        if navigation.additionalSafeAreaInsets.bottom != inset {
            navigation.additionalSafeAreaInsets.bottom = inset
        }
    }

    func navigationController(_ navigationController: UINavigationController,
                              willShow viewController: UIViewController, animated: Bool) {
        guard navigationController === selectedViewController else { return }
        updateBottomBar(for: viewController)
    }

    func navigationController(_ navigationController: UINavigationController,
                              didShow viewController: UIViewController, animated: Bool) {
        guard navigationController === selectedViewController else { return }
        // Also restores the correct bar after an interactive back gesture cancels.
        updateBottomBar(for: viewController)
    }

    func navigateFromChat(to destination: ChatBottomBar.Destination) {
        selectedIndex = destination.rawValue
        if destination == .sessions {
            navigationControllers[activeIndex].popToRootViewController(animated: true)
        }
    }

    private static func makeNavigation(root: UIViewController) -> UINavigationController {
        let navigation = UINavigationController(rootViewController: root)
        navigation.navigationBar.standardAppearance = Theme.navigationBarAppearance()
        navigation.navigationBar.scrollEdgeAppearance = Theme.navigationBarAppearance()
        return navigation
    }

    override var childForStatusBarStyle: UIViewController? { selectedViewController }
    override var childForStatusBarHidden: UIViewController? { selectedViewController }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }
}
