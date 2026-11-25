import os from 'node:os';

type NetworkFamily = string | number;

/** Container/bridge interfaces are dialable only from this host. */
const CONTAINER_IFACE = /^(docker|br-|veth|virbr|vmnet)/i;

export interface NetworkAddress {
  address: string;
  family: NetworkFamily;
  internal: boolean;
}

/**
 * Which host to put in an invite link.
 *
 * The daemon is normally reached at `127.0.0.1` by its own desktop, so the
 * request's Host header says nothing about how *another* machine can reach it.
 * When that header (and the configured bind host) is loopback/wildcard, fall
 * back to a real interface address. The picker prefers a private LAN address,
 * then Tailscale's CGNAT range, then any other IPv4.
 */
export function pickAdvertisedHost(input: {
  hostHeader: string;
  configuredHost: string;
  interfaces: NodeJS.Dict<NetworkAddress[]>;
}): string | null {
  for (const candidate of [input.hostHeader, input.configuredHost]) {
    const host = normalize(candidate);
    if (host && !isLoopback(host) && !isWildcard(host)) return host;
  }

  const addresses = Object.entries(input.interfaces)
    .filter(([name]) => !CONTAINER_IFACE.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address);

  // 192.168 > 10 > 172.16/12: container bridges usually sit in 172.16/12, so
  // this avoids handing out docker0 when the Wi-Fi address is also private.
  const privateV4 = addresses
    .filter((address) => familyOf(address) === 4 && isPrivateV4(address))
    .sort((left, right) => privateRank(left) - privateRank(right))[0];
  if (privateV4) return privateV4;
  const tailscale = addresses.find((address) => familyOf(address) === 4 && isCgnat(address));
  if (tailscale) return tailscale;
  const otherV4 = addresses.find((address) => familyOf(address) === 4);
  if (otherV4) return otherV4;
  return addresses.find((address) => address.includes(':')) ?? null;
}

export function loopbackInviteHost(): string {
  return '127.0.0.1';
}

function normalize(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, '');
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

function familyOf(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4;
}

function octets(address: string): number[] {
  return address.split('.').map((part) => Number(part));
}

function isPrivateV4(address: string): boolean {
  const [a, b] = octets(address);
  if (a === undefined || b === undefined) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function privateRank(address: string): number {
  const [a] = octets(address);
  if (a === 192) return 0;
  if (a === 10) return 1;
  return 2;
}

/** Tailscale assigns 100.64.0.0/10 (CGNAT). */
function isCgnat(address: string): boolean {
  const [a, b] = octets(address);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}
