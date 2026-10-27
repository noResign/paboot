# 设计原则与全局规范（§0-§5）

> 文档索引见 [README.md](../README.md)。这是 Android / iOS 共用的设计源主体，章节编号沿用拆分前的 `ui_design.md`。

---

## 0. 产品一句话

**paboot 是一个「一个客户端，操纵你所有的 agent」的工具**：开发者在手机 / 桌面上给跑在
**自己电脑上**的编码 agent 发消息、看流式回复与工具执行卡片；任务始终在电脑上执行，
客户端只是入口。

关键认知：**客户端断连不影响任务**——电脑上的 daemon 会继续干活，重连后能接着看。

---

## 1. 产品定位与用户

| 维度 | 说明 |
|---|---|
| 产品类型 | 开发者工具（移动端 App，Android 与 iOS 共用一套 UI 规范） |
| 目标用户 | 使用 Claude Code 等编码 agent 的开发者 |
| 核心场景 | 离开电脑后（躺床上 / 通勤 / 开会 / 排队）也能看一眼任务进度、发一句新指令 |
| 竞品参照体验 | 聊天类 App（微信/Telegram）+ 终端/日志查看器 + CI 构建监控 |
| 情绪基调 | 高效、可信、清爽、精致；**不花哨、不娱乐化** |

### 1.1 使用流程（端到端）

```
首次启动 → 连接服务器(地址+token) → 会话列表 → 打开/新建会话
   → 发消息 → 看流式回复 + 工具卡片 → （必要时审批命令）→ 任务跑完 → 查看改动的文件
```

### 1.2 多 runtime（agent）与跨平台（设计必须贯彻的两条主线）

**多 runtime**：后端是插件化的（`GET /api/agents` 枚举已接入的 agent，当前 `Claude Code`）。
UI 必须对「agent 身份」可扩展——每个 agent 由 `id` 唯一标识，UI 侧维护一份 `id → 图标 + 主题色`
的映射，未知 id 有通用兜底（见 §5.2）。聊天流是 **runtime 无关**的（后端已归一化成统一事件），
所以聊天渲染、工具卡片、审批逻辑**一套实现适配所有 agent**，只有「agent 徽章/身份」随 id 变。

**跨平台**：本规范是 Android 与 iOS 共用的单一设计源。设计交付物只描述
「页面/组件/状态/交互 + 语义 Token」，不绑定平台控件；图标用**语义名**（如 `chat_bubble`），
由实现侧分别映射到 Material Symbols（Android）与 SF Symbols（iOS），见 §4.5。

---

## 2. 设计目标与原则

1. **状态第一**：用户最关心"现在跑到哪一步、成功还是失败"，运行状态必须一眼可见。
2. **流式体验顺滑**：文本逐字出现、工具卡实时更新，不能卡顿或跳动。
3. **浅色优先**：默认清爽浅色主题，同时必须提供暗色主题（跟随系统偏好或手动切换）。
4. **拇指操作**：核心操作（发消息、切换会话、返回）都在单手可及区域。
5. **信息密度适中**：不堆砌，但技术信息（路径、token、模型、token 数）要能展开看到。
6. 🔴 **安全可见**：命令审批是产品的安全边界，审批弹窗必须醒目、信息完整、不可误触。

---

## 3. 信息架构与页面地图

共 **11 个屏幕 + 2 个浮层（新建会话 Sheet / 权限审批）**，并新增一个横跨多个页面的「Workspace 切换器」。

```
┌─ 未连接 ──────────────────────────────────────┐
│  ① 连接服务器页（全屏门禁，无法跳过）            │
└───────────────┬───────────────────────────────┘
                │ 连接成功
┌───────────────▼───────────────────────────────┐
│  底部导航（自绘紧凑 Tab Bar，见 §3.2）           │
│    ② 会话      ⑤ 文件      ⑪ 任务      ⑦ 设置  │
│                                             │
│  ② 会话 Tab
│    ├─ 顶部：Workspace 切换器
│    ├─ 点击会话 ──▶ ③ 聊天详情
│    └─ FAB ──▶ ④ 新建会话（底部 Sheet）
│
│  ③ 聊天详情
│    ├─ 顶部：Workspace / Session / 权限模式
│    ├─ 进入 ──▶ ⑩ 会话权限设置
│    ├─ 定时触发标记：由定时任务「X」触发
│    └─ 审批 ──▶ Ⓟ 权限审批浮层
│
│  ⑤ 文件 Tab：改动（默认）/ 全部文件，根目录跟随当前 Workspace
│  ⑪ 任务 Tab：当前 Workspace 的定时任务，FAB 新建
│  ⑦ 设置
│    ├─ Workspace 管理 ──▶ ⑧ 工作区管理
│    └─ 新增工作区 ──▶ ⑨ 目录选择器
└─────────────────────────────────────────────┘
```

| # | 屏幕/浮层 | 类型 | 里程碑 |
|---|---|---|---|
| ① | 连接服务器 | 全屏门禁 | M1 |
| ② | 会话列表 | 主 Tab | M1 |
| ③ | 聊天详情 | 详情页（push） | M1（核心） |
| ④ | 新建会话 | 底部 Sheet | M1 |
| ⑤ | 文件（改动 / 全部文件） | Tab | M2 |
| ⑥ | Diff / 文件查看器 | 子页（push） | M2 |
| ⑦ | 设置 | Tab | M1 |
| ⑧ | 工作区管理 | 子页（push） | M2 |
| ⑨ | 目录选择器 | 子页/全屏 Sheet | M2 |
| ⑩ | 会话权限设置 | 子页（push） | M2 |
| ⑪ | 定时任务 | 主 Tab + 详情/编辑器 | M3 |
| Ⓟ | 权限审批 | 全屏浮层（覆盖在聊天页上） | M1（🔴 安全必需） |

> 交付按里程碑推进，但每个页面从第一天起按生产级质量设计。
> Workspace 切换器是横向组件，出现在 ② 会话、⑤ 文件、③ 聊天顶部信息里。

### 3.1 Workspace 与权限的作用域

- Workspace 是手机端切换的工作环境，替代原来的“daemon 全局唯一 workspace”。
- 一个 Workspace = **一个主目录 + N 个附加目录**。主目录是新 Session 的 cwd；
  附加目录只扩大 agent 的可达范围，不参与 cwd 校验。
- 每个 Session 属于一个 Workspace，Session Cwd 必须位于 Workspace **主目录**内。
- 每个 Session 有自己的权限模式：`ask` / `acceptEdits` / `bypass`。
- 切换 Workspace 后，当前客户端的会话列表、文件根目录、设置页都按新 Workspace 更新。
- 其他 Workspace 中正在运行的 Session 不受影响。

**“允许全部”的作用域**（见 `daemon/docs/permissions.md` 的「安全模型」）：Session + 工具名（MCP 为 server 级通配），
在 ⑩ 会话权限设置里撤销。

（附加目录是 Workspace 级、所有会话共用的，但它现在是**手动管理**的，不再是审批产物——
早期「批准越界读取即记目录」的机制已随读取门控移除。）

### 3.2 顶部栏与底部 Tab Bar（尺寸）

尺寸以 `docs/ui/mobile/preview.html` 为准（紧凑稿），实现时不要套平台默认高度。

**底部 Tab Bar**（会话 / 文件 / 任务 / 设置）
- **悬浮胶囊**：左右各留 **20dp**、距系统导航栏 inset **8dp**，圆角 **28dp**，胶囊高约 **56dp**。
  **不用** Material3 `NavigationBar`（固定 80dp，且不暴露高度参数）。
- 背景：iOS 用 `ultraThinMaterial` 毛玻璃；Android 用 `surface` 92% 透明度 + 1dp 细边 +
  2dp 轻阴影近似，避免灰色 `surfaceContainer` 的「实心块」观感。
- 每项：icon **20dp**、图标与文字间距 2dp；文字 **11sp**、字重 **Medium**（选中不加粗）。
- 选中：主色；未选中：次要文字色。无顶部整条分隔线（靠胶囊细边与悬浮位置分层）。

**顶部栏**
- 用 Material3 `TopAppBar` 默认高度（64dp）+ 状态栏 inset 即可，**不要再额外加状态栏高度**。
- 顶栏右侧的动作图标用**小号中性圆钮**（Android 封装成 `TopBarActionButton`：32dp
  半透明中性底、无描边、18dp 主色图标、44dp 触控区），不要裸 `IconButton`，也不要用
  大号描边圆钮或主色浅底——前者太重，后者会在顶栏形成成块的绿色。与 iOS 的 bar button 观感对齐。
- ⚠️ 每个 Tab 页各自带 Scaffold + TopAppBar，而外层 `MainScreen` 的 Scaffold 已经把系统栏 inset 算进了 `innerPadding`；
  外层必须 `consumeWindowInsets(innerPadding)`，否则 inset 会被应用两次 —— 表现为标题上方多一条状态栏高度的空白、底栏上方多一段空隙。

## 4. 全局设计规范（Design Tokens）

> 以下为建议值，设计师可在此基础上精修，但需保持**浅色优先 + 清爽精致**的统一调性。

### 4.1 色彩（浅色主题为默认）

| Token | 用途 | 浅色（默认） | 深色 |
|---|---|---|---|
| `bg` | 页面背景 | `#F6F8F7` | `#0E1512` |
| `surface` | 卡片/输入框 | `#FFFFFF` | `#17201C` |
| `surface-2` | 悬浮/Sheet/展开块 | `#FFFFFF`（配阴影分层） | `#1E2823` |
| `border` | 分隔线/描边 | `#E3EAE6` | `#293430` |
| `text-primary` | 主文字 | `#16211D` | `#E7EFEB` |
| `text-secondary` | 次文字 | `#5A6B64` | `#A2B0AA` |
| `text-muted` | 弱化/占位 | `#93A29A` | `#6D7C75` |
| `primary` | 主按钮/高亮（青绿） | `#0E9F86` | `#2BC7A4` |
| `primary-deep` | 按压/激活态 | `#0A7D6B` | `#4AD8B8` |
| `primary-subtle` | 选中底色/胶囊 | `#E2F3EE` | `#12332B` |
| `success` | 成功/完成（翡翠绿） | `#18A058` | `#4CC38A` |
| `warning` | 警告/进行中 | `#B7791F` | `#E0B14A` |
| `error` | 错误/失败/危险 | `#D6423E` | `#F26D6D` |
| `thinking` | 思考中文字 | `#9AA8A2` | `#85938C` |
| `code-bg` | 代码/工具输出底色 | `#F2F5F3` | `#101815` |

> 运行态主色用 `primary`（青绿）；成功/失败分别用 `success`（翡翠绿）/`error`；审批弹窗的「拒绝」用 `error`。
> 强调色与成功色同为绿色系，需靠**色相区分**：`primary` 偏青（teal），`success` 偏绿（emerald），避免同屏混淆。

> **桌面浅色例外**：desktop 在浅色下把 `bg` 用 `#F4F7F5`、`surface-2` 用 `#EDF2EF`（白色只留给
> `surface` 的栏面），并新增 `--accent-bar = color-mix(primary 55%, surface-2)` 作为选中行左边条；
> **桌面选中不用整块 `primary-subtle`**。移动端仍用本表原值。三层面模型见
> [desktop/design.md](../desktop/design.md) §4。

### 4.1.1 质感与层次（"高级感"的关键）

浅色主题的高级感**不靠黑底，靠层次与留白**：

- **阴影分层**：卡片/Sheet 用低透明阴影抬升，而不是粗描边。三层阴影 Token：
  `elevation-1`（卡片，`0 1px 2px rgba(22,33,29,.06)`）、
  `elevation-2`（悬浮/Sheet，`0 8px 24px rgba(22,33,29,.10)`）、
  `elevation-3`（全屏浮层/审批弹窗，`0 16px 48px rgba(22,33,29,.18)`）。
- **描边极淡**：分隔用 1px `border`，只在需要时出现，避免"表格感"。
- **留白充足**：页面左右留白 20，区块间距 24+，让界面"呼吸"。
- **品牌渐变**：`linear-gradient(135deg, #0E9F86 → #18C9A6)` 仅用于 Logo、主 CTA 焦点态、
  连接页 hero 点缀；点到为止，不滥用渐变。
- **毛玻璃（可选）**：顶栏/底栏可用半透明 `surface` + 轻微 backdrop blur，营造悬浮感。

### 4.2 字体（语义字号，跨平台）

| 语义角色 | 字号（Android sp / iOS pt） | 字重 | 字体 |
|---|---|---|---|
| 页面标题 | 20 | SemiBold | 系统默认 |
| 列表标题/卡片标题 | 16 | SemiBold | 系统默认 |
| 正文 | 14 | Regular | 系统默认 |
| 辅助说明 | 12 | Regular | 系统默认 |
| 代码/路径/token/命令/工具输出 | 13 | Regular | **等宽**（JetBrains Mono / SF Mono / Roboto Mono） |

> 用语义角色（title/body/caption/code）实现，不硬编码字号；两端用各自平台的标准字号刻度对齐。

### 4.3 间距与圆角

- 基准网格 **4**（dp/pt）；常用间距 8 / 12 / 16 / 20 / 24。
- 卡片圆角 **12**；消息气泡 **16**；底部 Sheet 顶部圆角 **24**。
- 最小触控目标 **48**。

### 4.4 图标（语义名，跨平台映射）

- 设计交付物里只写**语义名**；实现侧映射：Android → Material Symbols（Rounded），iOS → SF Symbols（同义）。
- **桌面**不映射系统图标库，改用本地 stroke icon set（`desktop/src/renderer/src/ui/Icon.tsx`）：
  24 网格 / 1.75 描边 / 15–16px / `currentColor`；**不要用 emoji 或字符字形**（⏰ ⚙ ◧ ⇤ 之类）。
- 关键语义名：会话=`chat_bubble`、文件=`folder`、设置=`settings`、发送=`arrow_upward`、
  语音输入=`microphone`、停止语音=`mic_off`、运行中=`spinner`/动画、复制=`content_copy`、
  重连=`sync`、审批=`shield`/`gavel`。

### 4.5 跨平台实现映射（给开发，设计无需关心）

| 关注点 | Android | iOS | Desktop |
|---|---|---|---|
| UI 框架 | Jetpack Compose + Material 3 | UIKit（+ 对应 HIG） | Electron + React |
| 颜色 | 直接复用 §4.1 的 hex token | 同 token（`UIColor` / Asset Catalog） | 同 token；浅色 surface 例外见 §4.1 注记 |
| 字号 | sp | pt（按 §4.2 语义角色对齐，走 Dynamic Type） | px（不跟随系统字号） |
| 图标 | Material Symbols（Rounded） | SF Symbols（`UIImage(systemName:)`） | `ui/Icon` 本地 stroke set |
| 导航容器 | NavigationBar / BottomAppBar | `UITabBarController` / `UINavigationController` | 左栏 + 主区 + 可选右栏 |
| 底部 Sheet | ModalBottomSheet | `UISheetPresentationController` | 居中模态 |
| 等宽字体 | JetBrains Mono / Roboto Mono | SF Mono / Menlo | JetBrains Mono / SF Mono / Cascadia Code |

> 两者共享同一套语义设计，不追求像素级一致，但**信息架构、组件、状态、交互必须完全一致**。
> iOS 侧是命令式的 UIKit：token 落到 `UIColor` / `UIFont` / Auto Layout，页面结构照 §6 的逐页
> 规格一一对应，不因为框架差异而改设计。

---

## 5. 组件库

设计师需产出以下可复用组件的规范（含各状态）：

| 组件 | 状态 | 说明 |
|---|---|---|
| **消息气泡** | 用户/助手 | 用户右对齐主色底；助手左对齐 surface 底 |
| **工具卡片** | running / done / error / interrupted | 核心组件，见 5.1 |
| **工具组** | 折叠 / 展开 | 连续工具调用折成一行摘要，见 5.1.1 |
| **思考卡片** | 思考中 / 完成 | 置灰、不可展开；思考中标题行转圈（正文不下发）；**桌面为一行状态（思考中 + 三点），不画卡片** |
| **运行状态条** | 进行中 / 完成 / 失败 / 取消 | 聊天页顶部横幅，见 6.3 |
| **Runtime 身份** | 徽章 / 图标 / 主题色 | 每个 agent 一套可扩展身份，见 5.2 |
| **权限模式徽章** | — | 显示 **Session 级**权限模式，危险模式用 error 色 |
| **Workspace 切换器** | 当前 / 切换中 / 空 | 会话/文件/任务/设置共用，点击进入工作区管理或目录选择 |
| **运行中指示器** | running / idle | 会话列表 & 聊天页的脉冲/转圈 |
| **子目录分组头** | 展开 / 折叠 | 会话列表里 workspace 内子目录会话的段头，见 6.2 |
| **空态插画** | — | 各列表空态 |
| **连接状态胶囊** | connected / connecting / offline / reconnecting | 全局 |
| **Usage 计量条** | — | token 数 + 成本，消息末尾 |
| **语音输入** | idle / listening / 转写中 / 完成 / 失败 | 聊天输入区麦克风入口，见 6.3 与 7.6 |
| 🔴 **权限审批卡片** | pending / allowed / denied / 超时 | 见 6.7 |

### 5.1 工具卡片（Tool Card）详细规格

展示 agent 正在/已经执行的一次工具调用。字段：`名称` + `图标` + `状态` + `可展开的入参/结果`。

- 头部：工具图标 + 工具名（如 `Write` / `Edit` / `Bash` / `Read` / `WebFetch`）+ 状态图标。
- 状态图标：running = 转圈（primary）；done = ✓（success）；error = ✗（error）；interrupted = —（warning）。
  `interrupted` 指 run 结束时工具还没返回（取消 / 崩溃 / 空闲超时），**不是失败**——没拿到结果不等于出错，
  展开区在无 `result` 时显示「已中断，未返回结果」。
- 展开区：`input`（入参）与 `result`（结果），等宽字体、代码块样式、可复制、可滚动。
- 工具名 → 图标映射建议：

| 工具名 | 图标 | 工具名 | 图标 |
|---|---|---|---|
| Write | `edit` | Bash | `terminal` |
| Edit | `edit` | Read | `article` |
| Glob | `search` | Grep | `find_in_page` |
| WebFetch / WebSearch | `language` | 其他 | `build` |

### 5.1.1 工具组（Tool Group）

一个 run 常在两句正文之间**连续**打十几个工具调用，逐张卡片渲染会把真正的回答挤出屏幕。所以
相邻的工具调用**折成一组**，折叠时只占一行。

- 🔴 **分组判据是「相邻」，不是工具名、也不是数量阈值**：只有真正插入的正文（`text_delta`）/
  思考卡片（`thinking_start`）/ 提问（User Input，见 6.5.1）才断组。**单个工具调用也成组**——
  统一行高，避免参差的卡片把正文切碎。
- 折叠行：`N 个工具调用 · Write, Bash, Read…`（工具名**去重**、最多列 3 个，超出补 `…`）+
  状态摘要（`2 个运行中 · 1 个失败 · 1 个中断`，无异常时省略）。
- 展开后逐个渲染 5.1 的**工具卡片**，卡片各自的展开态保留。
- 默认**折叠**；点击折叠行展开/收起该组。
- 断组只发生在正文/思考卡片/提问处，所以流式期间一个组只会**在尾部追加**、不会整体重排。

### 5.2 Runtime（Agent）身份系统

后端 `GET /api/agents` 返回 `[{id, name, bin, available}]`，`id` 是稳定标识（当前 `claude`、`codex`、`deepseek`）。
`available` 是 daemon 探测 `--version` 的结果；**没装的 agent 仍要列出来但置灰不可选**（用户能知道它
存在，而不是发出去换回一个 503）。UI 侧维护一份 **`id → 身份`** 映射表，包含：**图标、主题色、展示名**。
未知 id 用通用兜底（`build` 图标 + 中性色 + 直接用后端 `name`）。

当前映射：

| id | 展示名 | 图标（语义名） | 主题色 |
|---|---|---|---|
| `claude` | Claude Code | `smart_toy` / 品牌图标 | `#D97757`（Claude 暖橙） |
| `codex` | Codex | `terminal` | `#10A37F`（OpenAI 绿） |
| `deepseek` | DeepSeek Harness | `bolt` | `#4D6BFE`（DeepSeek 蓝） |
| `opencode`（预留） | OpenCode | `code` | 待定 |
| *（未知）* | 后端 `name` | `build` | `text-secondary` |

> 每个 runtime 的图标必须互不相同：同图标时选择器里只剩颜色可分辨，等于没有身份。

出现位置：会话列表卡片、聊天页顶栏、新建会话的 agent 选择器、设置页默认 agent。设计时把这套身份做成**可配置的映射**，新增 agent 只需加一行，不改布局。

> 品牌强调色是全局青绿（§4.1 的 `primary`），与各 runtime 的身份色是**两套体系**：
> `primary` 管"产品自身的按钮/焦点"，身份色只用于"标识这是哪个 agent"。Claude 的暖橙与青绿品牌色
> 恰好形成冷暖对比，拉开辨识度。

---
