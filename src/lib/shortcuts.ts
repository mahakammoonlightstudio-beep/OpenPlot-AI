/**
 * Keyboard shortcuts — the single source of truth (v1.2.3 Task 9).
 *
 * The global handler, the sheet, the guide article and the native menu labels
 * all read this list. Adding a shortcut anywhere else means the docs lie, so
 * the handler below is generated from it rather than hand-written.
 */

export interface ShortcutSpec {
  id: string;
  /** Modifier+key combos; the first one is the primary binding. */
  keys: string[];
  labelKey: string;
  group: 'global' | 'composer' | 'chat';
  /** Route the action belongs to; the handler still runs it everywhere unless noted. */
  scope?: 'chat-only';
}

export const SHORTCUTS: ShortcutSpec[] = [
  { id: 'palette', keys: ['Ctrl+K'], labelKey: 'shortcut.palette', group: 'global' },
  { id: 'new-chat', keys: ['Ctrl+N'], labelKey: 'shortcut.newChat', group: 'global' },
  { id: 'new-project', keys: ['Ctrl+Shift+N'], labelKey: 'shortcut.newProject', group: 'global' },
  { id: 'search', keys: ['Ctrl+F'], labelKey: 'shortcut.search', group: 'global' },
  { id: 'settings', keys: ['Ctrl+,'], labelKey: 'shortcut.settings', group: 'global' },
  { id: 'prompts', keys: ['Ctrl+/'], labelKey: 'shortcut.prompts', group: 'global' },
  { id: 'guide', keys: ['F1'], labelKey: 'shortcut.guide', group: 'global' },
  { id: 'shortcuts', keys: ['Ctrl+Shift+/'], labelKey: 'shortcut.shortcuts', group: 'global' },
  { id: 'sidebar', keys: ['Ctrl+B'], labelKey: 'shortcut.sidebar', group: 'global' },
  { id: 'send', keys: ['Enter'], labelKey: 'shortcut.send', group: 'composer' },
  { id: 'newline', keys: ['Shift+Enter'], labelKey: 'shortcut.newline', group: 'composer' },
  { id: 'send-hard', keys: ['Ctrl+Enter'], labelKey: 'shortcut.sendHard', group: 'composer' },
  { id: 'regen', keys: ['Ctrl+Shift+R'], labelKey: 'shortcut.regen', group: 'chat', scope: 'chat-only' },
  { id: 'copy-last', keys: ['Ctrl+Shift+C'], labelKey: 'shortcut.copyLast', group: 'chat', scope: 'chat-only' }
];

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** Display form for the current OS: `Ctrl+Shift+K` or `Cmd+Shift+K`. */
export function formatCombo(combo: string): string {
  if (!isMac) return combo;
  return combo.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option');
}

/**
 * Does a keyboard event match a combo string? `Ctrl` also accepts `Meta` on
 * macOS so the registry stays one list rather than two.
 */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1].toLowerCase();
  const wantCtrl = parts.includes('Ctrl');
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.includes('Alt');
  const ctrl = isMac ? (e.ctrlKey || e.metaKey) : e.ctrlKey;
  if (ctrl !== wantCtrl) return false;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey !== wantAlt) return false;
  const pressed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return pressed.toLowerCase() === key;
}

export function shortcutById(id: string): ShortcutSpec | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Combos that must not fire while the user is typing in a field. */
export const TYPING_SAFE = new Set(['guide', 'shortcuts', 'palette', 'settings']);
