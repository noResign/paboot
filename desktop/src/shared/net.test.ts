import { describe, expect, it } from 'vitest';
import { displayHost } from './net';

describe('displayHost', () => {
  it('prefers a user-provided name', () => {
    expect(displayHost('家里的 Mac', '192.168.1.5')).toBe('家里的 Mac');
  });

  it('falls back to the address when there is no name', () => {
    expect(displayHost(null, '192.168.1.5')).toBe('192.168.1.5');
    expect(displayHost('  ', '192.168.1.5')).toBe('192.168.1.5');
  });

  it('handles a missing host too', () => {
    expect(displayHost(null, null)).toBe('未命名主机');
  });
});
