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

        AppRouter.shared.start(in: window)
        window.makeKeyAndVisible()
    }
}
