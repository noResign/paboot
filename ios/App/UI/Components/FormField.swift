import UIKit

/// A labeled text field in the design's surface + border style.
final class FormField: UIView {
    let textField = UITextField()
    private let box = UIView()
    private let placeholderText: String

    init(
        label: String,
        placeholder: String,
        isSecure: Bool = false,
        keyboardType: UIKeyboardType = .default,
        returnKeyType: UIReturnKeyType = .next
    ) {
        self.placeholderText = placeholder
        super.init(frame: .zero)

        let labelView = UILabel()
        labelView.text = label
        labelView.font = Typography.caption
        labelView.textColor = Theme.Colors.textSecondary

        textField.font = Typography.body
        textField.textColor = Theme.Colors.textPrimary
        textField.tintColor = Theme.Colors.primary
        textField.autocapitalizationType = .none
        textField.autocorrectionType = .no
        textField.spellCheckingType = .no
        textField.isSecureTextEntry = isSecure
        textField.keyboardType = keyboardType
        textField.returnKeyType = returnKeyType
        textField.clearButtonMode = .whileEditing
        textField.translatesAutoresizingMaskIntoConstraints = false

        box.backgroundColor = Theme.Colors.surface
        box.layer.cornerRadius = Radius.card
        box.layer.borderWidth = 1
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(textField)

        let stack = UIStackView(arrangedSubviews: [labelView, box])
        stack.axis = .vertical
        stack.spacing = Spacing.xxs
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            textField.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
            textField.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
            textField.topAnchor.constraint(equalTo: box.topAnchor, constant: Spacing.sm),
            textField.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -Spacing.sm),
            box.heightAnchor.constraint(greaterThanOrEqualToConstant: Layout.minTouchTarget),

            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        updateColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var text: String {
        textField.text ?? ""
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        box.layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            updateColors()
        }
    }

    private func updateColors() {
        textField.attributedPlaceholder = NSAttributedString(
            string: placeholderText,
            attributes: [.foregroundColor: Theme.Colors.textMuted]
        )
        box.layer.borderColor = Theme.Colors.border.resolvedColor(with: traitCollection).cgColor
    }
}
