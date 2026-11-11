import type { LlmContentBlock, LlmMessage } from '../llm/types.js';
import type { Redactor, ToolServerLike, ToolServerSnapshot } from './types.js';

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_KEY = /\bsk-[A-Za-z0-9._-]{8,}\b/g;
const ENV_TOKEN = /\b(PABOOT_(?:TOKEN|AGENT_TOKEN|SERVER_TOKEN))=[^\s"']+/g;

/**
 * Redact secrets from anything that will be shown in the debug page. Daemon
 * tokens are replaced exactly; the regexes are a safety net for values we do
 * not know about (e.g. a provider key echoed by an upstream error).
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const exact = secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= 8)
    .sort((a, b) => b.length - a.length);

  const text = (value: string): string => {
    let out = value;
    for (const secret of exact) out = out.split(secret).join('[redacted]');
    return out.replace(BEARER, 'Bearer [redacted]').replace(SK_KEY, '[redacted]').replace(ENV_TOKEN, '$1=[redacted]');
  };

  return {
    text,
    messages(messages) {
      return messages.map((message) => ({
        role: message.role,
        content:
          typeof message.content === 'string'
            ? text(message.content)
            : message.content.map((block) => redactBlock(block, text)),
      }));
    },
    toolServers(servers: readonly ToolServerLike[]): ToolServerSnapshot[] {
      return servers.map((server) => ({
        name: server.name,
        command: text(server.command),
        args: server.args.map(text),
        envKeys: Object.keys(server.env).sort(),
      }));
    },
  };
}

function redactBlock(block: LlmContentBlock, text: (value: string) => string): LlmContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: text(block.text) };
    case 'image':
      // Base64 is by far the largest part of a request; the debug view only
      // needs to know an image was present and how large it was.
      return {
        type: 'image',
        mediaType: block.mediaType,
        data: `[image omitted: ${block.data.length} base64 chars]`,
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: redactValue(block.input, text) };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: text(block.content),
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      };
  }
}

/** Deep-redact an arbitrary JSON-able value (used for provider wire bodies). */
export function redactDeep(value: unknown, redactor: Redactor): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return `[image omitted: ${value.length} chars]`;
    }
    return redactor.text(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, redactor);
    return out;
  }
  return value;
}

function redactValue(value: unknown, text: (value: string) => string): unknown {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, text));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, text);
    return out;
  }
  return value;
}
