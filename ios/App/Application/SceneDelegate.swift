import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        Theme.applyGlobalAppearance()

        let window = UIWindow(windowScene: windowScene)
        window.tintColor = Theme.Colors.primary
        self.window = window

        let viewModel = ConnectViewModel()
        let connect = ConnectViewController(viewModel: viewModel)
        viewModel.onConnected = { [weak self] _ in
            self?.showMain()
        }

        let navigation = UINavigationController(rootViewController: connect)
        navigation.navigationBar.standardAppearance = Theme.navigationBarAppearance()
        navigation.navigationBar.scrollEdgeAppearance = Theme.navigationBarAppearance()
        navigation.setNavigationBarHidden(true, animated: false)

        window.rootViewController = navigation
        window.makeKeyAndVisible()
    }

    private func showMain() {
        guard let window else { return }
        let main = MainTabBarController()
        UIView.transition(with: window, duration: 0.25, options: .transitionCrossDissolve) {
            window.rootViewController = main
        }
    }
}
