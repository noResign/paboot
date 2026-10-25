import PabootProtocol
import UIKit

/// One directory or file in the "all files" browser, or a child git repo.
final class FileEntryCell: UITableViewCell {
    static let reuseIdentifier = "FileEntryCell"

    private let iconView = UIImageView()
    private let nameLabel = UILabel()
    private let detailLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        backgroundColor = Theme.Colors.background
        selectionStyle = .default

        iconView.contentMode = .scaleAspectFit
        iconView.tintColor = Theme.Colors.textSecondary
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 22).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 22).isActive = true

        nameLabel.font = Typography.body
        nameLabel.textColor = Theme.Colors.textPrimary
        nameLabel.lineBreakMode = .byTruncatingMiddle

        detailLabel.font = Typography.caption
        detailLabel.textColor = Theme.Colors.textMuted
        detailLabel.textAlignment = .right
        detailLabel.setContentHuggingPriority(.required, for: .horizontal)

        let stack = UIStackView(arrangedSubviews: [iconView, nameLabel, detailLabel])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = Spacing.sm
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

    func configure(with entry: FileEntryDto) {
        let isDirectory = entry.type == "directory"
        nameLabel.textColor = Theme.Colors.textPrimary
        selectionStyle = .default
        iconView.image = UIImage(systemName: isDirectory ? "folder" : "doc")
        iconView.tintColor = isDirectory ? Theme.Colors.primary : Theme.Colors.textMuted
        nameLabel.text = entry.name

        var details: [String] = []
        if !isDirectory, let size = entry.size {
            details.append(FilePathDisplay.byteSize(size))
        }
        if let modifiedAt = entry.modifiedAt, modifiedAt > 0 {
            details.append(Formatters.relativeTime(fromMilliseconds: modifiedAt))
        }
        if MediaKind.forPath(entry.path) == .image {
            details.append("图片")
        } else if MediaKind.forPath(entry.path) == .video {
            details.append("视频")
        }
        detailLabel.text = details.joined(separator: " · ")
        accessoryType = isDirectory ? .disclosureIndicator : .none

        accessibilityLabel = isDirectory ? "\(entry.name)，文件夹" : entry.name
    }

    func configureUp() {
        nameLabel.textColor = Theme.Colors.textPrimary
        selectionStyle = .default
        iconView.image = UIImage(systemName: "arrow.up")
        iconView.tintColor = Theme.Colors.textSecondary
        nameLabel.text = "上一级"
        detailLabel.text = nil
        accessoryType = .disclosureIndicator
        accessibilityLabel = "上一级"
    }

    func configureRepo(_ relativePath: String) {
        nameLabel.textColor = Theme.Colors.textPrimary
        selectionStyle = .default
        iconView.image = UIImage(systemName: "folder.badge.gearshape")
        iconView.tintColor = Theme.Colors.primary
        nameLabel.text = relativePath
        detailLabel.text = "Git 仓库"
        accessoryType = .disclosureIndicator
        accessibilityLabel = "\(relativePath)，Git 仓库"
    }

    /// A one-line, non-selectable message (e.g. no entries match the filter).
    func configureMessage(_ text: String) {
        nameLabel.textColor = Theme.Colors.textSecondary
        selectionStyle = .none
        iconView.image = UIImage(systemName: "magnifyingglass")
        iconView.tintColor = Theme.Colors.textMuted
        nameLabel.text = text
        detailLabel.text = nil
        accessoryType = .none
        accessibilityLabel = text
    }
}
