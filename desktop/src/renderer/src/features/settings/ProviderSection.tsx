import { useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import { Icon } from '../../ui/Icon';
import type { ConfigResponse, ProviderDto, ProviderModelDto } from '../../../../shared/contract';

type ProviderKind = 'anthropic' | 'openai';

interface ModelDraft extends ProviderModelDto {
  /** Used only by React lists before the daemon assigns an id. */
  rowKey: string;
}

interface ProviderDraft {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  hasApiKey: boolean;
  models: ModelDraft[];
}

const EMPTY_DRAFT: ProviderDraft = {
  id: '',
  kind: 'openai',
  label: '',
  baseUrl: '',
  apiKey: '',
  clearKey: false,
  hasApiKey: false,
  models: [],
};

const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
};

function normalizedLabel(value: string): string {
  return value.replace(/[\s_-]+/g, '').toLowerCase();
}

function showProviderId(provider: ProviderDto): boolean {
  return normalizedLabel(provider.id) !== normalizedLabel(provider.label || provider.id);
}

function modelDraft(model?: ProviderModelDto): ModelDraft {
  return {
    rowKey: crypto.randomUUID(),
    id: model?.id ?? '',
    label: model?.label ?? '',
    contextWindow: model?.contextWindow,
    maxOutput: model?.maxOutput,
    supportsTools: model?.supportsTools ?? true,
    supportsImages: model?.supportsImages ?? false,
    enabled: model?.enabled ?? true,
  };
}

function editDraft(provider: ProviderDto): ProviderDraft {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiKey: '',
    clearKey: false,
    hasApiKey: provider.hasApiKey,
    models: provider.models.map((model) => modelDraft(model)),
  };
}

/**
 * Provider management for the builtin runtime and Memory. The daemon's provider
 * catalog is global: one key set and one model catalog feed both consumers.
 */
export function ProviderSection() {
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  /** Persisted global setting from /api/config. */
  const [memoryModel, setMemoryModel] = useState<string | null>(null);
  /** Checkbox state inside the currently open provider editor. */
  const [draftMemoryModel, setDraftMemoryModel] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
  }, []);

  const title = useMemo(
    () => (draft ? (editing ? `编辑 ${draft.label || draft.id}` : '新增 Provider') : ''),
    [draft, editing],
  );

  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeEditor();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draft, busy]);

  function closeEditor(): void {
    if (busy) return;
    setDraft(null);
    setDraftMemoryModel(memoryModel);
    setError(null);
  }

  async function refresh(): Promise<void> {
    const [res, configRes] = await Promise.all([api.providers(), api.config()]);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setError(friendlyMessage(apiCode, res.status, message, '加载 Provider 失败'));
      return;
    }
    setProviders(res.data.providers);
    if (configRes.ok) {
      setMemoryModel((configRes.data as ConfigResponse).memoryModel ?? null);
    }
  }

  function openCreate(): void {
    setEditing(false);
    setDraft({ ...EMPTY_DRAFT, models: [] });
    setDraftMemoryModel(memoryModel);
    setError(null);
  }

  function openEdit(provider: ProviderDto): void {
    setEditing(true);
    setDraft(editDraft(provider));
    setDraftMemoryModel(memoryModel);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!draft || busy) return;
    if (!editing && !draft.id.trim()) {
      setError('Provider id 不能为空');
      return;
    }
    if (!draft.baseUrl.trim()) {
      setError('baseUrl 不能为空');
      return;
    }
    const models = draft.models
      .filter((model) => model.id.trim())
      .map((model) => ({
        id: model.id.trim(),
        ...(model.label?.trim() ? { label: model.label.trim() } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutput ? { maxOutput: model.maxOutput } : {}),
        supportsTools: model.supportsTools !== false,
        supportsImages: model.supportsImages === true,
        enabled: model.enabled !== false,
      }));
    setBusy(true);
    setError(null);
    const common = {
      kind: draft.kind,
      label: draft.label.trim() || draft.id.trim(),
      baseUrl: draft.baseUrl.trim(),
      models,
    };
    const res = editing
      ? await api.updateProvider(draft.id, {
          ...common,
          ...(draft.clearKey
            ? { apiKey: null }
            : draft.apiKey.trim()
              ? { apiKey: draft.apiKey.trim() }
              : {}),
        })
      : await api.createProvider({
          id: draft.id.trim(),
          ...common,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        });
    setBusy(false);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setError(friendlyMessage(apiCode, res.status, message, '保存 Provider 失败'));
      return;
    }
    if (editing && draftMemoryModel !== memoryModel) {
      // Only persist an explicit selection change. Unrelated provider edits
      // must not overwrite a setting that failed to load or was not touched.
      // The daemon separately clears the setting if this provider edit made it
      // invalid (removed/disabled model, cleared key, deleted provider).
      const configRes = await api.updateConfig({ memoryModel: draftMemoryModel });
      if (!configRes.ok) {
        const { apiCode, message } = apiErrorOf(configRes.data);
        setError(friendlyMessage(apiCode, configRes.status, message, '保存记忆模型失败'));
      } else {
        setMemoryModel(draftMemoryModel);
      }
    }
    setDraft(null);
    await refresh();
  }

  async function remove(provider: ProviderDto): Promise<void> {
    if (!window.confirm(`删除 Provider「${provider.label || provider.id}」？历史会话会保留，但之后使用该模型的 run 会失败。`)) {
      return;
    }
    const res = await api.deleteProvider(provider.id);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setError(friendlyMessage(apiCode, res.status, message, '删除 Provider 失败'));
      return;
    }
    await refresh();
  }

  async function test(provider: ProviderDto): Promise<void> {
    setTestResults((current) => ({ ...current, [provider.id]: '测试中…' }));
    const res = await api.testProvider(provider.id);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setTestResults((current) => ({
        ...current,
        [provider.id]: friendlyMessage(apiCode, res.status, message, '连接失败'),
      }));
      return;
    }
    setTestResults((current) => ({
      ...current,
      [provider.id]: `连接成功 · ${res.data.latencyMs}ms · ${res.data.modelCount ?? 0} 个模型`,
    }));
  }

  async function refreshModels(provider: ProviderDto): Promise<void> {
    setTestResults((current) => ({ ...current, [provider.id]: '刷新模型…' }));
    const res = await api.refreshProviderModels(provider.id);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setTestResults((current) => ({
        ...current,
        [provider.id]: friendlyMessage(apiCode, res.status, message, '刷新模型失败'),
      }));
      return;
    }
    setTestResults((current) => ({
      ...current,
      [provider.id]: `已刷新 · ${res.data.provider.models.length} 个模型`,
    }));
    await refresh();
  }

  function patchModel(index: number, patch: Partial<ModelDraft>): void {
    setDraft((current) => current && {
      ...current,
      models: current.models.map((model, i) => (i === index ? { ...model, ...patch } : model)),
    });
  }

  return (
    <section className="settings-section">
      <div className="section-head">
        <h3>模型 Provider</h3>
        <button className="btn primary" disabled={busy} onClick={openCreate}>新增 Provider</button>
      </div>
      <div className="hint">
        builtin runtime 与 Memory 共用这份配置。API key 只写入 daemon 本机的 providers.json，
        不会回传客户端，也不会出现在日志里。
      </div>
      <div className="hint">
        内置 Provider 点击「编辑」即可覆盖 Base URL、Key 和模型；「新增」用于自定义网关或额外 Provider。
      </div>
      <div className="hint">
        在模型目录里勾选「用于记忆」，该模型会负责后台整理个人空间里的会话；只能勾选一个。
        未勾选时只记录消息，不调用模型。勾选后保存 Provider 生效。
      </div>

      <div className="provider-list">
        {providers.map((provider) => (
          <div className="provider-card" key={provider.id}>
            <div className="provider-head">
              <div className="provider-title">
                <b>{provider.label || provider.id}</b>
                {showProviderId(provider) && <span className="provider-id mono">{provider.id}</span>}
                <span className="badge subtle">{PROVIDER_KIND_LABEL[provider.kind]}</span>
                {provider.builtin && <span className="badge subtle">内置</span>}
              </div>
              <span className={`provider-key ${provider.hasApiKey ? 'ok' : 'missing'}`}>
                <span className="provider-key-dot" />
                {provider.hasApiKey ? `Key 已配置 · ${provider.apiKeySource ?? 'unknown'}` : '未配置 Key'}
              </span>
            </div>
            <div className="provider-meta mono">{provider.baseUrl}</div>
            <div className="provider-meta">
              {provider.models.length} 个模型 · 已启用 {provider.models.filter((model) => model.enabled !== false).length} 个
              {provider.models.some((model) => model.supportsImages) ? ' · 支持图片' : ''}
            </div>
            <div className="settings-actions">
              <button className="btn" onClick={() => openEdit(provider)}>编辑</button>
              <button className="btn" onClick={() => void test(provider)} disabled={!provider.hasApiKey}>测试连接</button>
              <button className="btn" onClick={() => void refreshModels(provider)} disabled={!provider.hasApiKey}>刷新模型</button>
              {!provider.builtin && <button className="btn danger" onClick={() => void remove(provider)}>删除</button>}
            </div>
            {testResults[provider.id] && <div className="hint">{testResults[provider.id]}</div>}
          </div>
        ))}
      </div>

      {draft && (
        <div className="modal-scrim" onClick={closeEditor}>
          <div
            className="modal provider-modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <span>{title}</span>
              <button className="btn ghost" title="关闭" disabled={busy} onClick={closeEditor}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="provider-form-grid">
            <div className="field">
              <label>ID</label>
              <input
                value={draft.id}
                readOnly={editing}
                placeholder="my-provider"
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            </div>
            <div className="field">
              <label>类型</label>
              <select
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as ProviderKind })}
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="field">
              <label>显示名称</label>
              <input
                value={draft.label}
                placeholder="我的 Provider"
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </div>
            <div className="field provider-base-url">
              <label>Base URL</label>
              <input
                value={draft.baseUrl}
                placeholder="https://api.example.com"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              autoComplete="new-password"
              value={draft.apiKey}
              placeholder={editing ? (draft.hasApiKey ? '已配置；留空不修改' : '未配置；输入新 Key') : '可选，也可以稍后设置'}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, clearKey: false })}
            />
            {editing && draft.hasApiKey && (
              <label className="provider-clear-key">
                <input
                  type="checkbox"
                  checked={draft.clearKey}
                  onChange={(event) => setDraft({ ...draft, clearKey: event.target.checked, apiKey: '' })}
                />
                清除已保存的 Key（环境变量 fallback 仍可生效）
              </label>
            )}
          </div>

          <div className="provider-model-head">
            <b>模型目录</b>
            <button
              className="btn"
              onClick={() => setDraft({ ...draft, models: [...draft.models, modelDraft()] })}
            >
              添加模型
            </button>
          </div>
          <div className="provider-model-list">
            {draft.models.length === 0 && <div className="hint">还没有模型。至少添加一个模型后 builtin 才会显示为可用。</div>}
            {draft.models.map((model, index) => (
              <div className="provider-model-row" key={model.rowKey}>
                <div className="provider-model-identity">
                  <label className="provider-model-field">
                    <span>模型 ID</span>
                    <input
                      value={model.id}
                      placeholder="model id"
                      onChange={(event) => patchModel(index, { id: event.target.value })}
                    />
                  </label>
                  <label className="provider-model-field">
                    <span>显示名称</span>
                    <input
                      value={model.label ?? ''}
                      placeholder="显示名称"
                      onChange={(event) => patchModel(index, { label: event.target.value })}
                    />
                  </label>
                </div>
                <div className="provider-model-params">
                  <label className="provider-model-number">
                    <span>上下文</span>
                    <input
                      type="number"
                      value={model.contextWindow ?? ''}
                      placeholder="128000"
                      onChange={(event) => patchModel(index, {
                        contextWindow: event.target.value ? Number(event.target.value) : undefined,
                      })}
                    />
                  </label>
                  <label className="provider-model-number">
                    <span>最大输出</span>
                    <input
                      type="number"
                      value={model.maxOutput ?? ''}
                      placeholder="8192"
                      onChange={(event) => patchModel(index, {
                        maxOutput: event.target.value ? Number(event.target.value) : undefined,
                      })}
                    />
                  </label>
                  <div className="provider-model-flags">
                    <label><input type="checkbox" checked={model.supportsTools !== false} onChange={(event) => patchModel(index, { supportsTools: event.target.checked })} /> Tools</label>
                    <label><input type="checkbox" checked={model.supportsImages === true} onChange={(event) => patchModel(index, { supportsImages: event.target.checked })} /> 图片</label>
                    <label><input type="checkbox" checked={model.enabled !== false} onChange={(event) => patchModel(index, { enabled: event.target.checked })} /> 启用</label>
                    {editing && (
                      <label title="负责后台整理个人空间里的会话；只能勾选一个">
                        <input
                          type="checkbox"
                          checked={draftMemoryModel === `${draft.id}:${model.id.trim()}`}
                          disabled={!model.id.trim() || model.enabled === false || (!draft.hasApiKey && !draft.apiKey.trim())}
                          onChange={(event) => {
                            const id = `${draft.id}:${model.id.trim()}`;
                            if (event.target.checked) setDraftMemoryModel(id);
                            else if (draftMemoryModel === id) setDraftMemoryModel(null);
                          }}
                        />{' '}
                        用于记忆
                      </label>
                    )}
                  </div>
                  <button
                    className="btn danger provider-model-delete"
                    onClick={() => setDraft({ ...draft, models: draft.models.filter((_, i) => i !== index) })}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>

            {error && <div className="error-text">{error}</div>}
            <div className="modal-actions">
              <button className="btn" disabled={busy} onClick={closeEditor}>取消</button>
              <button className="btn primary" disabled={busy} onClick={() => void save()}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && !draft && <div className="error-text">{error}</div>}
    </section>
  );
}
