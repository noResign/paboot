# paboot iOS UI 适配方案

> 本文档是 iOS 客户端把 `docs/ui/`（浅色优先 + 青绿/翡翠）落到 **UIKit** 的实现适配方案。
>
> **状态（2026-10-22）**：P0–P5 已落地（工程 / 网络 / 导航 / 连接与会话列表 / 聊天 /
> 文件（含图片与视频预览）/ 设置 / 工作区 / 会话权限）。已做 / 未做清单见 §7.1，
> 代码位置与运行方式见 [ios/README.md](../../../../ios/README.md)。
>
> - 设计源：`docs/ui/shared/design-principles.md`（**唯一设计源**，token 值从它抄，不臆造、不复制到本文档）
> - 平台映射表：`docs/ui/shared/design-principles.md` §4.5
> - 参考实现（另一平台）：`docs/ui/mobile/platforms/android.md`
> - §8 的待决策项已在实现中拍板，结论见该节

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
Swift 常量。**已实现**：`App/Resources/Assets.xcassets` 下的语义色集
（Background / Surface / Border / TextPrimary / Primary / …）+ `Theme.Colors`；具体值以设计源 §4.1 为准。

### 4.2 字体

载体已定：`UIFont.preferredFont(forTextStyle:)` + **`UIFontMetrics` 承载动态字号**，设计源 §4.2 的
pt 值作为默认档位。**已实现**：`App/UI/DesignSystem/Typography.swift`
（pageTitle / cardTitle / body / caption / code）。

### 4.3 间距与圆角

载体已定：Swift 常量（照 Android `Dimens.kt` 的形式）→ Auto Layout / `layer.cornerRadius`。
**已实现**：`App/UI/DesignSystem/Spacing.swift`（`Spacing` / `Radius` / `Layout`）。

### 4.4 质感与层次

载体已定：阴影走 `CALayer`（`shadowColor` / `shadowOpacity` / `shadowRadius` / `shadowOffset`），
品牌渐变走 `CAGradientLayer`。**部分实现**：FAB 等处已使用 `CALayer` 阴影；
三层阴影与品牌渐变尚未系统化。

## 5. 图标体系 + Runtime 身份

### 5.1 图标

载体已定：**SF Symbols**，`UIImage(systemName:)`。**部分实现**：当前使用 SF Symbols；
设计源 §4.4 的语义名 → SF Symbol 完整对照尚未固定（Android 侧见 `android.md` 的「图标」一节）。

### 5.2 Runtime 身份

**已实现**：`App/UI/DesignSystem/RuntimeIdentity.swift` —— `claude` → `sparkles` + Claude 暖橙；
`codex` → `terminal` + OpenAI 绿；未知 id 用中性色 + 后端展示名兜底。
结构照 Android 的 `ui/identity/RuntimeIdentity.kt`。

## 6. 导航结构

载体已定：`UITabBarController`（底部会话 / 文件 / 任务 / 设置四个 Tab）+ `UINavigationController`
（聊天详情等 push）；需要浮层时用 `UISheetPresentationController`（对应 Android 的
`ModalBottomSheet`）。**已实现**：Tab 图标 / 尺寸、会话列表 → 聊天 push、新建会话 sheet、设置 → 工作区管理 push、
目录选择器与会话权限 sheet、文件列表 → Diff / 文件查看器 push。

## 7. 分阶段实现方案

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Xcode 工程 + 本地 SwiftPM 包 + 主题层（§4 的 token）+ 目录分层 | ✅ 已实现 |
| P1 | 网络层：DTO 对齐 `types/api.ts`、`URLSession` + `async/await`、SSE 解析、重连策略 | ✅ 已实现 |
| P2 | 导航骨架：四个 Tab + 图标 + 设计系统 | ✅ 已实现 |
| P3 | 连接页（health / sessions 校验、Keychain、最近连接）+ 单工作区会话列表 | ✅ 已实现 |
| P4 | 聊天：历史重建、流式、工具 / 思考 / 问答 / Todo、审批、模型切换、新建会话、Markdown | ✅ 已实现 |
| P5 | 文件 / Diff、设置、工作区、会话权限 | ✅ 已实现（并排 / 统一 diff、图片 / 视频预览） |
| P6 | 后台通知、无障碍、性能、TestFlight / 发布 | 🚧 未开工 |

### 7.1 已实现 / 未实现（2026-10-21）

**已实现**

- 连接页：地址 + token → `/api/health` + `/api/sessions` 校验；Keychain 保存 token；最近 5 个连接。
- 会话列表：单工作区 + 顶部切换器；根目录平铺、3 天前折叠「更早」、子目录按 cwd 分组；
  运行中标识、Agent 徽章、下拉刷新（松手停留）、重命名 / 删除、断连重连引导。
- 聊天：按 run 回放历史；SSE 实时流；`after` 续接与同一 `commandId` 重发；停止；
  工具组 / 工具卡 / 思考 / 问答卡 / Todo / 上下文占用；思考与工具卡折叠；
  权限审批；模型 / 模型参数 / 权限模式切换；新建会话 sheet。
- Markdown：`swift-markdown` AST + 原生 UIKit 渲染（标题、段落、列表、引用、代码块、GFM 表格）；
  代码块限高滚动 + 轻量语法高亮（Swift / Kotlin / JS / TS / Python / Shell / JSON）。
- 设置：连接信息（token 掩码）/ 重新连接、当前工作区 + 管理工作区、新会话默认权限模式
  （乐观更新、失败回滚）、App / daemon 版本。
- 工作区管理：切换、设默认、启用 / 禁用、重命名、左滑删除（有会话时确认级联）、
  附加目录增删、长路径展开；新增工作区走目录选择器（可浏览工作区外目录、显示隐藏目录）。
- 会话权限：聊天页「会话设置 → 权限设置…」，按 runtime 展示模式说明，切换模式（后续 Run 生效），
  撤销单个 / 全部授权。
- 文件：改动 / 全部文件两个分段；根标签栏（主目录 / 附加目录 / 书签，可新增与移除书签）、
  非 Git 根的子仓库入口；改动列表状态徽章与增删行数；单层懒加载 + 游标续页 + 隐藏目录开关；
  Diff 默认并排、可切统一（并排行可点开换行、两列共享横向滚动；统一视图可选中复制）；
  目录面包屑（`根目录 / 二级 / …`，每段可点击直接跳转）；文本查看器、图片预览与视频流式播放
  （`AVPlayerViewController`，可拖动进度、切后台暂停）；下拉与进入 Tab 自动刷新。

**未实现**

- 文件：目录内搜索、图片缩放。
- Codex `UserInput` 的 questions / form / url 专用表单（当前为通用权限 JSON）。
- 设置页的通知开关（随后台通知一起做）。
- 后台系统通知、启动自动连接、Markdown 链接跳转、语义级高亮、语音输入。
- 回滚入口（与 Android 一致，移动端不提供）、iOS UI 测试与发布流程。

## 8. 已拍板的技术决策

1. **最低 iOS 版本**：iOS 17.0（`UISheetPresentationController`、`URLSession.bytes`、Dynamic Type；
   CI 使用 iPhone 16 模拟器）。
2. **工程分层**：App target + 本地 SwiftPM 包。包内三个 target：`PabootProtocol`（纯逻辑）、
   `PabootClient`（URLSession + SSE）、`PabootMarkdownUI`（swift-markdown + UIKit 渲染）。
3. **状态管理**：MVVM + Combine，ViewModel 标 `@MainActor`；UIKit 视图订阅 `@Published`。
4. **长列表**：`UITableView` + diffable data source；聊天流式更新只 reconfigure 最后一项
   （`snapshot.reconfigureItems`）；折叠块展开时让 table 重新计算行高。
5. **Markdown**：`swift-markdown` 0.7.x（0.8+ 要求 Swift 6.2）+ 自绘 UIKit block view；
   代码块 / 表格是原生视图；语法高亮是轻量 token lexer，不做语义分析；链接仅样式、不可点击。
6. **语音输入**：不进 M1，保留占位。

## 9. 实现顺序与提交规范

按 §7 的阶段推进，每阶段单独提交；提交信息遵循 [CLAUDE.md](../../../../CLAUDE.md) 的
Conventional Commits（中文 subject，scope 用 `ios`）。
