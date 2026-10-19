import UIKit

/// Placeholder for the file browser (P5).
final class FilesViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "文件"
        view.backgroundColor = Theme.Colors.background
        addEmptyState(
            symbolName: "folder",
            title: "还没有文件",
            message: "工作区里的文件会显示在这里"
        )
    }
}
