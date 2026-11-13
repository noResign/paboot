/**
 * Whether this device has already entered the standalone personal-space welcome.
 * Stored per daemon identity so reconnecting to a different host shows its own
 * first-run welcome, while reopening the same daemon goes straight to the shell.
 */
const PREFIX = 'paboot.personalWelcome.';

export function readPersonalWelcomeDone(identity: string | null): boolean {
  if (!identity) return false;
  try {
    return localStorage.getItem(PREFIX + identity) === '1';
  } catch {
    return false;
  }
}

export function writePersonalWelcomeDone(identity: string | null): void {
  if (!identity) return;
  try {
    localStorage.setItem(PREFIX + identity, '1');
  } catch {
    // Storage disabled/full: this run still remembers the choice in React state.
  }
}
