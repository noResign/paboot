# ⑪ 定时任务（桌面端）

> 索引见 [../design.md](../design.md)；共享语义见
> [../../mobile/pages/tasks.md](../../mobile/pages/tasks.md) 与
> [daemon/docs/scheduled-tasks.md](../../../../daemon/docs/scheduled-tasks.md)。

桌面端只写与移动端的差异：

- **入口**：左栏底部「⏰ 任务」按钮（文件 / 任务 / 设置），以及命令面板「定时任务」。
  不新增常驻栏。
- **布局**：主区左右分栏——左列任务列表（约 320px），右侧详情；同屏可见，无 push。
- **列表行**：名称、状态、`计划 label · 下次`、目标、AI 创建标记。点击选中详情。
- **详情**：元信息、prompt/命令、立即运行 / 启停 / 编辑 / 删除、最近 20 次 run；
  命令输出直接展示在 run 下方。
- **新建**：「新建任务」先弹确认框，确认后调用 `POST /api/scheduled-tasks/config-session`，然后在
  主区切到该配置会话。AI 只问用户想完成什么任务，执行 prompt 由 AI 起草并展示确认，不让用户写
  prompt。每 workspace 复用一份配置会话。
- **编辑**：居中模态（复用 `NewSessionDialog` 的 `.modal` 样式），可改名称、prompt/命令、
  结构化计划；类型和目标不可改。原始 cron 任务只允许改名称和内容。
- **刷新**：页面可见时每 20 秒静默轮询；任何变更后立即刷新。不新增 stream/IPC：
  REST 走通用 `request`，`preload-sandbox` / `protocol-purity` 边界不变。
- **快捷键**：命令面板动作，不新增全局快捷键。
