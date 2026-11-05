import { useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type { ProviderDto, ProviderModelDto } from '../../../../shared/contract';

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
  models: ModelDraft[];
}

const EMPTY_DRAFT: ProviderDraft = {
  id: '',
  kind: 'openai',
  label: '',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  clearKey: false,
  models: [],
};

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
    models: provider.models.map((model) => modelDraft(model)),
  };
}

/**
 * Provider management for the builtin runtime and Memory. The daemon's provider
 * catalog is global: one key set and one model catalog feed both consumers.
 */
export function ProviderSection() {
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
  }, []);

  const title = useMemo(
    () => (draft ? (editing ? `编辑 ${draft.id}` : '新增 Provider') : ''),
    [draft, editing],
  );

  async function refresh(): Promise<void> {
    const res = await api.providers();
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setError(friendlyMessage(apiCode, res.status, message, '加载 Provider 失败'));
      return;
    }
    setProviders(res.data.providers);
  }

  function openCreate(): void {
    setEditing(false);
    setDraft({ ...EMPTY_DRAFT, models: [] });
    setError(null);
  }

  function openEdit(provider: ProviderDto): void {
    setEditing(true);
    setDraft(editDraft(provider));
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
      label: draft.label.trim(),
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

      <div className="provider-list">
        {providers.map((provider) => (
          <div className="provider-card" key={provider.id}>
            <div className="provider-head">
              <div className="provider-title">
                <b>{provider.label || provider.id}</b>
                <span className="mono">{provider.id}</span>
                <span className="badge subtle">{provider.kind}</span>
                {provider.builtin && <span className="badge subtle">内置</span>}
              </div>
              <span className={`badge ${provider.hasApiKey ? '' : 'warn'}`}>
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
        <div className="provider-editor">
          <div className="section-head">
            <h3>{title}</h3>
            <button className="btn ghost" onClick={() => setDraft(null)}>取消</button>
          </div>
          <div className="provider-form-grid">
            <div className="field">
              <label>ID</label>
              <input
                value={draft.id}
                readOnly={editing}
                placeholder="deepseek"
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
                placeholder="DeepSeek"
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </div>
            <div className="field provider-base-url">
              <label>Base URL</label>
              <input
                value={draft.baseUrl}
                placeholder="https://api.deepseek.com"
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
              placeholder={editing ? '已配置；留空不修改' : '可选，也可以稍后设置'}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, clearKey: false })}
            />
            {editing && (
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
                <input
                  value={model.id}
                  placeholder="model id"
                  onChange={(event) => patchModel(index, { id: event.target.value })}
                />
                <input
                  value={model.label ?? ''}
                  placeholder="显示名称"
                  onChange={(event) => patchModel(index, { label: event.target.value })}
                />
                <input
                  type="number"
                  value={model.contextWindow ?? ''}
                  placeholder="上下文"
                  onChange={(event) => patchModel(index, {
                    contextWindow: event.target.value ? Number(event.target.value) : undefined,
                  })}
                />
                <input
                  type="number"
                  value={model.maxOutput ?? ''}
                  placeholder="最大输出"
                  onChange={(event) => patchModel(index, {
                    maxOutput: event.target.value ? Number(event.target.value) : undefined,
                  })}
                />
                <label><input type="checkbox" checked={model.supportsTools !== false} onChange={(event) => patchModel(index, { supportsTools: event.target.checked })} /> Tools</label>
                <label><input type="checkbox" checked={model.supportsImages === true} onChange={(event) => patchModel(index, { supportsImages: event.target.checked })} /> 图片</label>
                <label><input type="checkbox" checked={model.enabled !== false} onChange={(event) => patchModel(index, { enabled: event.target.checked })} /> 启用</label>
                <button
                  className="btn danger"
                  onClick={() => setDraft({ ...draft, models: draft.models.filter((_, i) => i !== index) })}
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          <div className="settings-actions">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
