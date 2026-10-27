import os from 'node:os';

/**
 * Non-loopback IPv4 addresses of this machine, used to print "connect from
 * another device via http://<ip>:<port>" hints at startup.
 */
export function listLocalAddresses(): string[] {
  const addrs = new Set<string>();
  const all = Object.values(os.networkInterfaces()) as Array<os.NetworkInterfaceInfo[] | undefined>;
  for (const ifaces of all) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        addrs.add(iface.address);
      }
    }
  }
  return [...addrs];
}
