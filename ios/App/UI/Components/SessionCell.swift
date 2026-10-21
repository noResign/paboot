import PabootProtocol
import UIKit

/// One session rendered as a standalone rounded card, matching the Android session list.
final class SessionCell: UITableViewCell {
    static let reuseIdentifier = "SessionCell"

    private let card = UIView()
    private let titleLabel = UILabel()
    private let timeLabel = UILabel()
    private let runningDot = RunningDotView()
    private let badgeRow = UIStackView()
    private let badgeSpacer = UIView()
    private var badge: AgentBadgeView?
    private var isRunning = false

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        selectionStyle = .none
        backgroundColor = .clear
        contentView.backgroundColor = .clear

        card.backgroundColor = Theme.Colors.surface
        card.layer.cornerRadius = Radius.card
        card.layer.borderWidth = 1
        card.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(card)

        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 6),
            card.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -6),
            card.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Spacing.md),
            card.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Spacing.md),
        ])

        titleLabel.font = Typography.cardTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        timeLabel.font = Typography.caption
        timeLabel.textColor = Theme.Colors.textMuted
        timeLabel.setContentHuggingPriority(.required, for: .horizontal)
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        runningDot.setContentHuggingPriority(.required, for: .horizontal)
        runningDot.setContentCompressionResistancePriority(.required, for: .horizontal)

        let topRow = UIStackView(arrangedSubviews: [runningDot, titleLabel, timeLabel])
        topRow.axis = .horizontal
        topRow.alignment = .center
        topRow.spacing = Spacing.xs

        badgeSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        badgeRow.axis = .horizontal
        badgeRow.alignment = .center
        badgeRow.addArrangedSubview(badgeSpacer)

        let stack = UIStackView(arrangedSubviews: [topRow, badgeRow])
        stack.axis = .vertical
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: Spacing.md),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -Spacing.md),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: Spacing.md),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -Spacing.md),
        ])

        applyCardAppearance()
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

        badge?.removeFromSuperview()
        let newBadge = AgentBadgeView(identity: RuntimeIdentity.resolve(id: session.runtime))
        // Keep the badge at its intrinsic width; the trailing spacer absorbs the row width.
        newBadge.setContentHuggingPriority(.required, for: .horizontal)
        newBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        badgeRow.insertArrangedSubview(newBadge, at: 0)
        badge = newBadge

        timeLabel.text = Formatters.relativeTime(fromMilliseconds: session.lastActiveAt)

        isRunning = session.running
        runningDot.setRunning(session.running)
        applyCardAppearance()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        runningDot.setRunning(false)
        isRunning = false
        applyCardAppearance()
    }

    override func setHighlighted(_ highlighted: Bool, animated: Bool) {
        super.setHighlighted(highlighted, animated: animated)
        applyCardAppearance()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)

        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            applyCardAppearance()
        }
    }

    private func applyCardAppearance() {
        card.backgroundColor = isHighlighted ? Theme.Colors.surface2 : Theme.Colors.surface
        card.layer.borderColor = (isRunning ? Theme.Colors.primary : Theme.Colors.border)
            .resolvedColor(with: traitCollection)
            .cgColor
    }
}
