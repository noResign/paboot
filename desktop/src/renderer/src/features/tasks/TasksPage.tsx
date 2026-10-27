import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { useScheduledTasks } from '../../store/scheduledTasks';
import { Icon } from '../../ui/Icon';
import { runtimeIdentity } from '../../../../shared/runtime-identity';
import type {
  RunDto,
  ScheduleInput,
  SchedulePresetKind,
  ScheduledTaskDto,
  SessionDto,
  UpdateScheduledTaskRequest,
} from '../../../../shared/contract';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const PRESET_LABELS: Record<SchedulePresetKind, string> = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周指定日',
  every_minutes: '每 N 分钟',
  every_hours: '每 N 小时',
};

function relativeTime(at: number | null): string {
  if (!at) return '—';
  const diff = at - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? '即将' : '刚刚';
  const minutes = Math.round(abs / 60_000);
  const text = minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return diff >= 0 ? `${text}后` : `${text}前`;
}

function statusLabel(task: ScheduledTaskDto): string {
  if (!task.enabled) return '已停用';
  switch (task.lastStatus) {
    case 'running':
      return '运行中';
    case 'failed':
      return '失败';
    case 'skipped_busy':
      return '已跳过（会话忙）';
    case 'skipped_missed':
      return '已跳过（错过）';
    case 'succeeded':
      return '成功';
    case 'cancelled':
      return '已取消';
    case 'interrupted':
      return '已中断';
    default:
      return '未运行';
  }
}

const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  succeeded: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'error' },
  running: { label: '运行中', tone: 'live' },
  interrupted: { label: '已中断', tone: 'warn' },
  cancelled: { label: '已取消', tone: 'muted' },
  canceled: { label: '已取消', tone: 'muted' },
};

/** Run history used to print the daemon's raw status (`succeeded`) next to Chinese copy. */
function runState(status: string): { label: string; tone: string } {
  return RUN_STATUS[status] ?? { label: status, tone: 'muted' };
}

/** `10-27 11:09` — the seconds in `toLocaleString()` are noise in a history list. */
function runTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusTone(task: ScheduledTaskDto): string {
  if (!task.enabled) return 'off';
  return task.lastStatus || 'never';
}

interface Props {
  connectionId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  /** When set, only this session's tasks are listed (opened from a chat). */
  taskFilter: { id: string; title: string | null } | null;
  onClearTaskFilter: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function TasksPage({
  connectionId,
  workspaceId,
  workspaceName,
  taskFilter,
  onClearTaskFilter,
  onOpenSession,
}: Props) {
  const scope = useScheduledTasks((state) => (connectionId ? state.byConnection[connectionId] : undefined));
  const load = useScheduledTasks((state) => state.load);
  const loadDetail = useScheduledTasks((state) => state.loadDetail);
  const update = useScheduledTasks((state) => state.update);
  const remove = useScheduledTasks((state) => state.remove);
  const runNow = useScheduledTasks((state) => state.runNow);
  const startConfigSession = useScheduledTasks((state) => state.startConfigSession);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<ScheduledTaskDto | null>(null);
  const [confirmNewTask, setConfirmNewTask] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);
  const tasks = scope?.tasks ?? [];
  const detail = scope?.detail && scope.detail.task.id === selectedId ? scope.detail : null;
  const filterId = taskFilter?.id;

  useEffect(() => {
    if (!connectionId) return;
    void load(connectionId, workspaceId ?? undefined, { sessionId: filterId });
  }, [connectionId, workspaceId, filterId, load]);

  useEffect(() => {
    if (!connectionId) return;
    const timer = setInterval(() => {
      void load(connectionId, workspaceId ?? undefined, { silent: true, sessionId: filterId });
    }, 20_000);
    return () => clearInterval(timer);
  }, [connectionId, workspaceId, filterId, load]);

  useEffect(() => {
    if (!connectionId || !selectedId) return;
    void loadDetail(connectionId, selectedId);
  }, [connectionId, selectedId, loadDetail]);

  const detailStatus = detail?.task.lastStatus;
  useEffect(() => {
    if (!connectionId || !selectedId || detailStatus !== 'running') return;
    const timer = setInterval(() => void loadDetail(connectionId, selectedId), 5_000);
    return () => clearInterval(timer);
  }, [connectionId, selectedId, detailStatus, loadDetail]);

  useEffect(() => {
    if (selectedId && tasks.some((task) => task.id === selectedId)) return;
    setSelectedId(tasks[0]?.id ?? null);
  }, [tasks, selectedId]);

  async function refreshDetail(): Promise<void> {
    if (!connectionId || !selectedId) return;
    await loadDetail(connectionId, selectedId);
    await load(connectionId, workspaceId ?? undefined, { silent: true, sessionId: filterId });
  }

  async function toggle(task: ScheduledTaskDto): Promise<void> {
    if (!connectionId) return;
    const result = await update(connectionId, task.id, { enabled: !task.enabled });
    setMessage(result.ok ? null : result.error);
    if (result.ok) await refreshDetail();
  }

  async function run(task: ScheduledTaskDto): Promise<void> {
    if (!connectionId || startingTaskId === task.id || task.lastStatus === 'running') return;
    setStartingTaskId(task.id);
    try {
      const result = await runNow(connectionId, task.id);
      setMessage(result.ok ? '已开始运行' : result.error);
      if (result.ok) await refreshDetail();
    } finally {
      setStartingTaskId(null);
    }
  }

  async function removeTask(task: ScheduledTaskDto): Promise<void> {
    if (!connectionId) return;
    if (!window.confirm(`删除定时任务「${task.name}」？`)) return;
    const result = await remove(connectionId, task.id);
    setMessage(result.ok ? null : result.error);
    if (result.ok) setSelectedId(null);
  }

  async function newTask(): Promise<void> {
    if (!connectionId) return;
    const result = await startConfigSession(connectionId, workspaceId ?? undefined);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    onOpenSession(result.sessionId);
  }

  return (
    <div className="tasks">
      <div className="tasks-head">
        <div>
          <div className="title">定时任务</div>
          <div className="sub">
            <span>
              {taskFilter
                ? `会话：${taskFilter.title ?? taskFilter.id}`
                : workspaceName
                  ? `工作区：${workspaceName}`
                  : '所有工作区'}{' '}
              · 无人值守
            </span>
            <span className="perm-badge" title="定时任务以 bypass 权限运行，不再逐条审批">
              完全权限
            </span>
          </div>
        </div>
        <div className="tasks-head-actions">
          {taskFilter && (
            <button className="btn" onClick={onClearTaskFilter}>
              查看全部
            </button>
          )}
          <button
            className="btn"
            onClick={() =>
              void load(connectionId ?? '', workspaceId ?? undefined, {
                silent: true,
                sessionId: filterId,
              })
            }
          >
            刷新
          </button>
          <button className="btn soft" onClick={() => setConfirmNewTask(true)}>
            新建任务
          </button>
        </div>
      </div>

      {message && (
        <div className="tasks-message" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}

      <div className="tasks-split">
        <div className="tasks-list">
          {scope?.error && <div className="empty">{scope.error}</div>}
          {!scope?.error && tasks.length === 0 && (
            <div className="empty">
              {taskFilter ? '这个会话还没有定时任务。' : '还没有定时任务。'}
              <br />
              {taskFilter ? '点「新建任务」，让 AI 为这个会话创建一个。' : '创建一个：按计划自动唤醒会话或执行命令。'}
            </div>
          )}
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-row${selectedId === task.id ? ' active' : ''}${task.enabled ? '' : ' off'}`}
              onClick={() => setSelectedId(task.id)}
            >
              <div className="task-row-top">
                <span className="task-name">{task.name}</span>
                <span className={`task-status status-${statusTone(task)}`}>{statusLabel(task)}</span>
              </div>
              <div className="task-row-sub">
                {task.schedule.label} · 下次 {relativeTime(task.nextRunAt)}
              </div>
              <div className="task-row-sub">
                {task.type === 'command' ? '执行命令' : task.sessionTitle ? `会话：${task.sessionTitle}` : '新会话'}
                {task.createdBy === 'mcp' ? ' · AI 创建' : ''}
              </div>
            </button>
          ))}
        </div>

        <div className="tasks-detail">
          {!detail && <div className="empty">选择一个任务查看详情</div>}
          {detail && (
            <TaskDetail
              key={detail.task.id}
              task={detail.task}
              runs={detail.runs}
              starting={startingTaskId === detail.task.id}
              onOpenSession={onOpenSession}
              onToggle={() => void toggle(detail.task)}
              onRun={() => void run(detail.task)}
              onDelete={() => void removeTask(detail.task)}
              onEdit={() => setEditingTask(detail.task)}
            />
          )}
        </div>
      </div>

      {confirmNewTask && (
        <div className="modal-scrim" onClick={() => setConfirmNewTask(false)}>
          <div className="modal task-editor" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div className="title">用 AI 配置定时任务</div>
              <button className="btn ghost" onClick={() => setConfirmNewTask(false)}>
                关闭
              </button>
            </div>
            <div className="task-form">
              <p className="task-meta">
                将打开「配置定时任务」会话。AI 会先问你想要完成什么任务，分析后给出名称、目标、计划和执行内容，
                确认后才会创建。
              </p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirmNewTask(false)}>
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    setConfirmNewTask(false);
                    void newTask();
                  }}
                >
                  开始配置
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingTask && connectionId && (
        <TaskEditorDialog
          connectionId={connectionId}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={async (task) => {
            setEditingTask(null);
            setSelectedId(task.id);
            await load(connectionId, workspaceId ?? undefined, { silent: true, sessionId: filterId });
            await loadDetail(connectionId, task.id);
          }}
        />
      )}
    </div>
  );
}

function TaskDetail({
  task,
  runs,
  starting,
  onOpenSession,
  onToggle,
  onRun,
  onDelete,
  onEdit,
}: {
  task: ScheduledTaskDto;
  runs: RunDto[];
  starting: boolean;
  onOpenSession: (sessionId: string) => void;
  onToggle: () => void;
  onRun: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const running = task.lastStatus === 'running';
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const promptText = (task.type === 'command' ? task.command : task.prompt) ?? '';
  const promptLines = promptText ? promptText.split('\n').length : 0;
  const canCollapse = promptLines > 8;

  function copyPrompt(): void {
    void navigator.clipboard.writeText(promptText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <div>
          <h2>{task.name}</h2>
          <div className="task-meta">
            <span>{task.type === 'command' ? '命令任务' : 'AI 会话任务'}</span>
            <span>·</span>
            <span>{task.schedule.label}</span>
            <span className="perm-badge" title="定时任务以 bypass 权限运行，不再逐条审批">
              完全权限
            </span>
            {task.createdBy === 'mcp' && (
              <>
                <span>·</span>
                <span>AI 创建</span>
              </>
            )}
          </div>
        </div>
        <div className="task-detail-actions">
          <button className="btn soft" onClick={onRun} disabled={running || starting}>
            {running ? '运行中…' : starting ? '启动中…' : '立即运行'}
          </button>
          <button className="btn" onClick={onToggle}>
            {task.enabled ? '停用' : '启用'}
          </button>
          <button className="btn" onClick={onEdit}>
            编辑
          </button>
          <span className="task-actions-sep" aria-hidden="true" />
          <button className="btn danger" onClick={onDelete}>
            删除
          </button>
        </div>
      </div>

      {!task.enabled && task.disabledReason && (
        <div className="task-warning">已停用：{task.disabledReason}</div>
      )}
      {task.lastError && <div className="task-warning">最近错误：{task.lastError}</div>}

      <section className="task-section">
        <div className="task-grid">
          <span>下次运行</span>
          <b>{relativeTime(task.nextRunAt)}</b>
          <span>上次运行</span>
          <b>{relativeTime(task.lastRunAt)}</b>
          <span>状态</span>
          <b className={`task-status status-${statusTone(task)}`}>{statusLabel(task)}</b>
          <span>执行次数</span>
          <b>{task.runCount}</b>
          <span>目标</span>
          <b>
            {task.type === 'command'
              ? '当前工作区'
              : task.sessionTitle ?? '首次触发时创建会话'}
            {task.type === 'ai' && task.sessionId && (
              <button className="btn tiny" onClick={() => onOpenSession(task.sessionId as string)}>
                打开会话
              </button>
            )}
          </b>
        </div>
      </section>

      <section className="task-section">
        <div className="task-section-head">
          <h3>执行指令</h3>
          {promptLines > 0 && <span className="task-section-meta">{promptLines} 行</span>}
          <span className="task-section-spacer" />
          {promptText && (
            <button className="btn tiny ghost" onClick={copyPrompt} title="复制执行指令">
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              {copied ? '已复制' : '复制'}
            </button>
          )}
          {canCollapse && (
            <button className="btn tiny ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
        {promptText && (
          <pre className={`task-prompt${canCollapse && !expanded ? ' collapsed' : ''}`}>{promptText}</pre>
        )}
      </section>

      <section className="task-section">
        <div className="task-section-head">
          <h3>执行历史</h3>
          <span className="task-section-meta">{runs.length} 次</span>
        </div>
        {runs.length === 0 ? (
          <div className="empty">还没有执行记录</div>
        ) : (
          <>
            <div className="task-run-head">
              <span>时间</span>
              <span>结果</span>
              <span>触发</span>
              <span />
            </div>
            {runs.map((run) => {
              const state = runState(run.status);
              return (
                <div key={run.id} className="task-run">
                  <div className="task-run-row">
                    <span title={new Date(run.startedAt).toLocaleString()}>{runTime(run.startedAt)}</span>
                    <span className={`task-run-state ${state.tone}`}>{state.label}</span>
                    <span className="task-run-trigger">
                      {run.trigger === 'scheduled' ? '定时' : run.trigger === 'run_now' ? '手动' : '交互'}
                    </span>
                    {task.type === 'ai' ? (
                      <button className="task-run-link" onClick={() => onOpenSession(run.sessionId)}>
                        查看会话
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                  {run.output && <pre className="task-run-output">{run.output}</pre>}
                </div>
              );
            })}
          </>
        )}
      </section>
    </div>
  );
}

interface EditorProps {
  connectionId: string;
  task: ScheduledTaskDto;
  onClose: () => void;
  onSaved: (task: ScheduledTaskDto) => Promise<void> | void;
}

function TaskEditorDialog({ connectionId, task, onClose, onSaved }: EditorProps) {
  const update = useScheduledTasks((state) => state.update);
  const [targetSessionId, setTargetSessionId] = useState<string | null>(task.sessionId);
  const [targetSessions, setTargetSessions] = useState<SessionDto[] | null>(null);
  const presetDto = task.schedule.preset;
  const [name, setName] = useState(task.name);
  const [prompt, setPrompt] = useState(task.prompt ?? '');
  const [command, setCommand] = useState(task.command ?? '');
  const [preset, setPreset] = useState<SchedulePresetKind>(
    (presetDto?.preset as SchedulePresetKind | undefined) ?? 'daily',
  );
  const [time, setTime] = useState(presetDto?.time ?? '09:00');
  const [days, setDays] = useState<number[]>(presetDto?.days ?? [1]);
  const [every, setEvery] = useState(presetDto?.every ?? 6);
  const [error, setError] = useState<string | null>(null);
  // Raw-cron tasks have no preset metadata; keep their schedule untouched.
  const scheduleEditable = presetDto != null;

  // Fetch locally instead of the sessions store: that store backs the rail and
  // must not be repointed at another workspace by opening a task editor.
  useEffect(() => {
    if (task.type !== 'ai') return;
    let cancelled = false;
    setTargetSessions(null);
    void (async () => {
      const response = await api.sessions(task.workspaceId);
      if (cancelled) return;
      // The reusable task-authoring chat is not a meaningful target.
      setTargetSessions(
        response.ok ? response.data.sessions.filter((session) => session.purpose == null) : [],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [task.type, task.workspaceId]);

  function buildSchedule(): ScheduleInput {
    if (preset === 'every_minutes' || preset === 'every_hours') return { preset, every };
    if (preset === 'weekly') return { preset, time, days };
    return { preset, time };
  }

  async function submit(): Promise<void> {
    setError(null);
    if (!name.trim()) {
      setError('请填写任务名称');
      return;
    }
    if (task.type === 'ai' && !prompt.trim()) {
      setError('请填写执行指令');
      return;
    }
    if (task.type === 'command' && !command.trim()) {
      setError('请填写命令');
      return;
    }
    if (scheduleEditable && preset === 'weekly' && days.length === 0) {
      setError('请至少选择一个星期');
      return;
    }
    // Only rewrite the binding when the user actually changed it.
    const targetChanged = task.type === 'ai' && targetSessionId !== task.sessionId;
    const target: NonNullable<UpdateScheduledTaskRequest['target']> = targetSessionId
      ? { mode: 'existing', sessionId: targetSessionId }
      : { mode: 'new' };
    const patch: UpdateScheduledTaskRequest = {
      name: name.trim(),
      ...(task.type === 'ai' ? { prompt: prompt.trim() } : { command: command.trim() }),
      ...(scheduleEditable ? { schedule: buildSchedule() } : {}),
      ...(targetChanged ? { target } : {}),
    };
    const result = await update(connectionId, task.id, patch);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onSaved(result.task);
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal task-editor" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="title">编辑定时任务</div>
          <button className="btn ghost" title="关闭" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="task-form">
          <div className="task-meta">
            <span>{task.type === 'command' ? '命令任务' : 'AI 会话任务'}</span>
            <span className="perm-badge" title="定时任务以 bypass 权限运行，不再逐条审批">
              完全权限
            </span>
          </div>

          <div className="field">
            <label>名称</label>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          {task.type === 'ai' && (
            <div className="field">
              <label>目标会话</label>
              <select
                value={targetSessionId ?? ''}
                onChange={(event) => setTargetSessionId(event.target.value || null)}
              >
                <option value="">下次运行新建会话</option>
                {targetSessionId && !(targetSessions ?? []).some((session) => session.id === targetSessionId) && (
                  <option value={targetSessionId}>{task.sessionTitle ?? targetSessionId}</option>
                )}
                {(targetSessions ?? []).map((session) => (
                  <option key={session.id} value={session.id}>
                    {(session.title?.trim() || session.cwd) +
                      ' · ' +
                      runtimeIdentity(session.runtime).displayName}
                  </option>
                ))}
              </select>
              {targetSessions == null && <div className="task-meta">正在加载会话…</div>}
            </div>
          )}

          <div className="field">
            <label>{task.type === 'command' ? '命令（在工作区根目录执行）' : '执行指令'}</label>
            {task.type === 'command' ? (
              <textarea rows={6} value={command} onChange={(event) => setCommand(event.target.value)} />
            ) : (
              <textarea rows={8} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            )}
          </div>

          {scheduleEditable ? (
            <div className="field">
              <label>计划</label>
              <div className="task-schedule-row">
                <select value={preset} onChange={(event) => setPreset(event.target.value as SchedulePresetKind)}>
                  {(Object.keys(PRESET_LABELS) as SchedulePresetKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {PRESET_LABELS[kind]}
                    </option>
                  ))}
                </select>
                {(preset === 'daily' || preset === 'weekdays' || preset === 'weekly') && (
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
                )}
                {(preset === 'every_minutes' || preset === 'every_hours') && (
                  <input
                    type="number"
                    min={1}
                    value={every}
                    onChange={(event) => setEvery(Number(event.target.value) || 1)}
                  />
                )}
              </div>
              {preset === 'weekly' && (
                <div className="task-days">
                  {WEEKDAYS.map((label, day) => (
                    <label key={label}>
                      <input
                        type="checkbox"
                        checked={days.includes(day)}
                        onChange={(event) =>
                          setDays((current) =>
                            event.target.checked
                              ? [...current, day].sort((a, b) => a - b)
                              : current.filter((value) => value !== day),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="task-note warn">
              该任务使用自定义 cron（{task.schedule.cron}），当前只能编辑名称和内容。
            </div>
          )}

          <div className="task-note">
            修改（含目标会话）从下一次触发开始生效；正在运行的任务不受影响。
          </div>

          {error && <div className="task-warning">{error}</div>}

          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" onClick={() => void submit()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
