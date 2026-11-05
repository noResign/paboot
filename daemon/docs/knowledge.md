# Curated knowledge (K0)

> 代码：`src/knowledge/` · 路由：`src/routes/knowledge.ts` · 注入：`src/runs/knowledge-context.ts`
> 设计背景见 `docs/local/paboot_memory/knowledge.md`（本机私有笔记，不入库）。

K0 解决「换一个会话也能读到项目约定 / 需求 / 踩坑」：markdown 文件是正文真源，
daemon 只维护 `.meta.json` 治理状态，**不建 memory.db / FTS**（K2 再接索引）。

**收录策略（2026-11-05）**：识别到的文件**自动收录并注入**，不阻塞在人工确认上。
人工核验只作为一个标记：`authority=curated` = 已核验，`authority=derived` = 未核验。
未核验条目仍会注入，但指针里会带「（未核验）」。

## 1. 磁盘布局

```
<dataDir>/workspaces/<workspaceId>/
  WORKSPACE.md
  conventions/*.md
  knowledge/*.md
  knowledge/.meta.json          # daemon 独占写入
  ends/<endId>/{CONVENTIONS.md,knowledge/*.md}
  requirements/**/*.md
```

- 目录用稳定的 `workspaceId`，不用工作区名；life 也复用该布局（K0 UI 暂不展示）。
- 扫描只认上面这些路径；忽略隐藏文件，不跟随 symlink（旧 `_trash/` 也会被忽略）。
- 路径 containment 拒绝 `..`、绝对路径、反斜杠和 symlink 逃逸（`knowledge/paths.ts`）。

## 2. 治理状态（`.meta.json`）

每篇文档记录 `id / kind / title / summary / endId / origin / authority / reviewStatus /
tags / contentHash / createdAt / updatedAt / lastEditedBy`。

- 新文件 → `reviewStatus=confirmed`、`authority=derived`（自动收录，未核验）。
- 外部内容变化 → 保持 confirmed，但 `authority=derived`（旧的人工核验不再覆盖新正文）。
- UI 新建 / 编辑 → `authority=curated`（人工动作即核验）。
- `POST /verify` 可单独切换核验标记，不改文件。
- 文件消失 → `missing`，从注入中排除；回来后自动重新收录，但仍为未核验。
- 同一文件重复扫描幂等（按 hash 对比，不需要常驻 watcher）。
- `.meta.json` 损坏 → 备份为 `.meta.json.corrupt-<ts>` 并按空 manifest 处理（全部重新收录为未核验）。
- 写入用同目录临时文件 + rename 原子替换。
- 旧版本留下的 `pending / rejected` 条目在下一次 reconcile 时迁移为 `confirmed`。

## 3. 扫描 / 标题 / 摘要

| 路径 | 默认 kind |
|---|---|
| `WORKSPACE.md` | `workspace_context` |
| `conventions/*.md` | `convention` |
| `knowledge/*.md` | `note` |
| `ends/<id>/CONVENTIONS.md` | `convention` + endId |
| `ends/<id>/knowledge/*.md` | `tech_doc` + endId |
| `requirements/**/*.md` | `requirement` |

标题取第一个 markdown 标题，否则用文件名；摘要取第一段非标题 / 非代码块文本（截断 160 字）。

## 4. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces/:id/knowledge` | `endId` / `kind` / `status` / `verified` / `q` 过滤 |
| GET | `/api/workspaces/:id/knowledge/:kid` | 含 `body` 与 `absolutePath` |
| POST | `/api/workspaces/:id/knowledge` | 人工新建，直接 `confirmed / curated` |
| PATCH | `/api/workspaces/:id/knowledge/:kid` | 编辑后保持 `confirmed / curated` |
| POST | `/api/workspaces/:id/knowledge/:kid/verify` | `{verified: boolean}` 切换人工核验标记 |
| DELETE | `/api/workspaces/:id/knowledge/:kid` | **永久删除**文件（不可恢复），清理空的 end 目录 |
| GET | `/api/workspaces/:id/knowledge/export` | ZIP（正文 + `.meta.json`） |

- 写 / verify / delete 由 `requireRolePolicy` 自动限制为 **operator token**；agent token 只读。
  写操作写 `audit_log`（`knowledge_create/update/verify/delete`），只记 workspace/id/path/verified，
  不记正文或标题。
- 删除工作区时整个知识根（`<dataDir>/workspaces/<id>/`）**永久删除**；代码目录不动。
  删除不可恢复，需要保留就先导出 ZIP。
- 导出 ZIP 用内置 store-only writer（`knowledge/zip.ts`），不引入新依赖。

## 5. 注入（首条消息前导块）

- 只在 **session 还没有 `native_session_id`**（尚未建立 provider 会话）、runtime 不是 `command` /
  `builtin`、且 workspace 是 `dev` 时注入。`purpose=task_config` 的 AI 配置会话也注入（用户决定）。
  builtin 以后走 ContextAssembler，不走这个前导块。
- 取所有 `confirmed` 文档：工作区级 + 当前 `session.end_id` 的端级 + `requirements`。
- 注入的是**指针**：`[kind] 标题（未核验） — 绝对路径`；`authority=curated` 的条目不带标记。
  正文由 agent 按路径 Read，因此正文更新天然实时。
- 使用 `ContextAssembler` 排序 / 去重 / 预算（默认 6000 字符，整段丢弃），包在
  `<paboot-memory-context>…</paboot-memory-context>` 中。
- **用户消息与 `runs.prompt` 保存原文**；只有发给 runtime 的 prompt 带前导块。
- 会话建立后不会刷新指针集合：标题 / 新增 / 删除需要新会话才反映；S1 起按
  `indexVersion` 每轮重建动态尾部（见 `read-pipeline.md` §6.5）。
- 预算超限写日志；为 K0 不新增 SSE 事件，避免三端协议扩展。
- 知识库损坏只 warn，不阻塞 run。

## 6. 安全边界

自动收录意味着 **agent 自己写进知识目录的文件也会自动注入**（指针带「未核验」）。
pending 不再是访问控制；agent 仍可读知识根下的任何文件（读不门控）。
真正的隔离留给 dataDir 读门控 / run-scoped token / OS 沙箱，不在 K0。

## 7. 测试

`tests/knowledge-paths.test.ts`、`tests/knowledge-store.test.ts`、`tests/knowledge-routes.test.ts`、
`tests/knowledge-injection.test.ts`：containment / slug / 原子写 / 自动收录 / 外部修改重置核验 /
missing / 幂等扫描 / 旧 pending 迁移 / 创建编辑永久删除 / ZIP / operator 写权限 /
首轮注入与原文落库 / 未核验标记。
