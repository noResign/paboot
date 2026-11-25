import { describe, expect, it } from 'vitest';
import { pickAdvertisedHost } from '../src/peer';

const lo = [{ address: '127.0.0.1', family: 4, internal: true }];

describe('invite host selection', () => {
  it('keeps a real host from the request or config', () => {
    expect(
      pickAdvertisedHost({
        hostHeader: '192.168.1.20',
        configuredHost: '0.0.0.0',
        interfaces: { eth0: [{ address: '192.168.1.20', family: 4, internal: false }] },
      }),
    ).toBe('192.168.1.20');
    expect(
      pickAdvertisedHost({
        hostHeader: '',
        configuredHost: '10.0.0.9',
        interfaces: {},
      }),
    ).toBe('10.0.0.9');
  });

  it('replaces loopback/wildcard with a LAN address', () => {
    expect(
      pickAdvertisedHost({
        hostHeader: '127.0.0.1',
        configuredHost: '0.0.0.0',
        interfaces: {
          lo,
          eth0: [
            { address: 'fe80::1', family: 6, internal: false },
            { address: '192.168.1.5', family: 4, internal: false },
          ],
        },
      }),
    ).toBe('192.168.1.5');
  });

  it('prefers a private address over other public IPv4s', () => {
    expect(
      pickAdvertisedHost({
        hostHeader: 'localhost',
        configuredHost: '::',
        interfaces: {
          eth0: [
            { address: '8.8.8.8', family: 4, internal: false },
            { address: '172.20.0.4', family: 4, internal: false },
          ],
        },
      }),
    ).toBe('172.20.0.4');
  });

  it('ignores container bridges in favour of the real LAN address', () => {
    expect(
      pickAdvertisedHost({
        hostHeader: '127.0.0.1',
        configuredHost: '0.0.0.0',
        interfaces: {
          lo,
          docker0: [{ address: '172.17.0.1', family: 4, internal: false }],
          eth0: [{ address: '10.1.2.3', family: 4, internal: false }],
        },
      }),
    ).toBe('10.1.2.3');
  });

  it('uses Tailscale when it is the only usable address', () => {
    expect(
      pickAdvertisedHost({
        hostHeader: '::1',
        configuredHost: '',
        interfaces: { tailscale0: [{ address: '100.101.1.2', family: 4, internal: false }] },
      }),
    ).toBe('100.101.1.2');
  });

  it('returns null when nothing is dialable', () => {
    expect(
      pickAdvertisedHost({ hostHeader: '127.0.0.1', configuredHost: '0.0.0.0', interfaces: { lo } }),
    ).toBeNull();
  });
});
