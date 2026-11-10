type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function imageMarker(block: JsonObject): string {
  const source = asRecord(block.source) ?? block;
  const mediaType =
    typeof block.mimeType === 'string'
      ? block.mimeType
      : typeof source.media_type === 'string'
        ? source.media_type
        : typeof source.mediaType === 'string'
          ? source.mediaType
          : 'image';
  return `[image omitted: ${mediaType}]`;
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 4_096) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 1_024));
}

/** JSON fallback that drops base64 payloads even when the block shape is unknown. */
function safeJson(value: unknown): string {
  const rendered = JSON.stringify(value, (key, nested) => {
    if (
      (key === 'data' || key === 'base64') &&
      typeof nested === 'string' &&
      looksLikeBase64(nested)
    ) {
      return '[image data omitted]';
    }
    return nested;
  });
  return rendered ?? '';
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  const record = asRecord(block);
  if (!record) return safeJson(block);
  if (record.type === 'text') return typeof record.text === 'string' ? record.text : '';
  if (record.type === 'image') return imageMarker(record);
  // ACP wraps content blocks twice: { type: 'content', content: {...} }.
  if (record.type === 'content') return formatToolResult(record.content);
  return safeJson(record);
}

/**
 * Display text for a tool result. The runtime still sees the original image;
 * this copy feeds paboot's event log / SSE / history, so image bytes are
 * replaced by a short marker instead of being persisted as base64.
 */
export function formatToolResult(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(blockText).filter((part) => part !== '').join('\n');
  }
  const record = asRecord(value);
  if (!record) return String(value);
  if (record.type === 'text') return typeof record.text === 'string' ? record.text : '';
  if (record.type === 'image') return imageMarker(record);
  if (Array.isArray(record.content)) {
    const parts = record.content.map(blockText).filter((part) => part !== '');
    if (record.structuredContent !== undefined) parts.push(safeJson(record.structuredContent));
    if (parts.length > 0) return parts.join('\n');
  }
  return safeJson(record);
}
