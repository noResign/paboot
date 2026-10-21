import UIKit

/// Pulsing dot that marks a running session.
final class RunningDotView: UIView {
    private let dot = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false

        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.backgroundColor = Theme.Colors.primary
        dot.layer.cornerRadius = 4
        addSubview(dot)

        // A hidden arranged subview is collapsed to zero width by UIStackView.
        let width = widthAnchor.constraint(equalToConstant: 8)
        width.priority = .defaultHigh
        NSLayoutConstraint.activate([
            width,
            heightAnchor.constraint(equalToConstant: 8),
            dot.centerXAnchor.constraint(equalTo: centerXAnchor),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
        ])
        setRunning(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setRunning(_ running: Bool) {
        // UIStackView manages the outer view's hidden transition during reconfiguration.
        // Hide the actual colored dot too, so stopping cannot leave a static indicator.
        UIView.performWithoutAnimation {
            self.isHidden = !running
            self.dot.isHidden = !running
            self.dot.alpha = running ? 1 : 0
        }
        guard running else {
            dot.layer.removeAnimation(forKey: "pulse")
            return
        }
        // Refreshing an already-running card should not restart the pulse.
        guard dot.layer.animation(forKey: "pulse") == nil else { return }

        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 1.0
        animation.toValue = 0.25
        animation.duration = 0.8
        animation.autoreverses = true
        animation.repeatCount = .infinity
        dot.layer.add(animation, forKey: "pulse")
    }
}
