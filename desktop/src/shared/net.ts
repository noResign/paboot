/** Loopback hosts never leave the machine, so a plain-http token is not exposed. */
export function isLoopback(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === '127.0.0.1' || bare === '::1' || bare === 'localhost';
}

/** True when a token would cross the network in cleartext. */
export function isInsecure(host: string, tls: boolean): boolean {
  return !tls && !isLoopback(host);
}

/**
 * Keep only the first octet of an IPv4 and hide its port as well:
 * `192.168.1.5:4780` → `192.*.*.*:****`. Hostnames pass through untouched.
 */
export function maskAddress(value: string): string {
  return value
    .replace(/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\b/g, '$1.*.*.*:****')
    .replace(/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '$1.*.*.*')
    .replace(/\[([0-9a-fA-F]+):[0-9a-fA-F:]+\]:\d{1,5}/g, '[$1:…]:****')
    .replace(/\[([0-9a-fA-F]+):[0-9a-fA-F:]+\]/g, '[$1:…]');
}

/** Prefer the user's name; fall back to a masked address, never a full IP. */
export function displayHost(
  name: string | null | undefined,
  host: string | null | undefined,
): string {
  const trimmed = name?.trim();
  if (trimmed) return maskAddress(trimmed);
  if (host) return maskAddress(host);
  return '未命名主机';
}
