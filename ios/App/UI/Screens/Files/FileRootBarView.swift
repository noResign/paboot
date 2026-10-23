import UIKit

/// Chip row above the file list: workspace roots + browse bookmarks on the left,
/// a pinned "+ 目录" entry on the right.
final class FileRootBarView: UIView {
    var onSelectRoot: ((String?) -> Void)?
    var onRemoveShortcut: ((String) -> Void)?
    var onAddRoot: (() -> Void)?

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let addButton = UIButton(type: .system)
    private var selectedChip: UIView?

    override init(frame: CGRect) {
        super.init(frame: frame)

        scrollView.showsHorizontalScrollIndicator = false
        scrollView.alwaysBounceHorizontal = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = Spacing.xs
        stack.translatesAutoresizingMaskIntoConstraints = false

        var configuration = UIButton.Configuration.plain()
        configuration.title = "+ 目录"
        configuration.baseForegroundColor = Theme.Colors.primary
        configuration.contentInsets = NSDirectionalEdgeInsets(
            top: 4,
            leading: 8,
            bottom: 4,
            trailing: 0
        )
        addButton.configuration = configuration
        addButton.setContentHuggingPriority(.required, for: .horizontal)
        addButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        addButton.translatesAutoresizingMaskIntoConstraints = false
        addButton.addAction(UIAction { [weak self] _ in self?.onAddRoot?() }, for: .touchUpInside)

        addSubview(scrollView)
        scrollView.addSubview(stack)
        addSubview(addButton)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.lg),
            scrollView.trailingAnchor.constraint(equalTo: addButton.leadingAnchor, constant: -Spacing.xs),

            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),

            addButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.lg),
            addButton.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(
        roots: [String],
        shortcuts: [String],
        selectedRoot: String?,
        workspacePath: String
    ) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        selectedChip = nil

        for root in roots {
            let chip = makeChip(
                path: root,
                removable: false,
                selected: root == selectedRoot,
                workspacePath: workspacePath
            )
            stack.addArrangedSubview(chip)
            if root == selectedRoot {
                selectedChip = chip
            }
        }

        for shortcut in shortcuts where !roots.contains(shortcut) {
            let chip = makeChip(
                path: shortcut,
                removable: true,
                selected: shortcut == selectedRoot,
                workspacePath: workspacePath
            )
            stack.addArrangedSubview(chip)
            if shortcut == selectedRoot {
                selectedChip = chip
            }
        }

        layoutIfNeeded()
        if let selectedChip {
            let rect = selectedChip.convert(selectedChip.bounds, to: scrollView)
            scrollView.scrollRectToVisible(rect.insetBy(dx: -Spacing.xs, dy: 0), animated: false)
        }
    }

    private func makeChip(
        path: String,
        removable: Bool,
        selected: Bool,
        workspacePath: String
    ) -> UIView {
        let container = UIView()
        container.backgroundColor = selected ? Theme.Colors.primarySubtle : Theme.Colors.surface
        container.layer.cornerRadius = 14
        container.translatesAutoresizingMaskIntoConstraints = false
        container.heightAnchor.constraint(equalToConstant: 28).isActive = true

        let button = UIButton(type: .system)
        button.setTitle(displayName(for: path, workspacePath: workspacePath), for: .normal)
        button.setTitleColor(selected ? Theme.Colors.primary : Theme.Colors.textSecondary, for: .normal)
        button.titleLabel?.font = Typography.caption
        button.titleLabel?.lineBreakMode = .byTruncatingMiddle
        button.accessibilityLabel = path
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addAction(
            UIAction { [weak self] _ in self?.onSelectRoot?(path) },
            for: .touchUpInside
        )
        container.addSubview(button)

        NSLayoutConstraint.activate([
            button.topAnchor.constraint(equalTo: container.topAnchor),
            button.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            button.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
        ])

        if removable {
            let close = UIButton(type: .system)
            close.setImage(
                UIImage(
                    systemName: "xmark",
                    withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .semibold)
                ),
                for: .normal
            )
            close.tintColor = Theme.Colors.textMuted
            close.accessibilityLabel = "移除书签 \(path)"
            close.translatesAutoresizingMaskIntoConstraints = false
            close.addAction(
                UIAction { [weak self] _ in self?.onRemoveShortcut?(path) },
                for: .touchUpInside
            )
            container.addSubview(close)

            NSLayoutConstraint.activate([
                close.centerYAnchor.constraint(equalTo: container.centerYAnchor),
                close.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
                close.widthAnchor.constraint(equalToConstant: 20),
                close.heightAnchor.constraint(equalToConstant: 20),
                button.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -4),
            ])
        } else {
            button.trailingAnchor.constraint(
                equalTo: container.trailingAnchor,
                constant: -12
            ).isActive = true
        }

        return container
    }

    private func displayName(for path: String, workspacePath: String) -> String {
        let name = (path as NSString).lastPathComponent
        if !name.isEmpty {
            return name
        }
        return path
    }
}

/// Scrollable path trail for the file browser: `根目录 / 二级 / 三级 …`. Every
/// segment jumps straight to that directory, mirroring Android's breadcrumbs.
final class FileBreadcrumbBarView: UIView {
    var onSelect: ((String) -> Void)?

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private var currentPath: String?

    override init(frame: CGRect) {
        super.init(frame: frame)

        scrollView.showsHorizontalScrollIndicator = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false

        addSubview(scrollView)
        scrollView.addSubview(stack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Spacing.lg),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Spacing.lg),

            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(path: String) {
        guard path != currentPath else { return }
        currentPath = path
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for (index, crumb) in Self.crumbs(path).enumerated() {
            if index > 0 {
                stack.addArrangedSubview(separator())
            }
            stack.addArrangedSubview(crumbView(crumb, isRoot: index == 0))
        }

        // The current directory is at the trailing end; keep it visible when the
        // path is wider than the screen.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.layoutIfNeeded()
            self.scrollView.layoutIfNeeded()
            let maxOffset = max(0, self.scrollView.contentSize.width - self.scrollView.bounds.width)
            self.scrollView.setContentOffset(CGPoint(x: maxOffset, y: 0), animated: false)
        }
    }

    private func crumbView(_ crumb: (label: String, path: String), isRoot: Bool) -> UIView {
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false

        let button = UIButton(type: .system)
        button.setTitle(crumb.label, for: .normal)
        button.setTitleColor(isRoot ? Theme.Colors.primary : Theme.Colors.textSecondary, for: .normal)
        button.titleLabel?.font = .monospacedSystemFont(ofSize: 12, weight: isRoot ? .semibold : .regular)
        button.accessibilityLabel = crumb.label
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addAction(
            UIAction { [weak self] _ in self?.onSelect?(crumb.path) },
            for: .touchUpInside
        )
        container.addSubview(button)

        NSLayoutConstraint.activate([
            button.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
            button.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),
            button.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 2),
            button.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -2),
        ])
        return container
    }

    private func separator() -> UILabel {
        let label = UILabel()
        label.text = "/"
        label.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        label.textColor = Theme.Colors.textMuted
        label.isAccessibilityElement = false
        return label
    }

    private static func crumbs(_ path: String) -> [(label: String, path: String)] {
        // The root is whichever directory the root bar selected, so name it neutrally.
        var items: [(label: String, path: String)] = [("根目录", "")]
        var current = ""
        for part in path.split(separator: "/") where !part.isEmpty {
            let segment = String(part)
            current = current.isEmpty ? segment : current + "/" + segment
            items.append((segment, current))
        }
        return items
    }
}
