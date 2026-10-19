import UIKit

/// Placeholder for the session list (P3). Kept intentionally empty in the shell.
final class SessionsViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "会话"
        view.backgroundColor = Theme.Colors.background
        addEmptyState(
            symbolName: "bubble.left.and.bubble.right",
            title: "还没有会话",
            message: "连接 daemon 后，会话会显示在这里"
        )
    }
}
