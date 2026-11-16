import UIKit

/// Pill shown over the composer while recording or transcribing.
/// Non-interactive so the keyboard-dismiss tap recognizer cannot fire through it.
final class VoiceInputOverlay: UIView {
    private let barsStack = UIStackView()
    private var heightConstraints: [NSLayoutConstraint] = []
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let content = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.Colors.surface
        layer.cornerRadius = 18
        layer.cornerCurve = .continuous
        isHidden = true
        isUserInteractionEnabled = false

        barsStack.axis = .horizontal
        barsStack.alignment = .center
        barsStack.spacing = 3
        for _ in 0..<7 {
            let bar = UIView()
            bar.backgroundColor = Theme.Colors.error
            bar.layer.cornerRadius = 2
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.widthAnchor.constraint(equalToConstant: 3).isActive = true
            let height = bar.heightAnchor.constraint(equalToConstant: 6)
            height.isActive = true
            heightConstraints.append(height)
            barsStack.addArrangedSubview(bar)
        }

        label.font = Typography.caption
        label.textColor = Theme.Colors.textSecondary
        label.numberOfLines = 1
        label.text = "正在聆听…松开结束"

        spinner.color = Theme.Colors.textSecondary
        spinner.isHidden = true

        content.axis = .horizontal
        content.alignment = .center
        content.spacing = Spacing.sm
        content.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(barsStack)
        content.addArrangedSubview(spinner)
        content.addArrangedSubview(label)
        addSubview(content)

        NSLayoutConstraint.activate([
            content.centerXAnchor.constraint(equalTo: centerXAnchor),
            content.centerYAnchor.constraint(equalTo: centerYAnchor),
            content.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: Spacing.md),
            content.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -Spacing.md),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showListening() {
        isHidden = false
        spinner.stopAnimating()
        spinner.isHidden = true
        barsStack.isHidden = false
        setCancelArmed(false)
    }

    func showTranscribing() {
        isHidden = false
        barsStack.isHidden = true
        spinner.isHidden = false
        spinner.startAnimating()
        label.text = "识别中…"
        label.textColor = Theme.Colors.textSecondary
    }

    func setCancelArmed(_ armed: Bool) {
        label.text = armed ? "松开取消" : "正在聆听…松开结束"
        label.textColor = armed ? Theme.Colors.error : Theme.Colors.textSecondary
    }

    func updateLevel(_ level: Float) {
        let clamped = max(0, min(1, level))
        for (index, constraint) in heightConstraints.enumerated() {
            let shape = 0.35 + 0.65 * abs(sin(Double(index + 1)))
            constraint.constant = 6 + CGFloat(clamped) * 22 * CGFloat(shape)
        }
    }

    func hide() {
        isHidden = true
        spinner.stopAnimating()
    }
}
