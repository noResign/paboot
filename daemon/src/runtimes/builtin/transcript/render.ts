import type { LlmContentBlock, LlmMessage } from '../../../llm/types.js';
import { log } from '../../../platform/log.js';
import type {
  NativeMessage,
  TranscriptContentBlock,
} from '../../../types/transcript.js';
import { projectActiveMessages } from './projection.js';

type ImageBlock = Extract<TranscriptContentBlock, { type: 'image' }>;

export type TranscriptImageResolver = (
  block: ImageBlock,
) => Promise<LlmContentBlock | null> | LlmContentBlock | null;

export interface TranscriptRenderOptions {
  /**
   * P3.2 can render with a placeholder. P3.7's attachment store supplies the
   * actual provider image block here, so transcript storage never contains
   * base64 bytes.
   */
  resolveImage?: TranscriptImageResolver;
  /** When false, historical images become text placeholders. Default true. */
  supportsImages?: boolean;
}

/** Bridge the attachment store into the transcript renderer. */
export function createAttachmentImageResolver(store: {
  providerImage(
    id: string,
    expectedMediaType?: ImageBlock['mediaType'],
  ): Promise<{ mediaType: ImageBlock['mediaType']; data: string }>;
}): TranscriptImageResolver {
  return async (block) => {
    const image = await store.providerImage(block.attachmentId, block.mediaType);
    return { type: 'image', mediaType: image.mediaType, data: image.data };
  };
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
  let pendingResultIds = new Set<string>();

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
    pendingResultIds = new Set<string>();
  };

  /** Render tool results, deduping ids within one assistant exchange. */
  const renderResults = async (
    message: NativeMessage,
    seen: Set<string>,
  ): Promise<LlmContentBlock[]> => {
    const blocks = await renderToolResultBlocks(message, options);
    return blocks.filter((block) => {
      if (block.type !== 'tool_result') return true;
      if (seen.has(block.toolUseId)) return false;
      seen.add(block.toolUseId);
      return true;
    });
  };

  const projected = projectActiveMessages(messages);
  for (let index = 0; index < projected.length; index += 1) {
    const message = projected[index]!;
    if (message.role === 'tool') {
      pendingToolResults.push(...(await renderResults(message, pendingResultIds)));
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

    // A crashed or cancelled run can leave assistant tool calls without a
    // result. Providers reject the whole request in that case, so synthesize a
    // paired error result and keep the session usable.
    const results: LlmContentBlock[] = [];
    const answered = new Set<string>();
    let next = index + 1;
    while (next < projected.length && projected[next]!.role === 'tool') {
      results.push(...(await renderResults(projected[next]!, answered)));
      next += 1;
    }
    for (const block of message.blocks) {
      if (block.type !== 'tool_call' || answered.has(block.id)) continue;
      answered.add(block.id);
      results.push({
        type: 'tool_result',
        toolUseId: block.id,
        content: 'interrupted: no result was recorded for this tool call',
        isError: true,
      });
    }
    if (results.length > 0) out.push({ role: 'user', content: results });
    index = next - 1;
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
  if (!block.offloaded && options.supportsImages !== false && options.resolveImage) {
    try {
      const resolved = await options.resolveImage(block);
      if (resolved) return resolved;
    } catch (error) {
      // A missing/corrupted attachment must not brick every later turn: the
      // transcript keeps the reference forever, so degrade to a placeholder.
      log.warn(
        `builtin transcript: image ${block.attachmentId} could not be loaded: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const reason = options.supportsImages === false
    ? 'current model does not support images'
    : 'image data is unavailable';
  return {
    type: 'text',
    text: `[image ${block.attachmentId} omitted: ${block.mediaType}, ${block.width}x${block.height}; ${reason}]`,
  };
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
