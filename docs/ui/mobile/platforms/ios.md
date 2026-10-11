# paboot iOS UI 适配方案

> 本文档是 iOS 客户端把 `docs/ui/`（浅色优先 + 青绿/翡翠）落到 **UIKit** 的实现适配方案。
>
> **当前是骨架**：章节结构与待填项已列出，能先确定的部分（载体选型、控件对应）已写实，
> 标注「待填 / 待定」的部分在开工时补齐。它的作用是让开工时不用重新想一遍。
>
> - 设计源：`docs/ui/shared/design-principles.md`（**唯一设计源**，token 值从它抄，不臆造、不复制到本文档）
> - 平台映射表：`docs/ui/shared/design-principles.md` §4.5
> - 参考实现（另一平台）：`docs/ui/mobile/platforms/android.md`
> - 状态：未开工（见 §8 待决策项）

---

## 1. 目标与范围

（待填）与 Android 那份的关键区别：Android 是**改造已有 App**，iOS 是**从零建工程**，所以这里
没有「现状诊断」，取而代之的是工程结构与技术选型（§2）。

目标：照 [docs/ui/](../../README.md) 做出一套与 Android 在**信息架构、组件、状态、交互**
上完全一致的客户端——不追求像素级一致，但不允许因为框架差异而改设计。

## 2. 工程结构（iOS 特有）

（待定）需要拍板的几点：

- 单 App target + 目录分层，还是「App target + 内部 Swift Package」对应 Android 的
  `:app` / `:lib-network` 两个模块
- 目录分层（参考 Android：`data/repository`、`data/local`、`viewmodel`、`ui`、`navigation`）
- CocoaPods 接入方式（`Podfile` + `.xcworkspace`；`Podfile.lock` 入库、`Pods/` 忽略）
- SwiftLint / 单测框架（XCTest 还是 Quick·Nimble）是否引入

## 3. 适配总原则

- **设计源唯一**：所有 token 值从 `docs/ui/shared/design-principles.md` §4 抄，不在业务代码里写死
- **纯代码 UI**：不用 Storyboard / XIB，Auto Layout 用代码写
- **runtime 身份可配置映射**：新增 agent 只加一行，不改布局
- **分层不串**：UI 层不碰网络；网络层不引 UIKit

## 4. Design Token → UIKit 落地

每节登记三样：语义名（设计源）→ UIKit 载体 → 目标文件。

### 4.1 色彩

载体已定：**Asset Catalog 颜色集 + `UIColor(named:)`**（自动支持浅色 / 深色），语义色再包一层
Swift 常量。（待填）逐项映射表：设计源 §4.1 的每个语义角色 → 颜色集名 → Swift 属性名。

### 4.2 字体

载体已定：`UIFont.preferredFont(forTextStyle:)` + **`UIFontMetrics` 承载动态字号**，设计源 §4.2 的
pt 值作为默认档位。（待填）语义角色 → text style → 缩放基准的映射表。

### 4.3 间距与圆角

载体已定：Swift 常量（照 Android `Dimens.kt` 的形式）→ Auto Layout / `layer.cornerRadius`。
（待填）逐个 token 的常量命名。

### 4.4 质感与层次

载体已定：阴影走 `CALayer`（`shadowColor` / `shadowOpacity` / `shadowRadius` / `shadowOffset`），
品牌渐变走 `CAGradientLayer`。（待填）三层阴影的取值映射。

## 5. 图标体系 + Runtime 身份

### 5.1 图标

载体已定：**SF Symbols**，`UIImage(systemName:)`。（待填）设计源 §4.4 的语义名 → SF Symbol 名
对照表（Android 侧对应 Material Symbols，见它的 `android.md` 的「图标」一节）。

### 5.2 Runtime 身份

（待填）映射表：`runtime id`（如 `claude`）→ SF Symbol + 主题色 + 展示名；未知 id 的中性兜底。
结构照 Android 的 `ui/identity/RuntimeIdentity.kt`，iOS 侧建议同名的 Swift 类型。

## 6. 导航结构

载体已定：`UITabBarController`（底部会话 / 文件 / 设置三个 Tab）+ `UINavigationController`
（聊天详情等 push）；需要浮层时用 `UISheetPresentationController`（对应 Android 的
`ModalBottomSheet`）。（待填）Tab 尺寸与图标、push 层级图。

## 7. 分阶段实现方案

（骨架，验收标准待细化）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | Xcode 工程 + CocoaPods + 主题层（§4 的 token）+ 目录分层 | 空工程能跑起来，主题色/字号与设计源一致 |
| P1 | 网络层：DTO 对齐 `types/api.ts`、`URLSession` + `async/await`、SSE 解析（纯逻辑 + 单测） | 对本地 daemon 发一条 prompt 能收到事件流 |
| P2 | 导航骨架：三个空页面 + Tab 图标 | 三个 Tab 可切换 |
| P3 | 连接页 + 会话列表 | 能连上 daemon、列出会话（含分组） |
| P4 | 聊天详情：流式渲染、工具卡片、审批浮层 | 端到端可用；断线重连不丢进度 |
| P5 | 文件 / Diff、设置、工作区、会话权限 | 与 Android 功能对齐 |

P4 是最重的一段（对应 Android 侧最复杂的页面），建议 P1 先把网络层与 SSE 打磨好再动。

## 8. 待决策项（开工前拍板）

1. **最低 iOS 版本** —— 决定可用 API：`UISheetPresentationController` 要 iOS 15+；也决定能对齐的
   Xcode 版本
2. **工程分层** —— 单 target 还是 App + 内部 Swift Package（对应 Android 的两模块）
3. **状态管理** —— 自建 observable / Combine / 第三方；Android 侧是 `ViewModel` + `StateFlow`，
   iOS 没有官方等价物，选型会影响整个 UI 层的写法
4. **长列表实现** —— 聊天页用 `UITableView` 还是 `UICollectionView`（影响预取、自适应高度、
   插入动画），这是性能最关键的一处
5. **Markdown 渲染** —— Android 侧有专门方案（见 `android/docs/local/markdown.md`，
   本机私有）；iOS 用哪个方案或自研
6. **语音输入** —— 是否进 M1，还是先留占位按钮（Android 侧目前是占位）

## 9. 实现顺序与提交规范

按 §7 的阶段推进，每阶段单独提交；提交信息遵循 [CLAUDE.md](../../../../CLAUDE.md) 的
Conventional Commits（中文 subject，scope 用 `ios`）。
