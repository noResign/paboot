import { describe, expect, it } from 'vitest';
import { displayHost, maskAddress } from './net';

describe('maskAddress', () => {
  it('keeps only the first octet and hides the port', () => {
    expect(maskAddress('192.168.1.5')).toBe('192.*.*.*');
    expect(maskAddress('http://192.168.1.5:4780')).toBe('http://192.*.*.*:****');
  });

  it('masks IPv6 after the first group and its port', () => {
    expect(maskAddress('http://[fe80::1]:4780')).toBe('http://[fe80:…]:****');
  });

  it('leaves readable hostnames alone', () => {
    expect(maskAddress('http://mac-mini.local:4780')).toBe('http://mac-mini.local:4780');
  });
});

describe('displayHost', () => {
  it('prefers a user-provided name', () => {
    expect(displayHost('家里的 Mac', '192.168.1.5')).toBe('家里的 Mac');
  });

  it('falls back to a masked address, never the full IP', () => {
    expect(displayHost(null, '192.168.1.5')).toBe('192.*.*.*');
    expect(displayHost('  ', '192.168.1.5')).toBe('192.*.*.*');
  });
});
