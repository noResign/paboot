# paboot Android UI 适配（Design Token → Compose）

> 把 [docs/ui/shared/design-principles.md](../../shared/design-principles.md)（**唯一设计源**）
> 落到 Jetpack Compose 的**对应关系**。
>
> 本文**不重复列 token 的数值**（hex / 字号 / 间距）：数值只在设计源里维护，这里只记「哪个语义
> token 落到哪个 Compose 位置」。两处各存一份数值必然会漂移。
>
> - 代码位置：`app/src/main/java/com/noresign/paboot/ui/`
> - iOS 侧（P0–P4 已实现，文件 / 设置待做）：`docs/ui/mobile/platforms/ios.md`

## 1. 载体文件

| 文件 | 承载 | 设计源 |
|---|---|---|
| `ui/theme/Color.kt` | `object DesignColors`：全部语义色，浅/深各一套 | §4.1 |
| `ui/theme/Theme.kt` | `PabootTheme`：语义色 → M3 `ColorScheme` 映射；非标准色走 `LocalSemanticColors` | §4.1 |
| `ui/theme/Type.kt` | `Typography`（语义字号）+ 顶层 `CodeBody` | §4.2 |
| `ui/theme/Dimens.kt` | `object DesignDimens`：间距 / 圆角 / 最小触控 | §4.3 |
| `ui/theme/Elevation.kt` | `object DesignElevation`：三层高度 + 统一阴影色 | §4.1.1 |
| `ui/theme/Brand.kt` | `object Brand.Gradient`：品牌渐变 | §4.1.1 |
| `ui/identity/RuntimeIdentity.kt` | runtime（agent）身份映射 | §5.2 |

## 2. 语义色 → M3 ColorScheme

`Theme.kt` 把 `DesignColors` 映射进 M3 标准槽位（左右为 `DesignColors` 的字段名）：

| M3 槽位 | 浅色 | 深色 |
|---|---|---|
| `primary` / `onPrimary` | `LightPrimary` / `White` | `DarkPrimary` / `#06231A` |
| `primaryContainer` / `onPrimaryContainer` | `LightPrimarySubtle` / `LightPrimaryDeep` | `DarkPrimarySubtle` / `DarkPrimaryDeep` |
| `secondary` / `onSecondary` | `LightPrimaryDeep` / `White` | `DarkPrimaryDeep` / `#06231A` |
| `secondaryContainer` / `onSecondaryContainer` | `LightPrimarySubtle` / `LightPrimaryDeep` | `DarkPrimarySubtle` / `DarkPrimaryDeep` |
| `tertiary` / `onTertiary` | `ClaudeOrange` / `White` | `ClaudeOrange` / `#2B1500` |
| `background` / `onBackground` | `LightBg` / `LightTextPrimary` | `DarkBg` / `DarkTextPrimary` |
| `surface` / `onSurface` | `LightSurface` / `LightTextPrimary` | `DarkSurface` / `DarkTextPrimary` |
| `surfaceVariant` / `onSurfaceVariant` | `LightCodeBg` / `LightTextSecondary` | `DarkCodeBg` / `DarkTextSecondary` |
| `outline` / `outlineVariant` | `LightBorder` | `DarkBorder` |
| `error` / `onError` | `LightError` / `White` | `DarkError` / `#2B0D0C` |
| `errorContainer` / `onErrorContainer` | `LightErrorContainer` / `LightError` | `DarkErrorContainer` / `DarkError` |

M3 没有对应槽位的语义色走两个出口：

- **`success` / `warning` / `thinking`** → `LocalSemanticColors`（`SemanticColors` data class，
  随主题切换）。用法：`LocalSemanticColors.current.success`。
- **`surface2`（悬浮 / Sheet 专用）、`textMuted`** → 直接从 `DesignColors` 取。

两条必须遵守的规则：

- **不启用 `dynamicColor`**：Material You 会用系统壁纸色覆盖青绿主色，破坏整套 token。
  `PabootTheme` 里刻意没有这个分支。
- **主题策略**：默认浅色、跟随系统（`isSystemInDarkTheme()`），暂未提供手动切换。

## 3. 语义字号 → Compose TextStyle

| 语义角色 | 落点 | 字号 / 字重 / 行高 |
|---|---|---|
| 页面标题 | `titleLarge` | 20 / SemiBold / 26 |
| 列表·卡片标题 | `titleMedium` | 16 / SemiBold / 22 |
| 正文 | `bodyMedium` | 14 / Normal / 20 |
| 辅助说明 | `bodySmall`、`labelMedium` | 12 / Normal / 16 |
| 角标 | `labelSmall` | 11 / Medium / 15 |
| 代码·路径·命令·工具输出 | **`CodeBody`** | 13 / Normal / 18，等宽 |

> `CodeBody` 是 **顶层 `TextStyle`，不是 `Typography` 的成员**（M3 的 `Typography` 没有代码槽位）。
> 用法是 `Text(style = CodeBody)`，不要再用散落的 `bodySmall.copy(fontFamily = Monospace)`。

## 4. 间距 / 圆角 / 阴影 / 渐变

- `DesignDimens`：基准网格 `Grid`；间距 `Space8/12/16/20/24`；圆角 `RadiusCard` / `RadiusBubble`
  / `RadiusSheetTop`；最小触控 `MinTouch`。
- `DesignElevation`：`Level1`（卡片）/ `Level2`（悬浮·Sheet）/ `Level3`（全屏浮层·审批弹窗）
  三层高度 + 统一 `ShadowColor`。
  Compose 没有 CSS 那种多层 `box-shadow`，用
  `Modifier.shadow(elevation = Level2, shape = …, ambientColor = ShadowColor, spotColor = ShadowColor)` 近似。
- `Brand.Gradient`：仅用于 Logo、主 CTA 焦点态、连接页 hero 点缀，不滥用。

## 5. 图标

依赖 `androidx.compose.material:material-icons-extended`（在 `gradle/libs.versions.toml`）。

设计交付物只写**语义名**（§4.4），Android 侧映射到 `Icons.Rounded.*`：

| 语义名 | Compose |
|---|---|
| `chat_bubble` / `folder` / `settings` | `Icons.Rounded.ChatBubble` / `Folder` / `Settings` |
| 发送 | `Icons.AutoMirrored.Filled.Send` |
| 语音输入 / 停止 | `Icons.Rounded.Mic` |
| runtime（Claude / Codex / DeepSeek / 未知） | `Icons.Rounded.SmartToy` / `Terminal` / `Bolt` / `Build` |

其余按需从 Material Symbols（Rounded）取，当前用到的还有：`Add`、`Remove`、`Check`、`Close`、
`ExpandLess`、`ExpandMore`、`ArrowDropDown`、`Visibility`、`VisibilityOff`、
`AutoMirrored.Filled.ArrowBack`、`Filled.KeyboardArrowDown`。

**状态一律用语义图标，不用 emoji**：工具卡的成功 / 失败 / 进行中用 `Check` / `Close` /
`CircularProgressIndicator`。

## 6. Runtime 身份（`ui/identity/RuntimeIdentity.kt`）

`RuntimeIdentities` 是一张 **id → 身份** 的映射表，每个身份带 `displayName` / `icon` / `color`：

- `claude` → SmartToy + Claude 暖橙；`codex` → Terminal + 绿色；`deepseek` → Bolt + DeepSeek 蓝
  （刻意与已有 agent 用不同图标——两个 agent 同图标时，选择器里只剩颜色可分辨）。
- 未知 id 走中性兜底（`Build` 图标 + 灰），并直接展示后端返回的 name。
- **新增 agent = 表里加一行，不改布局。**

同文件另有两个工具函数：

- `defaultAgentId(agents)` —— 新建会话默认选中第一个**已安装**的 agent。不能取 `first()`：
  列表顺序是 daemon 的注册顺序，第一个很可能没装，用户一进来就选中一个发不出去的。
- `permissionModeOptions(runtime)` —— 每个 runtime 的权限模式文案。同一个模式名在不同 runtime
  下语义不同（Codex / DeepSeek 是沙箱策略、Claude 是审批策略），所以文案按 runtime 分别给。

## 7. 导航结构

```
connect（门禁，startDestination）
  ├─ main ── 底部 Tab Bar：会话 / 文件 / 任务 / 设置
  │     └─ 会话 --点卡片--> conversation?sessionId={id}（push，带顶栏返回键）
  └─ workspaces（push）
```

- 底部栏在 `ui/MainScreen.kt` 里**自绘**（`Column` + `Row` + `selectable`），没有用 M3 的
  `NavigationBar`——后者固定 80dp 高且不暴露高度参数，压不到 `docs/ui/mobile/preview.html` 里
  icon 24dp + label 10.5sp、条高约 61dp 的紧凑尺寸。
- 路由常量在 `navigation/AppRoutes.kt`。

## 8. 页面现状

| 屏幕 | 状态 |
|---|---|
| 会话列表 | 按 cwd 分组的逻辑**下沉在 `SessionListViewModel`**，产出 `SessionListModel`：根目录会话平铺置顶 + 子目录分组，子目录头显示相对路径、默认折叠 |
| 聊天 | 流式文字 / 思考块 / 工具卡 / 用量条；输入区有麦克风**占位**（点击提示「语音输入即将上线」，**未接识别**） |
| 文件 | 目录树 + 文本与媒体预览（详见 `docs/ui/mobile/pages/files.md`） |
| 连接 / 新建会话 / 设置 | 已对齐 token |

各组件的逐页规格见 `docs/ui/mobile/pages/`，交互与状态见 `docs/ui/shared/interactions.md`。

## 键盘与系统栏避让

- `MainActivity` 使用 edge-to-edge，同时设置 `windowSoftInputMode="adjustResize"`，键盘弹出时缩小可用布局。
- 根导航容器 `AppNavHost` 统一使用 `imePadding()` 并消费键盘 inset；连接、聊天等所有普通页面共享缩小后的可用高度，不在各页重复添加键盘 padding。
- 各页继续处理自己的系统栏 inset；聊天底栏仅使用 `navigationBarsPadding()`，键盘打开时根容器已消费对应高度，不再重复留白。
- 表单页保留可滚动容器，并消费 `Scaffold.innerPadding`；连接页的输入框可在键盘弹出后滚动到可见区域。弹窗与底部 Sheet 属于独立容器，沿用组件自身的键盘 inset 处理。
- 消息区域应用并消费 `Scaffold` 的 `innerPadding`，在该区域内裁剪；键盘弹出时缩小消息区域，顶部栏保持原位，文字不得绘制到系统栏后面。
