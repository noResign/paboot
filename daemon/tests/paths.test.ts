import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from '../src/paths';

describe('expandHome', () => {
  it('leaves absolute and plain relative paths alone', () => {
    expect(expandHome('/a/b')).toBe('/a/b');
    expect(expandHome('relative/x')).toBe('relative/x');
  });

  it('does not expand a tilde that is not leading, or ~user', () => {
    expect(expandHome('/a/~/b')).toBe('/a/~/b');
    expect(expandHome('~user/x')).toBe('~user/x');
  });

  it('expands a bare ~ to the home dir', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('expands ~/ to the home dir', () => {
    expect(expandHome('~/proj')).toBe(path.join(os.homedir(), 'proj'));
    expect(expandHome('~/')).toBe(os.homedir());
  });
});
