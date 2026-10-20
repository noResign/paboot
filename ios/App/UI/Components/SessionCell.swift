import PabootProtocol
import UIKit

final class SessionCell: UITableViewCell {
    static let reuseIdentifier = "SessionCell"

    private let titleLabel = UILabel()
    private let timeLabel = UILabel()
    private let runningDot = RunningDotView()
    private let bottomRow = UIStackView()
    private var badge: AgentBadgeView?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        selectionStyle = .default
        backgroundColor = Theme.Colors.surface

        titleLabel.font = Typography.cardTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail

        timeLabel.font = Typography.caption
        timeLabel.textColor = Theme.Colors.textMuted
        timeLabel.setContentHuggingPriority(.required, for: .horizontal)
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        runningDot.setContentHuggingPriority(.required, for: .horizontal)
        runningDot.setContentCompressionResistancePriority(.required, for: .horizontal)

        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        bottomRow.axis = .horizontal
        bottomRow.alignment = .center
        bottomRow.spacing = Spacing.xs
        bottomRow.addArrangedSubview(spacer)
        bottomRow.addArrangedSubview(runningDot)
        bottomRow.addArrangedSubview(timeLabel)

        let stack = UIStackView(arrangedSubviews: [titleLabel, bottomRow])
        stack.axis = .vertical
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: Spacing.sm),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -Spacing.sm),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with session: SessionDto) {
        if let title = session.title, !title.isEmpty {
            titleLabel.text = title
        } else {
            titleLabel.text = "未命名会话"
        }

        if let badge {
            bottomRow.removeArrangedSubview(badge)
            badge.removeFromSuperview()
        }
        let newBadge = AgentBadgeView(identity: RuntimeIdentity.resolve(id: session.runtime))
        bottomRow.insertArrangedSubview(newBadge, at: 0)
        badge = newBadge

        timeLabel.text = Formatters.relativeTime(fromMilliseconds: session.lastActiveAt)
        runningDot.isHidden = !session.running
        runningDot.setAnimating(session.running)
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        runningDot.setAnimating(false)
        runningDot.isHidden = true
    }
}
