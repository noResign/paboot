import PabootProtocol
import UIKit

/// Side-by-side diff. Each row scrolls horizontally on its own; all visible line rows share
/// one horizontal offset so the two columns stay aligned. Hunk/meta rows span the viewport,
/// matching the Android implementation.
final class SplitDiffView: UIView {
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var rows: [SplitDiff.Row] = []
    private var expandedRow: Int?
    private var columnWidth: CGFloat = 200
    private var horizontalOffset: CGFloat = 0
    private var isSyncingHorizontalOffset = false
    private var heightCache: [Int: CGFloat] = [:]
    private var maxLineLength = 0

    private let gutterWidth: CGFloat = 40
    private let dividerWidth: CGFloat = 1
    private let rowVerticalPadding: CGFloat = 4

    override init(frame: CGRect) {
        super.init(frame: frame)

        backgroundColor = Theme.Editor.background

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = Theme.Editor.background
        tableView.separatorStyle = .none
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 22
        tableView.tableFooterView = UIView()
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(
            SplitDiffLineCell.self,
            forCellReuseIdentifier: SplitDiffLineCell.reuseIdentifier
        )
        tableView.register(
            SplitDiffMetaCell.self,
            forCellReuseIdentifier: SplitDiffMetaCell.reuseIdentifier
        )

        addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: topAnchor),
            tableView.bottomAnchor.constraint(equalTo: bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(rows: [SplitDiff.Row]) {
        self.rows = rows
        maxLineLength = rows.reduce(0) { length, row in
            max(length, row.oldText?.count ?? 0, row.newText?.count ?? 0)
        }
        expandedRow = nil
        horizontalOffset = 0
        heightCache.removeAll()
        columnWidth = 0
        updateColumnWidth()
        tableView.reloadData()
        tableView.setContentOffset(.zero, animated: false)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateColumnWidth()
    }

    private var rowContentWidth: CGFloat {
        gutterWidth * 2 + columnWidth * 2 + dividerWidth
    }

    private func updateColumnWidth() {
        let viewport = bounds.width
        guard viewport > 1, !rows.isEmpty else { return }

        let minColumn = max(120, (viewport - dividerWidth - gutterWidth * 2) / 2)

        let sampleCount = min(max(maxLineLength, 1), 400)
        let sample = String(repeating: "0", count: sampleCount)
        let sampleWidth = (sample as NSString).size(withAttributes: [.font: Typography.code]).width
        let charWidth = sampleWidth / CGFloat(sampleCount)
        let desired = CGFloat(maxLineLength) * charWidth + 8
        let target = min(max(desired, minColumn), 2400)

        guard abs(target - columnWidth) > 0.5 else { return }

        columnWidth = target
        horizontalOffset = min(horizontalOffset, max(0, rowContentWidth - viewport))
        heightCache.removeAll()
        tableView.reloadData()
    }

    private func rowHeight(at index: Int) -> CGFloat {
        guard index < rows.count else {
            return ceil(Typography.code.lineHeight) + rowVerticalPadding
        }
        if let cached = heightCache[index] {
            return cached
        }

        let row = rows[index]
        let base = ceil(Typography.code.lineHeight) + rowVerticalPadding
        let result: CGFloat

        switch row.kind {
        case .hunk, .meta:
            result = base
        case .lines:
            if expandedRow == index {
                let oldHeight = textHeight(row.oldText)
                let newHeight = textHeight(row.newText)
                result = max(base, max(oldHeight, newHeight) + rowVerticalPadding)
            } else {
                result = base
            }
        }

        heightCache[index] = result
        return result
    }

    private func textHeight(_ text: String?) -> CGFloat {
        guard let text, !text.isEmpty else { return 0 }

        let rect = (text as NSString).boundingRect(
            with: CGSize(width: max(columnWidth - 8, 20), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: Typography.code],
            context: nil
        )
        return ceil(rect.height)
    }

    private func toggleRow(at index: Int) {
        guard index < rows.count else { return }

        expandedRow = expandedRow == index ? nil : index
        heightCache.removeAll()

        let indexPath = IndexPath(row: index, section: 0)
        UIView.performWithoutAnimation {
            tableView.beginUpdates()
            tableView.reloadRows(at: [indexPath], with: .none)
            tableView.endUpdates()
        }
    }

    private func synchronize(offset: CGFloat, source: SplitDiffLineCell) {
        guard !isSyncingHorizontalOffset else { return }

        let maxOffset = max(0, rowContentWidth - tableView.bounds.width)
        let clamped = min(max(offset, 0), maxOffset)
        horizontalOffset = clamped

        isSyncingHorizontalOffset = true
        for case let cell as SplitDiffLineCell in tableView.visibleCells where cell !== source {
            // Writing contentOffset back to the driving scroll view can interrupt its
            // drag/deceleration. Only the other rows need a programmatic update.
            cell.setHorizontalOffset(clamped)
        }
        isSyncingHorizontalOffset = false
    }
}

extension SplitDiffView: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        guard indexPath.row < rows.count else {
            return UITableViewCell()
        }

        let row = rows[indexPath.row]

        switch row.kind {
        case .hunk, .meta:
            let cell = tableView.dequeueReusableCell(
                withIdentifier: SplitDiffMetaCell.reuseIdentifier,
                for: indexPath
            ) as! SplitDiffMetaCell
            cell.configure(row)
            return cell
        case .lines:
            let cell = tableView.dequeueReusableCell(
                withIdentifier: SplitDiffLineCell.reuseIdentifier,
                for: indexPath
            ) as! SplitDiffLineCell
            cell.configure(
                row: row,
                expanded: expandedRow == indexPath.row,
                columnWidth: columnWidth
            )
            cell.onToggle = { [weak self] in self?.toggleRow(at: indexPath.row) }
            cell.onHorizontalScroll = { [weak self] source, offset in
                self?.synchronize(offset: offset, source: source)
            }
            cell.setHorizontalOffset(horizontalOffset)
            return cell
        }
    }
}

extension SplitDiffView: UITableViewDelegate {
    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        rowHeight(at: indexPath.row)
    }

    func tableView(
        _ tableView: UITableView,
        willDisplay cell: UITableViewCell,
        forRowAt indexPath: IndexPath
    ) {
        // The cell only has its final width once the table has placed it, so re-apply the
        // shared offset here (doing it in cellForRow is too early to clamp correctly).
        (cell as? SplitDiffLineCell)?.setHorizontalOffset(horizontalOffset)
    }
}

private final class SplitDiffLineCell: UITableViewCell, UIScrollViewDelegate {
    static let reuseIdentifier = "SplitDiffLineCell"

    var onToggle: (() -> Void)?
    var onHorizontalScroll: ((SplitDiffLineCell, CGFloat) -> Void)?

    private let rowScrollView = UIScrollView()
    private let rowView = UIView()
    private let oldNumberLabel = UILabel()
    private let oldTextLabel = UILabel()
    private let dividerView = UIView()
    private let newNumberLabel = UILabel()
    private let newTextLabel = UILabel()
    private var oldTextWidthConstraint: NSLayoutConstraint!
    private var newTextWidthConstraint: NSLayoutConstraint!
    private var rowWidthConstraint: NSLayoutConstraint!
    private var isApplyingOffset = false
    private var desiredHorizontalOffset: CGFloat = 0

    private let gutterWidth: CGFloat = 40
    private let dividerWidth: CGFloat = 1

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        backgroundColor = Theme.Editor.background
        contentView.backgroundColor = Theme.Editor.background
        selectionStyle = .none

        rowScrollView.translatesAutoresizingMaskIntoConstraints = false
        rowScrollView.showsHorizontalScrollIndicator = false
        rowScrollView.isDirectionalLockEnabled = true
        rowScrollView.contentInsetAdjustmentBehavior = .never
        rowScrollView.delegate = self
        contentView.addSubview(rowScrollView)

        rowView.translatesAutoresizingMaskIntoConstraints = false
        rowScrollView.addSubview(rowView)

        configureLabel(oldNumberLabel, alignment: .right)
        configureLabel(oldTextLabel, alignment: .left)
        configureLabel(newNumberLabel, alignment: .right)
        configureLabel(newTextLabel, alignment: .left)
        oldNumberLabel.textColor = Theme.Editor.muted
        newNumberLabel.textColor = Theme.Editor.muted

        dividerView.backgroundColor = Theme.Editor.divider
        dividerView.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView(arrangedSubviews: [
            oldNumberLabel,
            oldTextLabel,
            dividerView,
            newNumberLabel,
            newTextLabel,
        ])
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        rowView.addSubview(stack)

        rowWidthConstraint = rowView.widthAnchor.constraint(equalToConstant: 300)
        oldTextWidthConstraint = oldTextLabel.widthAnchor.constraint(equalToConstant: 120)
        newTextWidthConstraint = newTextLabel.widthAnchor.constraint(equalToConstant: 120)

        NSLayoutConstraint.activate([
            rowScrollView.topAnchor.constraint(equalTo: contentView.topAnchor),
            rowScrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            rowScrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            rowScrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),

            rowView.topAnchor.constraint(equalTo: rowScrollView.contentLayoutGuide.topAnchor),
            rowView.bottomAnchor.constraint(equalTo: rowScrollView.contentLayoutGuide.bottomAnchor),
            rowView.leadingAnchor.constraint(equalTo: rowScrollView.contentLayoutGuide.leadingAnchor),
            rowView.trailingAnchor.constraint(equalTo: rowScrollView.contentLayoutGuide.trailingAnchor),
            rowView.heightAnchor.constraint(equalTo: rowScrollView.frameLayoutGuide.heightAnchor),

            oldNumberLabel.widthAnchor.constraint(equalToConstant: gutterWidth),
            newNumberLabel.widthAnchor.constraint(equalToConstant: gutterWidth),
            dividerView.widthAnchor.constraint(equalToConstant: dividerWidth),
            oldTextWidthConstraint,
            newTextWidthConstraint,
            rowWidthConstraint,

            stack.topAnchor.constraint(equalTo: rowView.topAnchor, constant: 2),
            stack.bottomAnchor.constraint(equalTo: rowView.bottomAnchor, constant: -2),
            stack.leadingAnchor.constraint(equalTo: rowView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: rowView.trailingAnchor),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        tap.cancelsTouchesInView = false
        contentView.addGestureRecognizer(tap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        onToggle = nil
        onHorizontalScroll = nil
    }

    func configure(row: SplitDiff.Row, expanded: Bool, columnWidth: CGFloat) {
        oldNumberLabel.text = row.oldLineNumber.map { String($0) } ?? ""
        newNumberLabel.text = row.newLineNumber.map { String($0) } ?? ""
        oldTextLabel.text = row.oldText ?? ""
        newTextLabel.text = row.newText ?? ""

        oldTextLabel.textColor = row.oldText != nil && row.newText == nil
            ? Theme.Editor.deleted
            : Theme.Editor.text
        newTextLabel.textColor = row.newText != nil && row.oldText == nil
            ? Theme.Editor.added
            : Theme.Editor.text

        oldTextLabel.numberOfLines = expanded ? 0 : 1
        newTextLabel.numberOfLines = expanded ? 0 : 1
        oldTextLabel.lineBreakMode = expanded ? .byWordWrapping : .byTruncatingTail
        newTextLabel.lineBreakMode = expanded ? .byWordWrapping : .byTruncatingTail

        oldTextWidthConstraint.constant = columnWidth
        newTextWidthConstraint.constant = columnWidth
        rowWidthConstraint.constant = columnWidth * 2 + gutterWidth * 2 + dividerWidth

        accessibilityLabel = accessibilityDescription(row)
    }

    func setHorizontalOffset(_ offset: CGFloat) {
        desiredHorizontalOffset = offset
        applyHorizontalOffset()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Reused/new cells may receive the shared offset before their final width.
        // Apply it after normal layout rather than forcing layout on every scroll frame.
        guard !rowScrollView.isDragging, !rowScrollView.isDecelerating else { return }
        applyHorizontalOffset()
    }

    private func applyHorizontalOffset() {
        guard rowScrollView.bounds.width > 0 else { return }
        let maxOffset = max(0, rowWidthConstraint.constant - rowScrollView.bounds.width)
        let target = min(max(desiredHorizontalOffset, 0), maxOffset)
        guard abs(rowScrollView.contentOffset.x - target) > 0.01 else { return }

        isApplyingOffset = true
        rowScrollView.setContentOffset(CGPoint(x: target, y: 0), animated: false)
        isApplyingOffset = false
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === rowScrollView, !isApplyingOffset,
              scrollView.isDragging || scrollView.isDecelerating else { return }
        desiredHorizontalOffset = scrollView.contentOffset.x
        onHorizontalScroll?(self, scrollView.contentOffset.x)
    }

    @objc private func handleTap() {
        onToggle?()
    }

    private func configureLabel(_ label: UILabel, alignment: NSTextAlignment) {
        label.font = Typography.code
        label.textColor = Theme.Editor.text
        label.textAlignment = alignment
        label.numberOfLines = 1
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
    }

    private func accessibilityDescription(_ row: SplitDiff.Row) -> String {
        var parts: [String] = []
        if let old = row.oldText {
            parts.append("旧 \(row.oldLineNumber.map { String($0) } ?? "-")：\(old)")
        }
        if let new = row.newText, new != row.oldText {
            parts.append("新 \(row.newLineNumber.map { String($0) } ?? "-")：\(new)")
        }
        return parts.isEmpty ? "空行" : parts.joined(separator: "；")
    }
}

private final class SplitDiffMetaCell: UITableViewCell {
    static let reuseIdentifier = "SplitDiffMetaCell"

    private let label = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)

        backgroundColor = Theme.Editor.background
        selectionStyle = .none

        label.font = Typography.code
        label.numberOfLines = 1
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(label)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -2),
            label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(_ row: SplitDiff.Row) {
        label.text = row.fullText
        if row.kind == .hunk {
            label.textColor = Theme.Editor.hunk
            contentView.backgroundColor = Theme.Editor.hunkBackground
        } else {
            label.textColor = Theme.Editor.muted
            contentView.backgroundColor = .clear
        }
    }
}
