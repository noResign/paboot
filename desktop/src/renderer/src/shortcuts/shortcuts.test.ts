import { describe, expect, it } from 'vitest';
import { comboLabel, comboMatches, formatCombo, matchShortcut, SHORTCUTS, type ComboMatchInput } from './shortcuts';

function key(over: Partial<ComboMatchInput> & { key: string }): ComboMatchInput {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe('comboMatches', () => {
  it('treats mod as meta or ctrl', () => {
    expect(comboMatches(key({ key: 'k', metaKey: true }), 'mod+k')).toBe(true);
    expect(comboMatches(key({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(true);
    expect(comboMatches(key({ key: 'k' }), 'mod+k')).toBe(false);
  });

  it('accepts the shifted spelling of a punctuation key', () => {
    // ⌘⇧] reports "}" — matching the literal "]" would silently never fire.
    expect(comboMatches(key({ key: '}', metaKey: true, shiftKey: true }), 'mod+shift+]')).toBe(true);
    expect(comboMatches(key({ key: '{', ctrlKey: true, shiftKey: true }), 'mod+shift+[')).toBe(true);
  });

  it('requires the modifiers the combo names', () => {
    expect(comboMatches(key({ key: ']', metaKey: true }), 'mod+shift+]')).toBe(false);
    expect(comboMatches(key({ key: 'n', metaKey: true, shiftKey: true }), 'mod+n')).toBe(true);
  });
});

describe('matchShortcut', () => {
  it('maps every combo in the table back to its id', () => {
    // The table is the single source of truth: a typo in a combo shows up here.
    const k = SHORTCUTS.find((s) => s.id === 'command-palette');
    expect(k?.combo).toBe('mod+k');
    expect(matchShortcut(key({ key: 'k', ctrlKey: true }))?.id).toBe('command-palette');
  });

  it('maps the activity-bar destinations', () => {
    expect(matchShortcut(key({ key: '1', metaKey: true }))?.id).toBe('go-sessions');
    expect(matchShortcut(key({ key: '2', metaKey: true }))?.id).toBe('go-tasks');
    expect(matchShortcut(key({ key: ',', metaKey: true }))?.id).toBe('go-settings');
  });

  it('returns null for an unbound key', () => {
    expect(matchShortcut(key({ key: 'q', metaKey: true }))).toBeNull();
  });

  it('fires the bare "?" without any modifier', () => {
    expect(matchShortcut(key({ key: '?', shiftKey: true }))?.id).toBe('help');
    expect(matchShortcut(key({ key: '?', metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('binds Escape to back', () => {
    // The event key is "Escape", the combo is spelled "escape" — the table is
    // only correct if matching is case-insensitive.
    expect(matchShortcut(key({ key: 'Escape' }))?.id).toBe('back');
    expect(matchShortcut(key({ key: 'Escape', metaKey: true }))).toBeNull();
  });
});

describe('formatCombo', () => {
  it('renders per platform', () => {
    expect(formatCombo('mod+k', true)).toBe('⌘K');
    expect(formatCombo('mod+k', false)).toBe('Ctrl+K');
    expect(formatCombo('mod+shift+]', true)).toBe('⌘⇧]');
  });

  it('spells named keys instead of uppercasing them', () => {
    expect(formatCombo('escape', true)).toBe('Esc');
  });
});

describe('comboLabel', () => {
  it('resolves a shortcut id through the shared table, per platform', () => {
    expect(comboLabel('command-palette', true)).toBe('⌘K');
    expect(comboLabel('command-palette', false)).toBe('Ctrl+K');
    expect(comboLabel('nope', true)).toBe('');
  });
});
