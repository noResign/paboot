import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTodoDismissal, writeTodoDismissal } from './todoDismissal';

/**
 * The dismissal has to outlive the process: the whole complaint was that a
 * half-finished todo list reappeared every time the user came back.
 *
 * A tiny in-memory stand-in is enough — what is worth pinning down is the key
 * (session id) and the clear/no-op edges, not the browser's storage.
 */
class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new FakeStorage(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('todo dismissal persistence', () => {
  it('remembers what was put away, per session', () => {
    writeTodoDismissal('s1', '读代码\n改实现');
    expect(readTodoDismissal('s1')).toBe('读代码\n改实现');
    // A different conversation is unaffected.
    expect(readTodoDismissal('s2')).toBeNull();
  });

  it('never let a null session read someone else\'s entry', () => {
    writeTodoDismissal('s1', '读代码');
    expect(readTodoDismissal(null)).toBeNull();
    // …and writing without a session is a no-op, not an error.
    writeTodoDismissal(null, '随便');
    expect((globalThis.localStorage as unknown as FakeStorage).size).toBe(1);
  });

  it('forgets on null, so a rewritten list can show again', () => {
    writeTodoDismissal('s1', '旧清单');
    writeTodoDismissal('s1', null);
    expect(readTodoDismissal('s1')).toBeNull();
  });

  it('survives storage being unavailable instead of throwing', () => {
    // Private mode / storage disabled: the in-memory dismissal still works for
    // the current run, and nothing here may break rendering.
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
        removeItem() {
          throw new Error('denied');
        },
      },
      configurable: true,
      writable: true,
    });
    expect(() => writeTodoDismissal('s1', 'x')).not.toThrow();
    expect(readTodoDismissal('s1')).toBeNull();
  });
});
