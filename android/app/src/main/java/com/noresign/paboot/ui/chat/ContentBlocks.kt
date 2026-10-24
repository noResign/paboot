package com.noresign.paboot.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.noresign.paboot.model.chat.ContentBlock
import com.noresign.paboot.model.chat.UsageInfo
import com.noresign.paboot.model.chat.describeToolGroup
import com.noresign.paboot.ui.theme.CodeBody
import com.noresign.paboot.ui.theme.LocalSemanticColors
import com.mikepenz.markdown.compose.LocalMarkdownColors
import com.mikepenz.markdown.compose.LocalMarkdownDimens
import com.mikepenz.markdown.compose.components.MarkdownComponentModel
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownAnimations
import com.mikepenz.markdown.utils.buildMarkdownAnnotatedString
import kotlinx.coroutines.delay
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.intellij.markdown.flavours.gfm.GFMTokenTypes

@Composable
internal fun TextBlock(text: String, streaming: Boolean) {
    // 全程都用 Markdown 渲染：流式期间若先纯文本、结束再排版，会在结束时整体重排"闪一下"。
    // 流式期间正文每帧都在变，所以按 ~200ms 采样，限制 Markdown 的重解析频率。
    val content = if (streaming) rememberSampledText(text) else text
    // 自定义表格组件；remember 住，避免每次重组都新建 MarkdownComponents 连累整棵树重组
    val components = remember { markdownComponents(table = { model -> ChatMarkdownTable(model) }) }

    Surface(
        shape = RoundedCornerShape(16.dp),
        // 设计规范：助手气泡用 surface（白）；代码/表格才用 code-bg
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Markdown(
            content = content,
            colors = chatMarkdownColors(),
            typography = chatMarkdownTypography(),
            // 默认会给内容挂 animateContentSize()，流式下每 200ms 触发一次尺寸动画，看起来一直在闪
            animations = markdownAnimations(animateTextSize = { this }),
            components = components,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

/** Markdown 配色：跟随设计 token（链接/行内代码主色，代码与表格用 code-bg）。 */
@Composable
private fun chatMarkdownColors() = markdownColor(
    text = MaterialTheme.colorScheme.onSurface,
    codeText = MaterialTheme.colorScheme.onSurface,
    inlineCodeText = MaterialTheme.colorScheme.primary,
    linkText = MaterialTheme.colorScheme.primary,
    codeBackground = MaterialTheme.colorScheme.surfaceVariant,
    inlineCodeBackground = MaterialTheme.colorScheme.surfaceVariant,
    dividerColor = MaterialTheme.colorScheme.outlineVariant,
    tableText = MaterialTheme.colorScheme.onSurface,
    tableBackground = MaterialTheme.colorScheme.surfaceVariant,
)

/** 聊天气泡里的 Markdown 排版：默认 h1 是 displayLarge(57sp)，手机上大得离谱，压到正文量级。
 *  h1/h2 = 正文色加粗；h3 及以下 = 主色青绿。 */
@Composable
private fun chatMarkdownTypography() = markdownTypography(
    h1 = MaterialTheme.typography.titleMedium.copy(
        color = MaterialTheme.colorScheme.onSurface,
        fontWeight = FontWeight.Bold,
    ),
    h2 = MaterialTheme.typography.titleMedium.copy(
        color = MaterialTheme.colorScheme.onSurface,
        fontWeight = FontWeight.Bold,
    ),
    h3 = MaterialTheme.typography.titleSmall.copy(color = MaterialTheme.colorScheme.primary),
    h4 = MaterialTheme.typography.bodyMedium.copy(
        color = MaterialTheme.colorScheme.primary,
        fontWeight = FontWeight.SemiBold,
    ),
    h5 = MaterialTheme.typography.bodyMedium.copy(
        color = MaterialTheme.colorScheme.primary,
        fontWeight = FontWeight.SemiBold,
    ),
    h6 = MaterialTheme.typography.bodyMedium.copy(
        color = MaterialTheme.colorScheme.primary,
        fontWeight = FontWeight.SemiBold,
    ),
    text = MaterialTheme.typography.bodyMedium,
    paragraph = MaterialTheme.typography.bodyMedium,
    ordered = MaterialTheme.typography.bodyMedium,
    bullet = MaterialTheme.typography.bodyMedium,
    list = MaterialTheme.typography.bodyMedium,
    code = CodeBody,
    inlineCode = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
    quote = MaterialTheme.typography.bodyMedium,
    link = MaterialTheme.typography.bodyMedium.copy(
        color = MaterialTheme.colorScheme.primary,
        textDecoration = TextDecoration.Underline,
    ),
)

/** 每 [intervalMs] 采样一次最新文本；流式期间用它限制 Markdown 的解析频率。 */
@Composable
private fun rememberSampledText(text: String, intervalMs: Long = 200L): String {
    val latest = rememberUpdatedState(text)
    val sampled by produceState(initialValue = text) {
        while (true) {
            delay(intervalMs)
            value = latest.value
        }
    }
    return sampled
}

/**
 * 思考卡片。正文不下发，卡片只是一行状态：思考中转圈，结束后停止。
 * 没有内容可展开，所以不可点击。
 */
@Composable
internal fun ThinkingBlock(active: Boolean) {
    val thinkingColor = LocalSemanticColors.current.thinking
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp),
        ) {
            if (active) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = thinkingColor,
                )
            }
            Text(
                text = if (active) "思考中" else "思考",
                style = MaterialTheme.typography.labelSmall,
                color = thinkingColor,
            )
        }
    }
}

/**
 * 连续的工具调用折成一行。一个 run 常打十几个调用，每张卡各自展开会把真正的回答挤出屏幕。
 */
@Composable
internal fun ToolGroupView(tools: List<ContentBlock.ToolUse>) {
    var expanded by remember { mutableStateOf(false) }
    val running = tools.count { it.running }
    val failed = tools.count { it.isError }
    val interrupted = tools.count { it.interrupted }
    val status = buildList {
        if (running > 0) add("$running 个运行中")
        if (failed > 0) add("$failed 个失败")
        if (interrupted > 0) add("$interrupted 个中断")
    }.joinToString(" · ")

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            ) {
                Text(
                    text = if (expanded) "▾" else "▸",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = describeToolGroup(tools),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                if (status.isNotEmpty()) {
                    Text(
                        text = status,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Text(
                    text = if (expanded) "收起" else "展开",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (expanded) {
                Spacer(modifier = Modifier.height(8.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    tools.forEach { ToolCardView(it) }
                }
            }
        }
    }
}

@Composable
internal fun ToolCardView(card: ContentBlock.ToolUse) {
    var expanded by remember { mutableStateOf(false) }
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                when {
                    card.running -> CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                    // 「中断」（run 结束了工具还没返回）不是「失败」：没结果不代表出错
                    card.interrupted -> Icon(
                        Icons.Rounded.Remove,
                        contentDescription = "已中断",
                        tint = LocalSemanticColors.current.warning,
                        modifier = Modifier.size(16.dp),
                    )
                    card.isError -> Icon(
                        Icons.Rounded.Close,
                        contentDescription = "失败",
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(16.dp),
                    )
                    else -> Icon(
                        Icons.Rounded.Check,
                        contentDescription = "完成",
                        tint = LocalSemanticColors.current.success,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = card.name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = if (expanded) "收起" else "展开",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded) {
                if (card.input != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    CodeBlock(card.input.toString())
                }
                if (!card.result.isNullOrBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    CodeBlock(card.result)
                } else if (card.interrupted) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "已中断，未返回结果",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
internal fun CodeBlock(text: String) {
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Box(modifier = Modifier.fillMaxWidth().heightIn(max = 200.dp)) {
            Text(
                text = text,
                style = CodeBody,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(8.dp)
                    .verticalScroll(rememberScrollState()),
            )
        }
    }
}

@Composable
internal fun UsageLine(usage: UsageInfo) {
    val parts = mutableListOf<String>()
    usage.inputTokens?.let { parts.add("↑$it") }
    usage.outputTokens?.let { parts.add("↓$it") }
    val cost = usage.costUsd?.let { "$" + "%.2f".format(it) }
    val tokens = if (parts.isNotEmpty()) parts.joinToString(" ") + " tokens" else ""
    val line = listOfNotNull(tokens, cost).filter { it.isNotBlank() }.joinToString(" · ")
    if (line.isNotBlank()) {
        Text(
            text = line,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * 自定义表格组件：库默认的单元格是单行 + 省略号（长内容只剩 "…"），
 * 这里改成按列宽换行、列宽固定以便各行列对齐、整表可横向滚动。
 * 超长内容默认收起到 [COLLAPSED_CELL_LINES] 行，点单元格展开全文、再点收起。
 */
@Composable
private fun ChatMarkdownTable(model: MarkdownComponentModel) {
    val content = model.content
    val baseStyle = model.typography.text

    Surface(
        color = LocalMarkdownColors.current.tableBackground,
        shape = RoundedCornerShape(LocalMarkdownDimens.current.tableCornerSize),
    ) {
        Column(modifier = Modifier.horizontalScroll(rememberScrollState())) {
            model.node.children.forEach { section ->
                when (section.type) {
                    GFMElementTypes.HEADER, GFMElementTypes.ROW -> {
                        val header = section.type == GFMElementTypes.HEADER
                        Row(
                            modifier = if (header) {
                                // 表头用 primary-subtle 底色，和正文行区分开
                                Modifier.background(MaterialTheme.colorScheme.primaryContainer)
                            } else {
                                Modifier
                            },
                        ) {
                            section.children.forEach { cell ->
                                if (cell.type != GFMTokenTypes.CELL) return@forEach
                                ChatMarkdownTableCell(
                                    text = content.buildMarkdownAnnotatedString(cell, baseStyle),
                                    style = if (header) {
                                        baseStyle.copy(fontWeight = FontWeight.Bold)
                                    } else {
                                        baseStyle
                                    },
                                    color = if (header) {
                                        MaterialTheme.colorScheme.onPrimaryContainer
                                    } else {
                                        LocalMarkdownColors.current.tableText
                                    },
                                )
                            }
                        }
                    }
                    GFMTokenTypes.TABLE_SEPARATOR -> HorizontalDivider(
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                }
            }
        }
    }
}

/** 收起状态下单元格显示的行数。 */
private const val COLLAPSED_CELL_LINES = 4

/**
 * 单元格文本：默认收起到 [COLLAPSED_CELL_LINES] 行（超出的末尾显示 "…"），
 * 点一下展开全文、再点收起。只有确实溢出的单元格才可点，短文本不劫持点击。
 */
@Composable
private fun ChatMarkdownTableCell(
    text: AnnotatedString,
    style: TextStyle,
    color: Color,
) {
    var expanded by remember { mutableStateOf(false) }
    var overflowed by remember { mutableStateOf(false) }
    val dimens = LocalMarkdownDimens.current

    Text(
        text = text,
        style = style,
        color = color,
        maxLines = if (expanded) Int.MAX_VALUE else COLLAPSED_CELL_LINES,
        overflow = TextOverflow.Ellipsis,
        // 只在收起时重新测量：展开后 hasVisualOverflow 必然为 false，会把可点状态判丢
        onTextLayout = { if (!expanded) overflowed = it.hasVisualOverflow },
        modifier = Modifier
            .width(dimens.tableCellWidth)
            .then(
                if (overflowed) {
                    Modifier.clickable(onClickLabel = if (expanded) "收起" else "展开") {
                        expanded = !expanded
                    }
                } else {
                    Modifier
                },
            )
            .padding(dimens.tableCellPadding),
    )
}
