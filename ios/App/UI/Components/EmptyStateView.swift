import UIKit

/// Shared empty/placeholder state: icon, title, optional explanation and action.
final class EmptyStateView: UIView {
    init(
        symbolName: String,
        title: String,
        message: String? = nil,
        actionTitle: String? = nil,
        onAction: (() -> Void)? = nil
    ) {
        super.init(frame: .zero)

        let iconView = UIImageView(
            image: UIImage(
                systemName: symbolName,
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 36, weight: .regular)
            )
        )
        iconView.tintColor = Theme.Colors.textMuted
        iconView.contentMode = .scaleAspectFit

        let titleLabel = UILabel()
        titleLabel.text = title
        titleLabel.font = Typography.cardTitle
        titleLabel.textColor = Theme.Colors.textPrimary
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [iconView, titleLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = Spacing.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        if let message {
            let messageLabel = UILabel()
            messageLabel.text = message
            messageLabel.font = Typography.body
            messageLabel.textColor = Theme.Colors.textSecondary
            messageLabel.textAlignment = .center
            messageLabel.numberOfLines = 0
            stack.addArrangedSubview(messageLabel)
        }

        if let actionTitle, let onAction {
            var configuration = UIButton.Configuration.tinted()
            configuration.title = actionTitle
            configuration.baseForegroundColor = Theme.Colors.primary
            configuration.baseBackgroundColor = Theme.Colors.primary
            configuration.cornerStyle = .medium

            let button = UIButton(configuration: configuration)
            button.addAction(UIAction { _ in onAction() }, for: .touchUpInside)
            stack.addArrangedSubview(button)
        }

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: Spacing.xl),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -Spacing.xl),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

extension UIViewController {
    /// Pin a full-bleed empty state inside this controller's safe area.
    func addEmptyState(symbolName: String, title: String, message: String? = nil) {
        let empty = EmptyStateView(symbolName: symbolName, title: title, message: message)
        empty.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(empty)
        NSLayoutConstraint.activate([
            empty.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            empty.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            empty.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            empty.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }
}
