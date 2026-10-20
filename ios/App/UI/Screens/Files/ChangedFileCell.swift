import PabootProtocol
import UIKit

/// One git-changed file: filename on top, directory prefix + status/stats below.
final class ChangedFileCell: UITableViewCell {
    static let reuseIdentifier = "ChangedFileCell"

    private let nameLabel = UILabel()
    private let statusLabel = UILabel()
    private let stagedLabel = UILabel()
    private let statsLabel = UILabel()
    private let directoryLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        backgroundColor = Theme.Colors.background
        selectionStyle = .default

        nameLabel.font = Typography.code
        nameLabel.textColor = Theme.Colors.textPrimary
        nameLabel.lineBreakMode = .byTruncatingMiddle

        statusLabel.font = Typography.code
        statusLabel.setContentHuggingPriority(.required, for: .horizontal)

        stagedLabel.text = "已暂存"
        stagedLabel.font = Typography.caption
        stagedLabel.textColor = Theme.Colors.primary
        stagedLabel.isHidden = true

        statsLabel.font = Typography.caption
        statsLabel.textColor = Theme.Colors.textSecondary
        statsLabel.textAlignment = .right
        statsLabel.setContentHuggingPriority(.required, for: .horizontal)

        directoryLabel.font = Typography.caption
        directoryLabel.textColor = Theme.Colors.textMuted
        directoryLabel.lineBreakMode = .byTruncatingHead

        let titleRow = UIStackView(arrangedSubviews: [nameLabel, statusLabel, stagedLabel, statsLabel])
        titleRow.axis = .horizontal
        titleRow.alignment = .firstBaseline
        titleRow.spacing = 6

        let stack = UIStackView(arrangedSubviews: [titleRow, directoryLabel])
        stack.axis = .vertical
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.lg),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.lg),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with change: ChangedFileDto) {
        nameLabel.text = FilePathDisplay.fileName(change.path)

        let directory = FilePathDisplay.directoryPrefix(change.path)
        if change.isDirectory {
            directoryLabel.text = "目录\(directory.map { " · \($0)" } ?? "")"
        } else {
            directoryLabel.text = directory
        }
        directoryLabel.isHidden = directoryLabel.text == nil

        let badge = Self.badge(for: change.status)
        statusLabel.text = badge.text
        statusLabel.textColor = badge.color

        stagedLabel.isHidden = !change.staged

        if change.binary {
            statsLabel.text = "二进制"
            statsLabel.textColor = Theme.Colors.textMuted
        } else if let additions = change.additions, let deletions = change.deletions {
            statsLabel.text = "+\(additions) −\(deletions)"
            statsLabel.textColor = Theme.Colors.textSecondary
        } else {
            statsLabel.text = nil
        }

        accessibilityLabel = [
            FilePathDisplay.fileName(change.path),
            change.path,
            change.status,
            change.staged ? "已暂存" : nil,
            statsLabel.text,
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
    }

    private static func badge(for status: String) -> (text: String, color: UIColor) {
        switch status {
        case "added":
            return ("A", Theme.Colors.success)
        case "deleted":
            return ("D", Theme.Colors.error)
        case "renamed":
            return ("R", Theme.Colors.primary)
        case "untracked":
            return ("?", Theme.Colors.textMuted)
        case "conflicted":
            return ("U", Theme.Colors.error)
        default:
            return ("M", Theme.Colors.warning)
        }
    }
}
