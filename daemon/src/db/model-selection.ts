/**
 * Normalize a client-supplied model id. An omitted / empty / legacy `'default'`
 * value all mean "no explicit model" — the runtime's own configuration decides.
 */
export function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== 'default' ? trimmed : null;
}

/** A parameters payload must be a plain object or null; arrays/primitives are invalid. */
export function isValidModelParameters(value: unknown): boolean {
  return value === null || (typeof value === 'object' && !Array.isArray(value));
}

/**
 * Keep only string→string entries with non-empty keys and values. Unknown
 * parameter ids are preserved on purpose: the daemon is a transport, and each
 * runtime decides which knobs it understands. The cap keeps a rogue client
 * from stuffing arbitrary state into the session row.
 */
export function normalizeModelParameters(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') continue;
    const key = rawKey.trim();
    const val = rawValue.trim();
    if (key && val) out[key] = val.slice(0, 100);
    if (Object.keys(out).length >= 16) break;
  }
  return Object.keys(out).length ? out : null;
}

export function serializeModelParameters(value: Record<string, string> | null | undefined): string | null {
  const normalized = normalizeModelParameters(value ?? null);
  return normalized ? JSON.stringify(normalized) : null;
}

export function parseStoredModelParameters(value: string | null | undefined): Record<string, string> | null {
  if (!value) return null;
  try {
    return normalizeModelParameters(JSON.parse(value));
  } catch {
    return null;
  }
}
