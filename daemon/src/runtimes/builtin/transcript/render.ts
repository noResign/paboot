import type { LlmContentBlock, LlmMessage } from '../../../llm/types.js';
import type {
  NativeMessage,
  TranscriptContentBlock,
} from '../../../types/transcript.js';
import { projectActiveMessages } from './projection.js';

type ImageBlock = Extract<TranscriptContentBlock, { type: 'image' }>;

export interface TranscriptRenderOptions {
  /**
   * P3.2 can render with a placeholder. P3.7's attachment store supplies the
   * actual provider image block here, so transcript storage never contains
   * base64 bytes.
   */
  resolveImage?: (block: ImageBlock) => Promise<LlmContentBlock | null> | LlmContentBlock | null;
}

/**
 * Project the durable thread into the neutral message array consumed by the
 * shared LLM adapters. It drops all but the latest runtime-context snapshot,
 * merges consecutive tool results into one user message, and keeps tool-call /
 * tool-result pairing intact.
 */
export async function renderTranscriptMessages(
  messages: readonly NativeMessage[],
  options: TranscriptRenderOptions = {},
): Promise<LlmMessage[]> {
  const out: LlmMessage[] = [];
  let pendingToolResults: LlmContentBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of projectActiveMessages(messages)) {
    if (message.role === 'tool') {
      pendingToolResults.push(...(await renderToolResultBlocks(message, options)));
      continue;
    }
    flushToolResults();
    if (message.role === 'user') {
      const content = await renderUserBlocks(message, options);
      if (content.length > 0) out.push({ role: 'user', content });
      continue;
    }
    const content = await renderAssistantBlocks(message, options);
    if (content.length > 0) out.push({ role: 'assistant', content });
  }
  flushToolResults();
  return out;
}

async function renderUserBlocks(
  message: NativeMessage,
  options: TranscriptRenderOptions,
): Promise<LlmContentBlock[]> {
  const out: LlmContentBlock[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: block.text });
        break;
      case 'image': {
        const resolved = await resolveImage(block, options);
        out.push(resolved);
        break;
      }
      case 'tool_result':
        out.push(toolResultBlock(block));
        break;
      case 'reasoning':
      case 'tool_call':
        break;
    }
  }
  return out;
}

async function renderAssistantBlocks(
  message: NativeMessage,
  options: TranscriptRenderOptions,
): Promise<LlmContentBlock[]> {
  const out: LlmContentBlock[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: block.text });
        break;
      case 'tool_call':
        out.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parseToolArguments(block.arguments),
        });
        break;
      case 'image': {
        const resolved = await resolveImage(block, options);
        out.push(resolved);
        break;
      }
      case 'reasoning':
      case 'tool_result':
        // Reasoning replay needs provider signatures; P3 stores it but does
        // not send it back across providers. Tool results belong to role=tool.
        break;
    }
  }
  return out;
}

async function renderToolResultBlocks(
  message: NativeMessage,
  options: TranscriptRenderOptions,
): Promise<LlmContentBlock[]> {
  const out: LlmContentBlock[] = [];
  for (const block of message.blocks) {
    if (block.type === 'tool_result') out.push(toolResultBlock(block));
    else if (block.type === 'image') out.push(await resolveImage(block, options));
    else if (block.type === 'text' && block.text) out.push({ type: 'text', text: block.text });
  }
  return out;
}

function toolResultBlock(
  block: Extract<TranscriptContentBlock, { type: 'tool_result' }>,
): LlmContentBlock {
  return {
    type: 'tool_result',
    toolUseId: block.toolUseId,
    content: block.content,
    ...(block.isError ? { isError: true } : {}),
  };
}

async function resolveImage(
  block: ImageBlock,
  options: TranscriptRenderOptions,
): Promise<LlmContentBlock> {
  if (!block.offloaded && options.resolveImage) {
    const resolved = await options.resolveImage(block);
    if (resolved) return resolved;
  }
  return {
    type: 'text',
    text: `[image ${block.attachmentId} omitted: ${block.mediaType}, ${block.width}x${block.height}]`,
  };
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
