import UIKit

/// One selectable permission mode with its runtime-specific explanation.
final class PermissionModeRow: UIControl {
    let mode: String

    private let radioView = UIImageView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()

    init(mode: String, title: String, detail: String) {
        self.mode = mode
        super.init(frame: .zero)

        radioView.tintColor = Theme.Colors.primary
        radioView.contentMode = .scaleAspectFit
        radioView.translatesAutoresizingMaskIntoConstraints = false
        radioView.widthAnchor.constraint(equalToConstant: 22).isActive = true
        radioView.heightAnchor.constraint(equalToConstant: 22).isActive = true

        titleLabel.text = title
        titleLabel.font = Typography.body
        titleLabel.textColor = Theme.Colors.textPrimary

        detailLabel.text = detail
        detailLabel.font = Typography.caption
        detailLabel.textColor = Theme.Colors.textSecondary
        detailLabel.numberOfLines = 0

        let textStack = UIStackView(arrangedSubviews: [titleLabel, detailLabel])
        textStack.axis = .vertical
        textStack.spacing = 2

        let stack = UIStackView(arrangedSubviews: [radioView, textStack])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = Spacing.sm
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Spacing.xxs),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Spacing.xxs),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: Layout.minTouchTarget),
        ])

        isAccessibilityElement = true
        accessibilityLabel = "\(title)：\(detail)"
        accessibilityTraits = .button
        setSelected(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isHighlighted: Bool {
        didSet {
            alpha = isHighlighted ? 0.6 : 1
        }
    }

    func setSelected(_ selected: Bool) {
        radioView.image = UIImage(systemName: selected ? "largecircle.fill.circle" : "circle")
        accessibilityTraits = selected ? [.button, .selected] : .button
    }
}
