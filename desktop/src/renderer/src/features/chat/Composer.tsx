import { useEffect, useRef, useState } from 'react';
import { comboLabel } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import { Icon } from '../../ui/Icon';
import type { ModelOptionDto, ModelParameterDto } from '../../../../shared/contract';

interface Props {
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  /** Bottom-left model picker; hidden until the session exists. */
  showModel: boolean;
  model: string | null;
  models: ModelOptionDto[];
  modelsError: string | null;
  /** Dynamic knobs declared by the selected model (e.g. reasoning effort). */
  parameters: ModelParameterDto[];
  modelParameters: Record<string, string>;
  onModelChange(model: string | null): void;
  onParameterChange(parameterId: string, valueId: string | null): void;
  onSend(text: string): void;
  onStop(): void;
}

const MAX_ROWS = 8;
/** Must track `.composer textarea`'s computed line-height (13.5px × 1.6). */
const LINE_HEIGHT = 22;

export function Composer({
  disabled,
  busy,
  placeholder,
  showModel,
  model,
  models,
  modelsError,
  parameters,
  modelParameters,
  onModelChange,
  onParameterChange,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS * LINE_HEIGHT)}px`;
  }, [text]);

  function submit(): void {
    const value = text.trim();
    if (!value || disabled) return;
    setText('');
    onSend(value);
  }

  return (
    <div
      className="composer"
      title={
        busy
          ? '该会话正在运行，输入暂时禁用 —— 运行中的任务在 daemon 上执行，切换会话不受影响。'
          : undefined
      }
    >
      {/*
        The run state already has two honest homes — the header pill and this
        disabled input. The old notice line above the box said it a third time,
        every time, in a full sentence; the explanation now lives in the tooltip.
      */}
      <div className="box">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line — the desktop convention.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-foot">
          {showModel && (
            <select
              className="model-select"
              value={model ?? ''}
              title={modelsError ?? '切换后从下一轮开始生效；正在运行的任务不受影响'}
              onChange={(event) => onModelChange(event.target.value || null)}
            >
              <option value="">
                {modelsError ? '模型加载失败' : '默认模型'}
              </option>
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label || option.id}
                </option>
              ))}
            </select>
          )}
          {showModel &&
            parameters.map((parameter) => (
              <select
                key={parameter.id}
                className="model-select"
                value={modelParameters[parameter.id] ?? ''}
                title={`${parameterLabel(parameter)}：切换后从下一轮开始生效`}
                onChange={(event) => onParameterChange(parameter.id, event.target.value || null)}
              >
                <option value="">{parameterLabel(parameter)}：默认</option>
                {parameter.values.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.label || value.id}
                  </option>
                ))}
              </select>
            ))}
          <span className="hint">
            {busy ? `${comboLabel('stop-run', IS_MAC)} 停止运行` : 'Enter 发送 · Shift+Enter 换行'}
          </span>
          {busy ? (
            <button
              className="btn primary send stop"
              onClick={onStop}
              title={`停止当前运行 ${comboLabel('stop-run', IS_MAC)}`}
            >
              <Icon name="stop" size={13} />
              停止
            </button>
          ) : (
            <button className="btn primary send" disabled={disabled || !text.trim()} onClick={submit}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Known parameter ids get product copy; new ones fall back to the daemon label. */
function parameterLabel(parameter: ModelParameterDto): string {
  return parameter.id === 'reasoningEffort' ? '推理强度' : parameter.label || parameter.id;
}
