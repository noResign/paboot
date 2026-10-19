import UIKit

/// Placeholder for settings (P5).
final class SettingsViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "设置"
        view.backgroundColor = Theme.Colors.background
        addEmptyState(
            symbolName: "gearshape",
            title: "设置",
            message: "连接、工作区与权限设置会放在这里"
        )
    }
}
