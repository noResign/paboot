import UIKit

/// Root container: 会话 / 文件 / 设置, each tab owning its own navigation stack.
///
/// Detail screens are pushed onto these stacks. Sheets use
/// `UISheetPresentationController` (see `docs/ui/mobile/platforms/ios.md` §6).
final class MainTabBarController: UITabBarController {
    override func viewDidLoad() {
        super.viewDidLoad()

        viewControllers = [
            makeTab(
                root: SessionsViewController(),
                title: "会话",
                symbol: "bubble.left.and.bubble.right",
                selectedSymbol: "bubble.left.and.bubble.right.fill"
            ),
            makeTab(
                root: FilesViewController(),
                title: "文件",
                symbol: "folder",
                selectedSymbol: "folder.fill"
            ),
            makeTab(
                root: SettingsViewController(),
                title: "设置",
                symbol: "gearshape",
                selectedSymbol: "gearshape.fill"
            ),
        ]

        tabBar.isTranslucent = true
        tabBar.backgroundColor = .clear
        tabBar.standardAppearance = Theme.tabBarAppearance()
        tabBar.scrollEdgeAppearance = Theme.tabBarAppearance()
    }

    private func makeTab(
        root: UIViewController,
        title: String,
        symbol: String,
        selectedSymbol: String
    ) -> UINavigationController {
        let navigation = UINavigationController(rootViewController: root)
        navigation.navigationBar.standardAppearance = Theme.navigationBarAppearance()
        navigation.navigationBar.scrollEdgeAppearance = Theme.navigationBarAppearance()
        navigation.tabBarItem = UITabBarItem(
            title: title,
            image: UIImage(systemName: symbol),
            selectedImage: UIImage(systemName: selectedSymbol)
        )
        return navigation
    }

    func navigateFromChat(to destination: ChatBottomBar.Destination) {
        selectedIndex = destination.rawValue
        if destination == .sessions {
            // This tab is already selected in a conversation; make its entry useful
            // by returning to the session list, just like tapping the back button.
            (selectedViewController as? UINavigationController)?.popToRootViewController(animated: true)
        }
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .all
    }
}
