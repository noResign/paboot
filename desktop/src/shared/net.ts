/** Loopback hosts never leave the machine, so a plain-http token is not exposed. */
export function isLoopback(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === '127.0.0.1' || bare === '::1' || bare === 'localhost';
}

/** True when a token would cross the network in cleartext. */
export function isInsecure(host: string, tls: boolean): boolean {
  return !tls && !isLoopback(host);
}

/** Prefer the user-provided name; fall back to the address only when there is none. */
export function displayHost(
  name: string | null | undefined,
  host: string | null | undefined,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (host) return host;
  return '未命名主机';
}
