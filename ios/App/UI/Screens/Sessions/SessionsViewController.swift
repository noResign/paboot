import UIKit

/// Placeholder for the session list (P3). Kept intentionally empty in the shell.
final class SessionsViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "会话"
        view.backgroundColor = Theme.Colors.background

        let active = ConnectionStore.shared.active
        let message = active.map {
            "已连接 \($0.displayName)（\($0.baseUrl)）"
        } ?? "连接 daemon 后，会话会显示在这里"

        addEmptyState(
            symbolName: "bubble.left.and.bubble.right",
            title: "还没有会话",
            message: message
        )
    }
}
