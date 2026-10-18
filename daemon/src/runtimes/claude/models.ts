import type { ModelOption, ModelParameter } from '../types.js';

/** Levels accepted by `claude --effort` (probed before we ever pass the flag). */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const REASONING_EFFORT: ModelParameter = {
  id: 'reasoningEffort',
  label: 'Reasoning effort',
  values: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' },
    { id: 'max', label: 'Max' },
  ],
};

/**
 * Claude Code 没有「列出模型」的命令。别名会跟随本机安装解析到当前一代模型，
 * 比写死具体版本号更不容易过期；空值仍表示沿用 CLI 自己的默认配置。
 */
function model(id: string, label: string): ModelOption {
  return { id, label, parameters: [REASONING_EFFORT] };
}

export const CLAUDE_MODELS: ModelOption[] = [
  model('sonnet', 'Sonnet'),
  model('opus', 'Opus'),
  model('haiku', 'Haiku'),
];
