/**
 * Shared request parsing for image attachments.
 *
 * Chat and room turns admit the same uploads, so the wire shape and limits must
 * not drift apart. A malformed list is a client error; ownership and capability
 * checks stay with the route because they need the request's session/context.
 */
export const MAX_ATTACHMENTS = 8;

/** Returns null when the field is present but malformed. */
export function normalizeAttachmentIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    const id = item.trim();
    if (ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}
