import UIKit

/// Switches between the connect screen and the main tabs.
///
/// Keeping this out of `SceneDelegate` means an expired token discovered deep in a screen
/// can send the app back to the connect flow without knowing about the window.
@MainActor
final class AppRouter {
    static let shared = AppRouter()

    private weak var window: UIWindow?

    private init() {}

    func start(in window: UIWindow) {
        self.window = window
        // Cold start with a saved connection enters the main tabs directly, matching
        // Android's gate. An expired token is not caught here — the session list shows
        // the error and offers「重新连接」.
        if let recent = ConnectionStore.shared.savedConnections.first,
           DaemonSession.shared.activate(recent) != nil {
            showMain(animated: false)
            return
        }
        showConnect(animated: false)
    }

    func showConnect(animated: Bool = true) {
        RunNotifications.shared.resetConnection()
        DaemonSession.shared.deactivate()

        let viewModel = ConnectViewModel()
        let connect = ConnectViewController(viewModel: viewModel)
        viewModel.onConnected = { _ in
            AppRouter.shared.showMain()
        }

        let navigation = UINavigationController(rootViewController: connect)
        navigation.navigationBar.standardAppearance = Theme.navigationBarAppearance()
        navigation.navigationBar.scrollEdgeAppearance = Theme.navigationBarAppearance()
        navigation.setNavigationBarHidden(true, animated: false)
        setRoot(navigation, animated: animated)
    }

    func showMain(animated: Bool = true) {
        setRoot(MainTabBarController(), animated: animated)
        RunNotifications.shared.connectionActivated()
    }

    func isViewingSession(_ id: String) -> Bool {
        guard let tabs = window?.rootViewController as? MainTabBarController,
              let navigation = tabs.selectedViewController as? UINavigationController,
              let chat = navigation.topViewController as? ChatViewController else { return false }
        return chat.sessionIdentifier == id
    }

    func openSession(id: String, connectionId: String) {
        guard DaemonSession.shared.connection?.id == connectionId,
              let tabs = window?.rootViewController as? MainTabBarController else { return }
        let open = { [weak tabs] in
            guard let tabs, DaemonSession.shared.connection?.id == connectionId,
                  let navigation = tabs.viewControllers?.first as? UINavigationController else { return }
            tabs.selectedIndex = 0
            RunNotifications.shared.clearSession(id)
            if let chat = navigation.topViewController as? ChatViewController,
               chat.sessionIdentifier == id { return }
            navigation.popToRootViewController(animated: false)
            navigation.pushViewController(ChatViewController(viewModel: ChatViewModel(sessionId: id)), animated: true)
        }
        if tabs.presentedViewController != nil || tabs.selectedViewController?.presentedViewController != nil {
            tabs.dismiss(animated: true, completion: open)
        } else { open() }
    }

    private func setRoot(_ viewController: UIViewController, animated: Bool) {
        guard let window else { return }

        guard animated, window.rootViewController != nil else {
            window.rootViewController = viewController
            return
        }

        UIView.transition(with: window, duration: 0.25, options: .transitionCrossDissolve) {
            window.rootViewController = viewController
        }
    }
}
