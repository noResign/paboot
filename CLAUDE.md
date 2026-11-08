# CLAUDE.md

本文件是这个仓库的**纲领性**入口指南。进入 `paboot/` 前先读这里，再按需读对应子项目的
`README.md` 与 `docs/`。细节以各文档为准，本文件只讲原则与边界。

## 项目简介

**paboot** 是一个「一个客户端，操纵你所有的 agent」的项目：电脑上跑一个 daemon，用它驱动
本机编码 agent（已接入 Claude Code、Codex、DeepSeek Harness，以及自研的 Builtin runtime，
后续还有更多），把输出解析成统一流式事件，通过 HTTP/SSE 推给手机与桌面客户端
（Android / iOS / desktop），并支持会话续接、断线重连、取消、工具审批、多 agent 并发。

运行时按驱动方式分**三条路径**接入：

- argv + stdout 流式的实现 `RuntimeAdapter`（当前只有 Claude Code）；
- RPC 对等的用 `RuntimeDetector` 登记 + 专用会话驱动（Codex 走 `codex app-server` 的 JSON-RPC，
  DeepSeek Harness 走 `dsh acp` 的 ACP JSON-RPC，**都不实现 `RuntimeAdapter`**）；
- **Builtin** 是 daemon 进程内的自研 runtime（`runtimes/builtin/`）：共享 `llm/` provider 目录，
  内部 AgentKernel 跑 tool / MCP / skill / image，自带 driver，不 spawn 外部 CLI。

所有运行时都注册 `RuntimeDriver`，chat 路由按 id 取 driver、不写 runtime 分支。未来可加
OpenCode 等。客户端**多 runtime 可扩展**：事件流是 runtime 无关的，
UI 只对「agent 身份」做可配置映射。

定位不止于「操纵 agent」，分四个阶段演进：

1. **接入与互通**：把各家 agent 接进来，一个客户端操纵多个品牌的 agent；桌面端与移动端互通。
2. **面向岗位**：针对具体岗位做定向改造，提升效率，探索 agent 协助的新方式。
3. **Personal agent**：从工具走向属于你个人的 agent。
4. **自进化**：让 personal agent 能够自我进化。

> 安全提醒：从客户端驱动一个带 shell 权限的 agent 本质等于远程代码执行。认证、权限审批、
> 工作目录、默认拒绝是核心设计目标，不是附加项。

## 目录结构

```
paboot/
├─ CLAUDE.md              本文件
├─ .editorconfig          代码风格（缩进 / 行宽 / 换行符），各 IDE / 编辑器共用
├─ docs/
│  ├─ ui/                 UI 设计，三层：共享 / 移动端 / 桌面端
│  │  ├─ README.md        三层索引
│  │  ├─ shared/          跨平台设计源：design-principles（§0-§5）/ interactions（§7）/ appendix
│  │  ├─ mobile/          移动端（Android/iOS 共用）：pages/ 逐页规格 · platforms/{android,ios}.md · preview.html
│  │  └─ desktop/         桌面端：design.md · pages/ 逐页差异 · preview.html
│  └─ local/              本机私有方案笔记（gitignore，不入库：开发计划 / Dev Space / Builtin / Memory …）
├─ daemon/                daemon 子项目（Node >=24.9 + Express + SQLite）
│  ├─ src/                daemon 源码
│  ├─ tests/              Vitest 单测
│  └─ docs/               daemon 技术方案（daemon.md 为索引 + protocol / permissions / runtimes /
│                         scheduled-tasks / configuration / context / knowledge / llm / memory / docker / windows）
├─ android/               Android 客户端（Kotlin + Compose）
│  ├─ app/                业务上层（MVVM + Compose UI + 仓库编排）
│  ├─ lib-network/        网络底座（依赖 + wire DTO + Retrofit API + SSE + LLM 抽象）
│  └─ lib-updater/        应用内自更新 SDK（作者自用，alpha/prod 双通道）
├─ desktop/               桌面客户端（Electron + React，Linux / macOS / Windows）
└─ ios/                   iOS 客户端（原生 UIKit + SwiftPM 模块）
```

- **daemon/**：负责 `/api/*`、spawn agent、会话/run 持久化、权限审批、SSE 流、知识 / Memory、
  provider 管理。
- **android/** / **ios/**：已实现（连接 / 会话列表 / 聊天 / 审批 / 会话权限 / 系统通知 / 文件 /
  工作区 / 定时任务 / 知识 / Memory）。
- **传输契约**：跨端共享的 DTO、SSE 事件 union、错误形状放 `daemon/src/types/api.ts`。

## 技术栈

- **daemon**：Node `>=24.9`（ESM）、TypeScript（strict）、运行时依赖 `express` + `cron-parser`、
  `cross-spawn`、存储用 `node:sqlite`（零原生依赖）、测试 Vitest、dev 用 `tsx`。
  外部 runtime 走进程 spawn；Builtin 内核与 provider HTTP 调用在 daemon 进程内
  （它挂载的 MCP server 仍按需 spawn 子进程）。
- **Android**：Kotlin、Jetpack Compose + Material 3、Retrofit + kotlinx-serialization、
  OkHttp（SSE 手写解析）、MMKV、Navigation Compose、MVVM；多模块（`:app` 业务 + `:lib-network` 通用网络层）。
- **Desktop**：Electron（主进程 + preload）+ React/Vite 渲染层，**daemon 的另一个瘦客户端**：
  复用同一份协议与设计 token，不改变 daemon 的独立性。打包用 electron-builder：
  Linux `AppImage` + `deb`、macOS `dmg` + `zip`、Windows `nsis`。
- **iOS**：原生 UIKit（命令式）+ 三个 SwiftPM 模块（`PabootProtocol` / `PabootClient` /
  `PabootMarkdownUI`），与 Android 共用 `docs/ui/` 一套规范；平台映射见
  `docs/ui/shared/design-principles.md` §4.5，落地适配见 `docs/ui/mobile/platforms/ios.md`。


## 开发规范

### 通用

- **命名（文件）**：一个文件一个**顶层公开类型**，文件名与该类型同名（`SseSource` →
  `SseSource.kt`、`NormalizedEvent` → `NormalizedEvent.kt`）；sealed 的**嵌套子类**、
  该类型的**配套顶层函数**随父类型放同一文件，不单独拆。文件夹按领域分组（`sse/`、`llm/`）。
- **例外：wire DTO 按域合并**。同一份协议的传输模型不搞「一类型一文件」，而是按业务域收成几个
  `<域>Dtos.kt`（`AgentDto` + `AgentsResponse` 同放 `AgentDtos.kt`；iOS 对应
  `<域>Dtos.swift`），统一进 `<协议>/dto/` 包，**不再**在 `dto/` 下按域建子目录。
  理由：一个实体和它的列表包装永远同生共死，拆开只是噪音。
- **传输契约**：改 `types/api.ts` 前先想清对 Android/iOS/desktop 三端的影响。
- **桌面端必须考虑 Linux / macOS / Windows 三平台**：路径与分隔符（盘符、`\` vs `/`、大小写）、
  shell（Windows 默认 `cmd.exe`，仅显式设置 `CLAUDE_CODE_GIT_BASH_PATH` 才用 Git Bash）、
  env / HOME、进程启动与 `.cmd`/`.exe` 解析、文件权限、通知 / 托盘、窗口行为、换行符、
  快捷键、原生依赖都不能假设 POSIX。新增功能要检查三平台代码路径；涉及平台差异时同步
  `daemon/docs/windows.md` 与 `desktop/README.md`。打包三目标见 `dist:linux|mac|windows`。
- **移动端修改必须同时考虑 Android + iOS**：同一个功能默认双端一起落地（DTO / Repository /
  ViewModel / UI），不允许只改一端留下「休眠能力」；`types/api.ts` 新增字段两端 DTO 同步。
  视觉与交互以 `docs/ui/mobile/` 为源，平台差异见 `platforms/android.md` / `platforms/ios.md`。
  Android 不主动执行 `.gradlew`；iOS 在 Linux 无法编译，由用户在 Xcode / 真机自测。
- **文档同步**：行为/协议/安全模型变化时，同步对应文档（daemon → `daemon/docs/`，按主题分：
  protocol / permissions / runtimes / scheduled-tasks / configuration / context / knowledge /
  llm / memory / windows，`daemon.md` 为索引；UI → `docs/ui/`）。
- **代码风格**：以仓库根 `.editorconfig` 为准（Kotlin/Gradle/XML 4 空格，TS/JSON/YAML 2 空格，
  LF，行宽 120）。

### daemon

- **接入新 agent**：先看驱动方式——argv + stdout 流式的实现 `src/runtimes/types.ts` 的
  `RuntimeAdapter`，在 `src/runtimes/registry.ts` 注册一行，路由/引擎/持久化/传输都不用动；
  RPC 对等的（Codex 的 `codex app-server`、DeepSeek Harness 的 `dsh acp`）用
  `RuntimeDetector` 登记并自写会话驱动（`runtimes/codex/session.ts` /
  `runtimes/deepseek/session.ts`），再在 `runtimes/drivers.ts` 注册 `RuntimeDriver`；
  **进程内自研 runtime** 走 `runtimes/builtin/`（detect + AgentKernel + driver + tools / MCP /
  skill / transcript）。chat 路由只按 id 取 driver，不写分支。RPC 运行时共用
  `runtimes/stdio-rpc.ts`。
- **目录分层**：`src/` 按层/领域组织——`app/`（组合根与进程生命周期）、`http/` `platform/`
  `db/`、业务领域 `workspaces/` `runs/` `permissions/` `scheduling/` `mcp/` `knowledge/`
  `memory/` `attachments/`、共享底座 `context/` `llm/` `providers/`、插件层 `runtimes/`、
  协议 `types/`。根目录只放进程入口与路径敏感文件（`index.ts`、`permission-hook.ts`、
  `version.ts`）。新增领域直接加 `src/<domain>/`，不要往根目录平铺。
  `mcp/servers/<server-name>/` 按 MCP server 的真实名称建目录，工具放它的 `tools/` 下。
- **分层规则**：只有 `app/` 可以全量依赖；其他层对 `app/` 只允许 `import type`；`db/`、
  `runtimes/`、业务领域都不依赖 `routes/`。边界由 `tests/architecture.test.ts` 扫描 import
  守护，改目录后先跑它。
- **路由归属**：daemon 域端点放 `src/routes/<domain>.ts`，只有进程级元数据（health）留在
  `app/server.ts`。
- **安全边界**：认证、`--permission-mode`、PreToolUse hook、只读白名单、工作目录、
  默认拒绝都属安全边界，改动必须保持 deny-by-default。
- **Claude Code API 不稳**：CLI flag 随版本变，能力必须先 `--help` 探测再传参
  （`runtimes/claude/detect.ts`），不要假设某 flag 恒存在。
- **数据路径**：daemon 数据根**固定** `~/.paboot`，
  SQLite / token / `daemon_runtime.json` / 单实例锁 `paboot.lock` / `attachments/` / `memory/` /
  `providers.json` 都在其下（同一 data dir 同时只允许一个 daemon，启动时靠该锁判定）。固定是为了让
  `serverId`（首次启动生成、落在该库里）成为这台机器上这个用户的**稳定身份**——客户端靠它认出
  「不同地址连上的是同一台 daemon」。
- **配置**：env 变量可写入 `.env`（参考 `.env.example`，运行目录自动加载，flag 优先）。
- **测试/产物**：测试放 `tests/`；`dist/`、`node_modules/` 不入库，不要手改 `dist/`。
- **提交前**：至少 `pnpm typecheck` + `pnpm test`（涉及入口/打包再加 `pnpm build`）。

### Android

- **模块**：`:app`（业务）+ `:lib-network`（网络底座，包名 `com.noresign.paboot.network`）。
  **网络相关的东西全在 `:lib-network`**：okhttp / retrofit / coroutines / kotlinx-serialization
  依赖、wire DTO、Retrofit 接口与客户端工厂、SSE 传输、网络错误包装。`app` 不自己声明这些依赖，
  直接用 `:lib-network` 的类型（依赖以 `api` 暴露）。`:lib-network` 不引用任何 `android.*`，
  也不放业务编排、UI、MMKV。
- **`:lib-network` 内部分层（依赖单向向下，不引 okhttp-sse）**：`sse/`（通用 SSE 传输）→
  `http/`（REST 结果包装）→ `llm/`（大模型供应商抽象）/ `daemon/`（daemon 协议层 + `dto/`）。
  逐文件说明、依赖方向与用法见 [该模块的 README](android/lib-network/README.md)。
- **分层（`:app`）**：`data/repository`（业务编排，直接调 `:lib-network`）、`data/local`（MMKV 设置）、
  `model`（页面模型）、`viewmodel`、`ui`、`navigation`，严格 MVVM，UI 层不碰网络。
- **传输契约**：改 `types/api.ts` 时同步改 `:lib-network` 的 `daemon/dto/`（字段名/类型/多态判别
  一一对齐）；跨 module 的 DTO 属性不能智能转换，先用局部变量接再判空。
- **持久化**：MMKV（`SettingsStore`，留在 `:app`）。
- **UI**：以 `docs/ui/` 为唯一设计源；「runtime 身份」（图标/色/名）做成可配置映射，
  新增 agent 只加一行不改布局。底部 Tab 顺序固定为 **会话 / 文件 / 任务 / 设置**。
- **与 iOS 同步**：移动端功能默认 Android + iOS 同时改；新增 DTO 字段、事件判别、权限 / 记忆 /
  知识行为两端口径一致，不能只验证 Android 就收工。
- **注意**：用户没有主动提出帮忙运行android项目，再更改后请不要主动使用.gradlew命令运行，用户自己运行测试

### Desktop

- **三进程**：`src/main/`（连接与发现、daemon 代理、流式、窗口、托盘 / 通知）+ `src/preload/`
  （零依赖 `contextBridge`）+ `src/renderer/`（zustand + React）；两侧共用的契约与纯逻辑放
  `src/shared/`。
- **进程边界即安全边界**：`contextIsolation` / `nodeIntegration: false` / `sandbox` /
  `webSecurity` 固定不变，渲染层**不直接碰 Node/Electron**，一律走 preload 暴露的 API；网络请求
  由主进程发出。`tests/preload-sandbox.test.ts`、`tests/protocol-purity.test.ts` 是这条边界的
  守护测试，改 preload 或协议层之前先看它们。
- **三平台兼容（Linux / macOS / Windows）**：所有桌面改动都要同时考虑三平台，不能假设 POSIX：
  路径 / 盘符 / 分隔符与大小写、shell（Windows 默认 `cmd.exe`）、env / HOME、进程与
  `.cmd`/`.exe` 解析、文件权限、通知 / 托盘、窗口行为、换行符、快捷键、原生依赖。
  平台差异集中记在 `daemon/docs/windows.md` 与 [desktop/README.md](desktop/README.md)；
  打包目标 `dist:linux`（AppImage + deb）/ `dist:mac`（dmg + zip）/ `dist:windows`（nsis）。
- 其余（协议类型走 `@noresign/paboot/protocol`；构建前要先编译**并打包** daemon——`dist` 是裸 tsc
  产物，带进 app 会以 `Cannot find package 'express'` 崩，所以 `prebuild` 会用 esbuild 打成自包含
  单文件，再走 `extraResources`；三份 tsconfig、皮肤系统）见 [desktop/README.md](desktop/README.md)。
- **启动流程**：恢复已保存的连接 → **上次选中的主机优先**（远程不可达时停在连接页，不自动顶替为
  本机）→ 本机没有 daemon 时探测/自动启动（`autoStartDaemon` 偏好默认开）→ 都失败才显示连接页。
  启动/重启本机 daemon 不询问工作目录，固定用内置 fallback；远程主机从连接切换器的「添加电脑」进入。
- **不要求「app 版本 == daemon 版本」**：随包只保证「装完就能启动一个本机 daemon」；daemon 有独立
  发布链（OSS 的 npm 包），而且**附着外部 daemon 时版本相等根本不成立**——那恰恰是主要用法。
  版本差异靠协议向后兼容兜（health/`serverId` 这些字段都是可选的）。

### iOS

- **结构**：`ios/App/` 是 UIKit 应用（`UI/Screens`、`ViewModels`、`Data/Repositories`、
  `Navigation`、`Notifications`）；`ios/PabootCore/` 是三个 SwiftPM 模块——
  `PabootProtocol`（DTO / SSE / 重连策略）、`PabootClient`（URLSession 传输）、
  `PabootMarkdownUI`。DTO 放 `PabootCore/Sources/PabootProtocol/Dtos/`。
- **与 Android 同步**：移动端功能双端一起改；新增协议字段两端 DTO 同步，不走「先 Android、
  iOS 以后补」。
- **构建限制**：iOS 在 Linux 环境无法编译 / 运行；agent 负责写代码与静态检查，最终由用户
  在 Xcode / 真机验证，不要声称已运行验证。
- **加入工程**：新增源文件要同步 `paboot.xcodeproj/project.pbxproj`，否则不会参与编译。

## 关键设计决策（速览）

- **权限审批**：每个 Session 独立模式 `ask` / `acceptEdits` / `bypass`。审批统一落到
  `PermissionManager`：Claude 走 PreToolUse hook 子进程轮询，Codex / DeepSeek 走各自 RPC 的
  approval / `session/request_permission` 通道；`ask` 下 Bash/Write/Edit，以及
  `ask`/`acceptEdits` 下的 WebSearch/WebFetch 与 MCP 工具需要审批，Bash 内只读白名单自动放行；
  「允许全部」为 Session + toolName 级持久化 grant，默认拒绝、超时自动拒绝。
  **读（`Read`/`Grep`）不门控**——读工作区外不审批、不加目录；工作区边界只约束写入。
- **工作空间**：显式 `--workspace` 是**权威值**——每次启动都确保该目录存在并设为默认 Workspace
  （桌面端从连接页启动 daemon 走的就是这条）；`PABOOT_WORKSPACE` / 无参默认
  `<dataDir>/defaultworkspace`（与 SQLite/token 同根），只在工作区表为空时注册一次（首次安装），
  删掉的工作区不会在重启后回来。客户端可新增/切换 Workspace。
  删工作区默认只删注册信息，`?cascade=1` 才连它的 Session 一起删；**默认工作区可删**——先把默认切给
  另一个启用的真实工作区，没有就切给内置 fallback，内置 fallback 本身不可删/不可停用，
  顺带保证最后一个工作区删不掉。Session 绑定 `workspace_id + cwd`，cwd 必须位于所属 Workspace 内。
  **内置 fallback 工作区**：无显式 `--workspace` 时 daemon 默认用它
  （`<dataDir>/defaultworkspace`，桌面端首次启动也预填同一路径），daemon 按该路径标记为内置——没有真实工作区时它是默认，API 仍返回它（客户端需要 id 拉会话/文件），
  但客户端列表/切换器**永不渲染**它；添加真实工作区后自动让位且接口也不再返回（行与会话仍在库里），
  删掉最后一个真实工作区后重新作为默认出现。
  客户端**不展示「设为默认」**：打开时按本机上次选择的工作区（Android/iOS/桌面都本地持久化，
  桌面按 `serverId` 存 localStorage），daemon 的 `is_default` 只作为「客户端没指定工作区」时的兜底。
  **`workspaces.family = dev | life`**：life 是内置工作区（cwd `<dataDir>/life/`，不可删 / 停用 /
  设默认），客户端渲染为「生活」入口；family 互斥由 `ends` trigger 保证，end 只做上下文 / 能力 /
  记忆标签，不做记忆隔离。
- **多 agent 并发 + 断线续传**：run 与连接解耦；`/api/chat` 客户端断开后 run 继续跑，
  事件按 `(run_id, seq)` 持久化，`GET /api/runs/:id/stream?after=` 回放+续直播，显式停止用
  `POST /api/runs/:id/cancel`。
- **定时任务**：daemon 内调度（`scheduler.ts`，30s tick）；任务最终拥有一个会话（首次触发创建、
  之后 resume）；时间统一存 5 段 cron，UI 只暴露结构化预设；错过直接跳过、忙则跳过、会话删除则**连带删除任务**。
  定时 run 请求 `bypass`，但仍受安全 profile 生效值约束（server-strict 下会降级为 `acceptEdits`）；
  命令任务用隐藏 `kind='command'` 会话复用 run 管线。
  **新建任务走 AI 配置会话**：客户端先确认再进入；每个 workspace 复用一份（settings 存 session id），
  首条用户消息是「定时任务配置模式」。AI 只问用户想完成什么任务，执行 prompt 由 AI 起草并展示，
  用户确认后才调用 `schedule_task`；工具支持
  `target=current|existing|new` 与 `list_sessions`，统一走 MCP 桥（Claude `--mcp-config` /
  Codex `-c mcp_servers.*` / DeepSeek `session/new.mcpServers`），有递归拦截与每会话上限。
  已有任务仍可手动编辑（名称/内容/计划/启停）。详见 `daemon/docs/scheduled-tasks.md`。
- **会话**：`--session-id`/`--resume` 管理 Claude 会话，id 持久化在 `sessions.native_session_id`
  ——这一列存的是**对应运行时自己的**会话 id，Codex 存的是它的 thread id、DeepSeek 存的是
  ACP session id。不支持导入 / 续接本机已有的 Claude TUI 会话。
- **token**：持久化在 `<data-dir>/token`，启动复用（删文件即轮换）；另分 operator / agent /
  server 三角色，详见 `daemon/docs/configuration.md`。

## 部署（作者本机私有工作流）

> ⚠️ 本节描述的是**作者本机**的发布流水线，脚本位于 `.claude/skills/deploy/`，而 `.claude/`
> 被 gitignore，**不在仓库内**——下面出现的脚本路径对开源读者都不可用，请直接忽略本节。
> **用法、flag、脚本内部行为见 `.claude/skills/deploy/SKILL.md`**，本节只留边界与规则概览。

**发布边界（重要）**

- ✅ **本机发布流水线由 agent 执行**：用户说「发布测试 / 发布生产」时，按规则跑脚本。
- ⛔ **对外的公开分发（npm 公共仓）只能由用户本人手动完成**：agent 不得代为发布，也不要
  主动建议、提示或输出这一步的命令。

统一入口 `.claude/skills/deploy/scripts/deploy.sh`，按 git 变更自动决定做什么，没有改动的部分跳过：

- `daemon/**` 有改动 → `pnpm build` + 重启本地 daemon；`prod` 再打 `.tgz` 上传 OSS `daemon/`
- `android/**` 有改动 → `release-android.sh alpha|prod`（构建、签名、上传 OSS）
- `desktop/**` 有改动 → `release-desktop.sh alpha|prod`

版本号规则，三个子项目统一语义化（`1.0.0 → 1.0.1` 小修 / `→ 1.1.0` 加功能 / `→ 2.0.0` 大改）：

- **Android**：源是 `android/version.txt`。发布脚本生成 versionName（alpha 追加 `-alpha.<时间戳>`），
  versionCode = `epoch 秒`；debug variant 固定 `1` / `0.0.0-*`。**正式包的 versionCode 与
  versionName 都必须高于本地 debug 构建**，否则安装器判降级拒装（踩坑记录见
  `android/docs/local/updater.md` §7.1，私有）
- **daemon**：源是 `daemon/package.json` 的 `version`；`--version`、`/api/health` 与发布产物都由它派生
- **Desktop**：源是 `desktop/package.json` 的 `version`，alpha 追加 `-alpha.<UTC 时间戳>`；
  桌面端**不做应用内自更新**，所以 OSS 上只放安装包本体

版本文件必须入库：`android/version.txt`、`daemon/src/version.ts`（源是 package.json）。
桌面端的版本源 `desktop/package.json` 本身就是入库文件。

只有用户明确说“发布/部署/发版”时才执行。**从客户端对话时**（用户说「发布测试 / 发布生产」）
必须走 `.claude/skills/deploy/scripts/chat-deploy.sh`，**不要直接跑 `deploy.sh`**——它会重启
daemon，把当前 agent 进程一起杀掉。


## git提交规范

遵循 [Conventional Commits]，格式 `<type>(<scope>): <subject>`，type 全小写英文。

- **type**：`feat` 新功能、`fix` 修复 bug、`refactor` 重构（不改行为）、`docs` 文档、`chore`
  杂务（依赖/构建/脚本）、`test` 测试、`perf` 性能。不用 `modify`——改动不是「新功能」就归
  `fix`/`refactor`。
- **scope**：可选，标注受影响子项目：`daemon` / `android` / `desktop` / `ios` / `docs`；跨端或
  全局改动省略 scope。
- **subject**：**英文**（不要用中文），祈使句、首字母小写，简洁说明「做了什么」；如果改动涉及
  多个角度，只描述主要 1～2 个改动，用 ` & ` 连接；不加句号；冒号后空一格。
  （`feat(android): add pull-to-refresh & fold old sessions`；
  不是 `feat:xxx & xxx`，也不是 `feat: 加下拉刷新`）。
