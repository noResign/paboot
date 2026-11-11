import type { DaemonRequest } from '../../shared/ipc';

/**
 * The renderer may only reach relative `/api/...` paths. Anything else — an
 * absolute URL, a `..` traversal, a protocol-relative path — is a bug or an
 * exploit, never a legitimate request, so it is rejected rather than normalized.
 */
export function isAllowedPath(path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('..')) return false;
  if (/[\s\\]/.test(path)) return false;
  return true;
}

/** Only these methods exist in the daemon's CORS allowlist; keep them in sync. */
const ALLOWED_METHODS = new Set<DaemonRequest['method']>(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

export function isAllowedMethod(method: string): method is DaemonRequest['method'] {
  return ALLOWED_METHODS.has(method as DaemonRequest['method']);
}
