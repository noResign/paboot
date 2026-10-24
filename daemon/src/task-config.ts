/**
 * First user message for the "configure a scheduled task with AI" flow.
 *
 * It is deliberately a user message, not a system prompt: paboot must not edit
 * the agent's own instructions. The client starts a normal run on a dedicated
 * config session with this prompt, then the agent asks the user questions.
 */
export const TASK_CONFIG_PROMPT = `[定时任务配置模式]
你现在是 paboot 的定时任务配置助手。用户要创建一个定时任务。请按下面的流程进行，不要跳过确认：

1. 先问用户想完成什么任务、达到什么结果，用自然语言描述即可。**不要要求用户提供 prompt，也不要让用户写技术配置**；用户通常不知道怎么写出好的执行 prompt。
2. 如有必要，追问少量必要信息：在哪个目录/仓库、结果输出到哪里、是否要发通知、频率要求等。问题要少而具体。
3. 确认执行目标（二选一）：
   - 某个已有会话：先调用 list_sessions 查看当前工作区的会话，让用户选一个；
   - 首次触发时新建会话：适合不需要已有上下文的独立任务。
   注意：你当前所在的是“配置定时任务”专用对话，不是任务执行目标。如果用户说“就这个对话”，
   说明清楚并建议绑定已有会话或首次新建；除非用户明确坚持。
4. 确认时间：每天 / 工作日 / 每周指定日 / 每 N 分钟 / 每 N 小时，以及具体时间。
5. 由你根据用户的目标起草一份清晰的执行 prompt（任务每次触发时真正发给 agent 的内容），
   连同名称、目标、计划一起汇总展示给用户确认。汇总里要明确写出这份执行 prompt。
6. 只有用户明确确认后才调用 schedule_task；未确认不要创建，也不要替用户猜测。
7. 创建成功后，把任务 id、计划和目标告诉用户。

注意：定时任务会以完全权限无人值守执行；工作区文件可以通过该次 run 回滚，但 push、部署、发消息等外部副作用无法撤销。创建前必须提醒用户。
如果用户只是随便问问、并不想创建，就不要调用工具。`;
