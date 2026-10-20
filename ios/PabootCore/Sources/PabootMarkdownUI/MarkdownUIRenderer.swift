#if canImport(UIKit)
import Markdown
import UIKit

/// Parses Markdown with swift-markdown (cmark-gfm) and renders native UIKit block views.
public enum MarkdownUIRenderer {
    public static func makeView(markdown: String, style: MarkdownUIStyle) -> UIView {
        let document = Document(parsing: markdown)
        let view = MarkdownDocumentView(style: style)
        view.render(Array(document.children))
        return view
    }
}

private final class MarkdownDocumentView: UIView {
    private let stack = UIStackView()
    private let style: MarkdownUIStyle

    init(style: MarkdownUIStyle) {
        self.style = style
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func render(_ blocks: [Markup]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        addBlocks(blocks, indent: 0)
    }

    private func addBlocks(_ blocks: [Markup], indent: CGFloat) {
        for block in blocks {
            if let view = blockView(block, indent: indent) {
                stack.addArrangedSubview(view)
            }
        }
    }

    private func blockView(_ markup: Markup, indent: CGFloat) -> UIView? {
        if let heading = markup as? Heading {
            let font = headingFont(level: heading.level)
            let label = attributedLabel(
                inline(heading, font: font, color: style.textColor)
            )
            return wrapped(label, indent: indent)
        }

        if let paragraph = markup as? Paragraph {
            let label = attributedLabel(
                inline(paragraph, font: style.bodyFont, color: style.textColor)
            )
            return wrapped(label, indent: indent)
        }

        if let code = markup as? CodeBlock {
            return wrapped(
                MarkdownCodeBlockView(
                    code: code.code,
                    language: code.language,
                    style: style
                ),
                indent: indent
            )
        }

        if let table = markup as? Table {
            return wrapped(
                MarkdownTableView(table: table, style: style),
                indent: indent
            )
        }

        if let quote = markup as? BlockQuote {
            let content = MarkdownDocumentView(style: style)
            content.render(Array(quote.children))

            let bar = UIView()
            bar.backgroundColor = style.borderColor
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.widthAnchor.constraint(equalToConstant: 2).isActive = true

            let row = UIStackView(arrangedSubviews: [bar, content])
            row.axis = .horizontal
            row.alignment = .fill
            row.spacing = 8
            return wrapped(row, indent: indent)
        }

        if let list = markup as? UnorderedList {
            return wrapped(listView(list, ordered: false), indent: indent)
        }

        if let list = markup as? OrderedList {
            return wrapped(listView(list, ordered: true), indent: indent)
        }

        if markup is ThematicBreak {
            let line = UIView()
            line.backgroundColor = style.borderColor
            line.translatesAutoresizingMaskIntoConstraints = false
            line.heightAnchor.constraint(equalToConstant: 1).isActive = true
            return wrapped(line, indent: indent)
        }

        if let html = markup as? HTMLBlock {
            return wrapped(
                MarkdownCodeBlockView(
                    code: html.rawHTML,
                    language: "html",
                    style: style
                ),
                indent: indent
            )
        }

        if !markup.children.isEmpty {
            let content = MarkdownDocumentView(style: style)
            content.render(Array(markup.children))
            return wrapped(content, indent: indent)
        }

        return nil
    }

    private func wrapped(_ view: UIView, indent: CGFloat) -> UIView {
        guard indent > 0 else { return view }

        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)

        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: indent),
        ])
        return container
    }

    private func headingFont(level: Int) -> UIFont {
        guard !style.headingFonts.isEmpty else { return style.bodyFont }
        let index = min(max(level - 1, 0), style.headingFonts.count - 1)
        return style.headingFonts[index]
    }

    private func attributedLabel(_ text: NSAttributedString) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 0
        label.attributedText = text
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }

    private func listView(_ list: Markup, ordered: Bool) -> UIView {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false

        var index = 1
        for item in list.children {
            let marker = UILabel()
            marker.font = style.bodyFont
            marker.textColor = style.secondaryTextColor
            marker.text = ordered ? "\(index)." : "•"
            marker.translatesAutoresizingMaskIntoConstraints = false
            marker.setContentHuggingPriority(.required, for: .horizontal)

            let content = MarkdownDocumentView(style: style)
            content.render(Array(item.children))

            let row = UIStackView(arrangedSubviews: [marker, content])
            row.axis = .horizontal
            row.alignment = .top
            row.spacing = 6
            stack.addArrangedSubview(row)
            index += 1
        }

        return stack
    }

    // MARK: - Inline

    private func inline(
        _ markup: Markup,
        font: UIFont,
        color: UIColor,
        extra: [NSAttributedString.Key: Any] = [:]
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()

        for child in markup.children {
            if let text = child as? Text {
                result.append(
                    NSAttributedString(
                        string: text.string,
                        attributes: attributes(font: font, color: color, extra: extra)
                    )
                )
            } else if let emphasis = child as? Emphasis {
                result.append(
                    inline(emphasis, font: italic(font), color: color, extra: extra)
                )
            } else if let strong = child as? Strong {
                result.append(
                    inline(strong, font: bold(font), color: color, extra: extra)
                )
            } else if let code = child as? InlineCode {
                var codeExtra = extra
                codeExtra[.backgroundColor] = style.codeBackgroundColor
                result.append(
                    NSAttributedString(
                        string: code.code,
                        attributes: attributes(
                            font: style.codeFont,
                            color: color,
                            extra: codeExtra
                        )
                    )
                )
            } else if let link = child as? Link {
                var linkExtra = extra
                if let destination = link.destination, let url = URL(string: destination) {
                    linkExtra[.link] = url
                }
                linkExtra[.underlineStyle] = NSUnderlineStyle.single.rawValue
                result.append(
                    inline(link, font: font, color: style.accentColor, extra: linkExtra)
                )
            } else if child is SoftBreak {
                result.append(
                    NSAttributedString(
                        string: " ",
                        attributes: attributes(font: font, color: color, extra: extra)
                    )
                )
            } else if child is LineBreak {
                result.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: attributes(font: font, color: color, extra: extra)
                    )
                )
            } else if let strike = child as? Strikethrough {
                var strikeExtra = extra
                strikeExtra[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                result.append(
                    inline(strike, font: font, color: color, extra: strikeExtra)
                )
            } else if let image = child as? Image {
                // Images are not loaded into the transcript; render their alt text.
                result.append(inline(image, font: font, color: color, extra: extra))
            } else if let html = child as? InlineHTML {
                result.append(
                    NSAttributedString(
                        string: html.rawHTML,
                        attributes: attributes(font: font, color: color, extra: extra)
                    )
                )
            } else {
                result.append(inline(child, font: font, color: color, extra: extra))
            }
        }

        return result
    }

    private func attributes(
        font: UIFont,
        color: UIColor,
        extra: [NSAttributedString.Key: Any]
    ) -> [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraphStyle,
        ]
        attributes.merge(extra) { _, new in new }
        return attributes
    }

    private var paragraphStyle: NSParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 2
        return paragraph
    }

    private func italic(_ font: UIFont) -> UIFont {
        variant(font, traits: .traitItalic)
    }

    private func bold(_ font: UIFont) -> UIFont {
        variant(font, traits: .traitBold)
    }

    private func variant(
        _ font: UIFont,
        traits: UIFontDescriptor.SymbolicTraits
    ) -> UIFont {
        let descriptor = font.fontDescriptor.withSymbolicTraits(
            font.fontDescriptor.symbolicTraits.union(traits)
        )
        guard let descriptor else { return font }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }
}

private final class MarkdownCodeBlockView: UIView {
    private let scrollView = UIScrollView()
    private let label = UILabel()
    private let style: MarkdownUIStyle
    private var heightConstraint: NSLayoutConstraint!

    init(code: String, language: String?, style: MarkdownUIStyle) {
        self.style = style
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        backgroundColor = style.codeBackgroundColor
        layer.cornerRadius = 6

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsVerticalScrollIndicator = true
        scrollView.alwaysBounceVertical = false
        addSubview(scrollView)

        label.attributedText = CodeHighlighter.highlight(
            code,
            language: language,
            font: style.codeFont,
            textColor: style.secondaryTextColor,
            keywordColor: style.codeKeywordColor,
            stringColor: style.codeStringColor,
            numberColor: style.codeNumberColor,
            commentColor: style.codeCommentColor
        )
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(label)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),

            label.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            label.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            label.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            label.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
        ])

        heightConstraint = heightAnchor.constraint(equalToConstant: 40)
        heightConstraint.isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let width = max(scrollView.bounds.width, 1)
        let fit = label.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        let target = min(max(fit.height + 16, 28), 200)
        if abs(heightConstraint.constant - target) > 0.5 {
            heightConstraint.constant = target
        }
    }
}

private final class MarkdownTableView: UIView {
    private let scrollView = UIScrollView()
    private let rowsStack = UIStackView()
    private let style: MarkdownUIStyle
    private var heightConstraint: NSLayoutConstraint!

    init(table: Table, style: MarkdownUIStyle) {
        self.style = style
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        backgroundColor = style.surfaceColor
        layer.cornerRadius = 8

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsHorizontalScrollIndicator = true
        scrollView.alwaysBounceHorizontal = false
        addSubview(scrollView)

        rowsStack.axis = .vertical
        rowsStack.spacing = 0
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(rowsStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),

            rowsStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            rowsStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            rowsStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
        ])

        heightConstraint = heightAnchor.constraint(equalToConstant: 40)
        heightConstraint.isActive = true

        build(
            headers: table.head.cells.map { Self.plainText($0) },
            rows: table.body.rows.map { row in row.cells.map { Self.plainText($0) } }
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        rowsStack.layoutIfNeeded()
        let size = rowsStack.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        let target = size.height + 16
        if abs(heightConstraint.constant - target) > 0.5 {
            heightConstraint.constant = target
        }
    }

    private func build(headers: [String], rows: [[String]]) {
        rowsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let columns = max(headers.count, rows.map(\.count).max() ?? 0)
        guard columns > 0 else { return }

        let headerFont = Self.bold(style.bodyFont)
        var widths = Array(repeating: CGFloat(56), count: columns)

        for row in [headers] + rows {
            for index in 0..<columns {
                let text = index < row.count ? row[index] : ""
                let measured = (text as NSString)
                    .size(withAttributes: [.font: style.bodyFont])
                    .width
                widths[index] = max(widths[index], min(200, measured + 16))
            }
        }

        addRow(
            headers,
            widths: widths,
            columns: columns,
            font: headerFont,
            background: style.accentColor.withAlphaComponent(0.12)
        )
        addSeparator()

        for (index, row) in rows.enumerated() {
            addRow(
                row,
                widths: widths,
                columns: columns,
                font: style.bodyFont,
                background: nil
            )
            if index < rows.count - 1 {
                addSeparator()
            }
        }
    }

    private func addRow(
        _ row: [String],
        widths: [CGFloat],
        columns: Int,
        font: UIFont,
        background: UIColor?
    ) {
        let rowStack = UIStackView()
        rowStack.axis = .horizontal
        rowStack.alignment = .top
        rowStack.spacing = 0

        for index in 0..<columns {
            let cell = UIView()
            cell.translatesAutoresizingMaskIntoConstraints = false
            cell.backgroundColor = background

            let label = UILabel()
            label.text = index < row.count ? row[index] : ""
            label.font = font
            label.textColor = style.textColor
            label.numberOfLines = 0
            label.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(label)

            NSLayoutConstraint.activate([
                cell.widthAnchor.constraint(equalToConstant: widths[index]),
                label.topAnchor.constraint(equalTo: cell.topAnchor, constant: 8),
                label.bottomAnchor.constraint(equalTo: cell.bottomAnchor, constant: -8),
                label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
                label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
            ])

            rowStack.addArrangedSubview(cell)
        }

        rowsStack.addArrangedSubview(rowStack)
    }

    private func addSeparator() {
        let line = UIView()
        line.backgroundColor = style.borderColor
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        rowsStack.addArrangedSubview(line)
    }

    private static func plainText(_ markup: Markup) -> String {
        var result = ""
        for child in markup.children {
            if let text = child as? Text {
                result += text.string
            } else if let code = child as? InlineCode {
                result += code.code
            } else if child is SoftBreak {
                result += " "
            } else if child is LineBreak {
                result += "\n"
            } else {
                result += plainText(child)
            }
        }
        return result
    }

    private static func bold(_ font: UIFont) -> UIFont {
        let descriptor = font.fontDescriptor.withSymbolicTraits(
            font.fontDescriptor.symbolicTraits.union(.traitBold)
        )
        guard let descriptor else { return font }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }
}
#endif
