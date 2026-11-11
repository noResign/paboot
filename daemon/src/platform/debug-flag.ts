/**
 * [debug] Global debug switch.
 *
 * Lives in `platform/` on purpose: it is the lowest layer, so any module
 * (db, http, runtimes, domains) may import it without breaking layering.
 * The state is set by `DebugRecorder` (and `loadConfig` feeds it the mode).
 *
 * Two levels:
 * - `isDebugEnabled()`: the master switch is not `off` (`PABOOT_DEBUG=auto|on`).
 * - `isDebugLive()`: capture is active right now. In `auto` mode this is true
 *   only while at least one `/debug` client is connected; `on` is always true.
 *
 * Use `isDebugLive()` for expensive or noisy logic that should only run while
 * someone is actually watching. Use `isDebugEnabled()` when the logic is cheap
 * and should run whenever debugging is allowed.
 */

export type DebugMode = 'off' | 'on' | 'auto';

let mode: DebugMode = 'off';
let live = false;

export function setDebugMode(next: DebugMode): void {
  mode = next;
}

export function getDebugMode(): DebugMode {
  return mode;
}

/** Auto mode: the recorder flips this as debug clients connect/disconnect. */
export function setDebugLive(next: boolean): void {
  live = next;
}

export function isDebugEnabled(): boolean {
  return mode !== 'off';
}

export function isDebugLive(): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return live;
}

/** Test helper: restore the default (disabled) state. */
export function resetDebugFlag(): void {
  mode = 'off';
  live = false;
}
