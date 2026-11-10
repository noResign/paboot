import { useEffect, useRef, useState } from 'react';
import { comboLabel } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import { Icon } from '../../ui/Icon';
import { uploadAttachment } from '../../ipc/client';
import {
  IMAGE_TYPES,
  MAX_IMAGES,
  isImageFile,
  prepareImage,
} from './imageDraft';
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
  /** False when the selected model cannot receive images. */
  imagesSupported: boolean;
  /** Dynamic knobs declared by the selected model (e.g. reasoning effort). */
  parameters: ModelParameterDto[];
  modelParameters: Record<string, string>;
  onModelChange(model: string | null): void;
  onParameterChange(parameterId: string, valueId: string | null): void;
  onSend(text: string, attachmentIds?: string[]): void;
  onStop(): void;
}

interface DraftImage {
  id: string;
  mediaType: string;
  previewUrl: string;
  name: string;
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
  imagesSupported,
  parameters,
  modelParameters,
  onModelChange,
  onParameterChange,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<DraftImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS * LINE_HEIGHT)}px`;
  }, [text]);

  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  function removeImage(id: string): void {
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    const list = files.filter(isImageFile);
    if (list.length === 0) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setAttachError(`最多添加 ${MAX_IMAGES} 张图片`);
      return;
    }
    const chosen = list.slice(0, room);
    if (list.length > room) setAttachError(`最多添加 ${MAX_IMAGES} 张图片，已忽略多余图片`);
    setUploading(true);
    setAttachError(null);
    const added: DraftImage[] = [];
    for (const file of chosen) {
      try {
        const prepared = await prepareImage(file);
        const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
        const res = await uploadAttachment(bytes, prepared.mediaType);
        if (!res.ok) {
          URL.revokeObjectURL(prepared.previewUrl);
          const data = res.data as { error?: unknown; message?: unknown } | null;
          throw new Error(
            (typeof data?.message === 'string' && data.message) ||
              (typeof data?.error === 'string' && data.error) ||
              `上传失败（HTTP ${res.status}）`,
          );
        }
        const data = res.data as { id?: unknown };
        if (typeof data?.id !== 'string') throw new Error('daemon 未返回附件 id');
        added.push({
          id: data.id,
          mediaType: prepared.mediaType,
          previewUrl: prepared.previewUrl,
          name: prepared.name,
        });
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
      }
    }
    setUploading(false);
    if (added.length > 0) setImages((current) => [...current, ...added]);
  }

  function submit(): void {
    const value = text.trim();
    if (disabled || uploading) return;
    if (!value && images.length === 0) return;
    const ids = images.map((image) => image.id);
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setText('');
    setImages([]);
    setAttachError(null);
    onSend(value, ids.length > 0 ? ids : undefined);
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
      <div
        className="box"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          void addFiles([...event.dataTransfer.files]);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles([...event.target.files]);
            event.target.value = '';
          }}
        />
        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <img src={image.previewUrl} alt={image.name} />
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title="移除"
                  onClick={() => removeImage(image.id)}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachError && <p className="composer-attach-error">{attachError}</p>}
        <textarea
          ref={ref}
          rows={2}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter(isImageFile);
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line — the desktop convention.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-foot">
          <button
            type="button"
            className="icon-btn composer-attach"
            title={
              imagesSupported ? '添加图片（也可以直接粘贴或拖入）' : '当前模型不支持图片输入'
            }
            disabled={disabled || uploading || !imagesSupported || images.length >= MAX_IMAGES}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="plus" size={15} />
          </button>
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
            {uploading
              ? '正在上传图片…'
              : busy
                ? `${comboLabel('stop-run', IS_MAC)} 停止运行`
                : imagesSupported
                  ? 'Enter 发送 · Shift+Enter 换行 · 可粘贴/拖入图片'
                  : '当前模型不支持图片输入'}
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
            <button
              className="btn primary send"
              disabled={disabled || uploading || (!text.trim() && images.length === 0)}
              onClick={submit}
            >
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
