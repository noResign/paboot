# ② 会话列表（Conversation List）

> 文档索引见 [../README.md](../../README.md)；Design Tokens 与组件库见 [../design-principles.md](../../shared/design-principles.md)。章节编号沿用拆分前的 `ui_design.md`，未重新编号。

### 6.2 ② 会话列表（Conversation List）🟢

**目的**：查看当前选中 Workspace 下的历史会话（根目录平铺 + 子目录分组）、当前哪个在运行、进入会话。

**关键元素**：
1. 顶栏：标题「会话」+ **Workspace 切换器**（当前 Workspace 名/path；点击打开 Workspace 列表和目录选择）+ 全局连接状态胶囊（connected/offline）。
2. 会话列表（LazyColumn），**只展示当前 Workspace 的 Session**：
   - **当前 Workspace 根目录**（`cwd == workspace.path`）的会话**平铺在顶部**，不显示分组头。
   - **Workspace 内子目录**（`cwd != workspace.path`，通常来自「续接本机会话」）的会话按 `cwd`
     分组，排在根目录会话下方：
     - **子目录分组头**（段头）：`folder` 图标 + 目录**相对路径**（相对当前 Workspace，等宽、单行
       省略）+ 该目录会话数徽章 + 折叠箭头；**默认折叠、可点击展开**；滚动时**吸顶**（sticky）；
       组间按「组内最近活跃时间」倒序（最近活跃的子目录排最前）；**只显示有会话的子目录，空目录
       不出现**。
   - **会话卡片**（平铺列表与组内均按 `lastActiveAt` 倒序）：
     - 标题（`title`，新建会话时自动取首句；无标题显示默认名"未命名会话"）
     - Agent 徽章
     - 相对时间（`lastActiveAt`）
     - 🟢 **运行中指示**（`running=true` 时：左侧脉冲圆点 + 卡片描边 primary，点击可直接进该会话）
   - 子目录已上移到分组头，**卡片内不再重复显示 `cwd`**。
3. 空态：插画 + "还没有会话" + 「新建会话」按钮。
4. FAB「+」→ 新建会话。

**交互**：
- 点击卡片 → 进入聊天详情。
- 向左滑动卡片 → 露出 `重命名` / `删除` 按钮；松手停在展开位置，点击按钮才执行对应操作。右滑或点击卡片可收起；同时只展开一条，列表滚动时收起。
- 重命名 → 输入名称并保存 → `PATCH /api/sessions/:id`；名称去除首尾空白且不能为空，保存成功后更新列表，失败保留输入并显示原因。
- 删除 → 弹出删除确认（`删除` / `取消`，删除为 error 色）→ `DELETE /api/sessions/:id`。
- 下拉刷新。

**状态**：
- 加载中：骨架屏。
- 空态 / 网络错误：文案 + 「重试」；连接层面的错（token 失效、地址变了）重试无用，所以错误态
  同时给一个「重新连接」入口（回 ① 连接页）。
- 本地选中的工作区在 daemon 上已不存在（`workspace_not_found`）时不报错：清掉本地选择、
  按「不过滤」重拉一次，否则会停在一个永远重试不好的错误页上。

> ⚠️ 数据现状说明（供开发，不影响设计）：当前会话列表接口返回 `{id, runtime, cwd, title, createdAt, lastActiveAt}`，
> **没有** running 字段、没有最后一条消息预览、title 恒为 null。设计师仍按理想卡片设计，
> 由开发在附录 B 里补齐后端字段。

---
