export const MIN_SNAPSHOT_MAX_BYTES = 4096;

export interface EncodedSnapshotPayload {
  payload: string;
  bytes: number;
  truncated: boolean;
  truncations: string[];
}

interface StringLeaf {
  path: (string | number)[];
  bytes: number;
}

/**
 * Serialize a snapshot and keep it under `maxBytes`. When over the cap the
 * largest string leaves are halved (head + tail + marker) until it fits; if
 * that is not enough a small structural summary replaces the payload. The
 * result is always valid JSON and never larger than the cap.
 */
export function encodeSnapshotPayload(value: unknown, maxBytes: number): EncodedSnapshotPayload {
  const cap = Math.max(MIN_SNAPSHOT_MAX_BYTES, Math.floor(maxBytes));
  const initial = serialize(value);
  const initialBytes = Buffer.byteLength(initial, 'utf8');
  if (initialBytes <= cap) {
    return { payload: initial, bytes: initialBytes, truncated: false, truncations: [] };
  }

  let copy: unknown;
  try {
    copy = JSON.parse(initial) as unknown;
  } catch {
    copy = value;
  }

  const truncations: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const leaves = collectStringLeaves(copy).sort((a, b) => b.bytes - a.bytes);
    const largest = leaves[0];
    if (!largest || largest.bytes < 128) break;
    const current = getAtPath(copy, largest.path);
    if (typeof current !== 'string') break;
    setAtPath(copy, largest.path, truncateString(current));
    const label = formatPath(largest.path);
    if (!truncations.includes(label)) truncations.push(label);
    const text = serialize(copy);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= cap) return { payload: text, bytes, truncated: true, truncations };
  }

  const summary = {
    __truncated: true,
    reason: `snapshot exceeded ${cap} bytes`,
    originalBytes: initialBytes,
    shape: shapeOf(value),
  };
  const summaryText = serialize(summary);
  const summaryBytes = Buffer.byteLength(summaryText, 'utf8');
  if (summaryBytes <= cap) {
    return { payload: summaryText, bytes: summaryBytes, truncated: true, truncations: ['payload'] };
  }
  const tiny = serialize({ __truncated: true, originalBytes: initialBytes });
  return {
    payload: tiny,
    bytes: Buffer.byteLength(tiny, 'utf8'),
    truncated: true,
    truncations: ['payload'],
  };
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ __truncated: true, reason: 'unserializable payload' });
  }
}

function truncateString(value: string): string {
  const chars = Array.from(value);
  // Keep a quarter from each end, so every pass roughly halves the string.
  const keep = Math.max(32, Math.floor(chars.length / 4));
  const omitted = Math.max(0, chars.length - keep * 2);
  return `${chars.slice(0, keep).join('')}\n…[truncated ${omitted} chars]…\n${chars
    .slice(chars.length - keep)
    .join('')}`;
}

function collectStringLeaves(value: unknown, path: (string | number)[] = [], out: StringLeaf[] = []): StringLeaf[] {
  if (typeof value === 'string') {
    out.push({ path: [...path], bytes: Buffer.byteLength(value, 'utf8') });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringLeaves(item, [...path, index], out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectStringLeaves(item, [...path, key], out);
  }
  return out;
}

function getAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function setAtPath(root: unknown, path: readonly (string | number)[], value: unknown): void {
  if (path.length === 0) return;
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (current === null || typeof current !== 'object') return;
    current = (current as Record<string | number, unknown>)[path[i]!];
  }
  if (current === null || typeof current !== 'object') return;
  (current as Record<string | number, unknown>)[path[path.length - 1]!] = value;
}

function formatPath(path: readonly (string | number)[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? key : `.${key}`;
  }
  return out;
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…';
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, first: value.length > 0 ? shapeOf(value[0], depth + 1) : null };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') out[key] = { type: 'string', bytes: Buffer.byteLength(item, 'utf8') };
      else if (typeof item === 'object') out[key] = shapeOf(item, depth + 1);
      else out[key] = item;
    }
    return out;
  }
  return typeof value;
}
