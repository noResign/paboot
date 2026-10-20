# paboot UI 设计

> 分三层：**共享规范**（跨平台）+ **移动端**（Android / iOS 共用一套）+ **桌面端**（Electron）。
> 三者是同一份语义设计，各平台只改落地形态（导航容器、页面容器、密度、输入方式），
> 不改信息架构、组件与交互语义。
>
> 这是**要长期使用的正式产品（非一次性 MVP）**：所有页面、所有状态都按生产级质量设计，
> 并预留多 runtime（agent）扩展——当前接入 Claude Code 与 Codex（见
> [shared/design-principles.md](shared/design-principles.md) §1.2）。

## 共享规范 · [`shared/`](shared/)

跨平台的设计源。**token 的数值只在这里维护**，各平台文档只记「落到哪里」，不复制数值。

| 文件 | 内容 |
|---|---|
| [shared/design-principles.md](shared/design-principles.md) | **总纲**：产品定位 / 设计目标与原则 / 信息架构与页面地图 / **Design Tokens** / 组件库（§0–§5） |
| [shared/interactions.md](shared/interactions.md) | 关键交互与状态：命令审批流、并发运行、断线重连、流式渲染、状态胶囊（§7） |
| [shared/appendix.md](shared/appendix.md) | 数据与界面映射 / 交付里程碑 / 交付物清单 / 后端接口契约（§8–§10 + 附录） |

## 移动端 · [`mobile/`](mobile/)

Android 与 iOS **共用同一套**页面规格与交互；平台差异只体现在实现落地。

| 文件 | 内容 |
|---|---|
| [mobile/pages/connect.md](mobile/pages/connect.md) | ① 连接服务器页（§6.1） |
| [mobile/pages/sessions.md](mobile/pages/sessions.md) | ② 会话列表（§6.2） |
| [mobile/pages/chat.md](mobile/pages/chat.md) | ③ 聊天详情（§6.3，核心页） |
| [mobile/pages/new-session.md](mobile/pages/new-session.md) | ④ 新建 / 续接会话（§6.4） |
| [mobile/pages/files.md](mobile/pages/files.md) | ⑤ 文件浏览 + ⑥ Diff / 文件查看器（§6.5） |
| [mobile/pages/settings.md](mobile/pages/settings.md) | ⑦ 设置 + ⑧ 工作区管理 + ⑨ 目录选择器 + ⑩ 会话权限（§6.6） |
| [mobile/pages/permission-approval.md](mobile/pages/permission-approval.md) | Ⓟ 权限审批浮层（§6.7，安全边界） |
| [mobile/platforms/android.md](mobile/platforms/android.md) | Android 落地：Design Token → Jetpack Compose 的对应关系 |
| [mobile/platforms/ios.md](mobile/platforms/ios.md) | iOS 落地：UIKit（P0–P4 已实现，文件 / 设置待做） |
| [mobile/preview.html](mobile/preview.html) | 可交互原型，浏览器直接打开 |

## 桌面端 · [`desktop/`](desktop/)

Electron 客户端。**沿用**共享规范的全部 token、组件语义与交互语义；**改写**导航容器、页面容器、
密度与输入方式（触摸 → 鼠标键盘）；**新增**本机 daemon 管理、多窗口、托盘、快捷键、右键菜单。

| 文件 | 内容 |
|---|---|
| [desktop/design.md](desktop/design.md) | 桌面端规范：与共享规范的关系、桌面设计原则、页面地图与逐页索引 |
| [desktop/pages/](desktop/pages/) | 逐页规格，每页只写**与移动端的差异**（另有 ⑥ 本机 daemon 管理为桌面独有） |
| [desktop/preview.html](desktop/preview.html) | 可交互原型 |

## 图例

- 🟢 = 后端已支持，可直接做
- 🟡 = 后端**尚未支持**，UI 按此设计，但需后端补能力（见 [shared/appendix.md](shared/appendix.md) 附录 B）
- 🔴 = 安全边界，设计必须覆盖

页面地图（信息架构）：移动端见 [shared/design-principles.md](shared/design-principles.md) §3，
桌面端见 [desktop/design.md](desktop/design.md)。

## 后端契约

协议见 [daemon/docs/protocol.md](../../daemon/docs/protocol.md)，权限与安全模型见
[daemon/docs/permissions.md](../../daemon/docs/permissions.md)。
