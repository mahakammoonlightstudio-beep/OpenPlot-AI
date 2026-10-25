/**
 * Remembers where the user was before the window reloaded (Ctrl+R, a crash
 * recovery, or a manual restart). Without this the app always booted into an
 * empty "new chat" screen — so reloading to pick up a newly created story
 * entry silently threw away the Story Bible / chapter the user was reading.
 *
 * Only the position is stored here (localStorage), never content. The store
 * validates the ids against the database after loading, so a deleted chat or
 * project simply falls back to the previous default instead of pointing at a
 * ghost row.
 */
export const UI_ROUTES = [
  'chat',
  'agent',
  'story',
  'chapters',
  'flow',
  'projects',
  'stats',
  'settings',
  'settings-plugins',
  'settings-appearance',
  'about'
] as const;

export interface UiPosition {
  route: string;
  activeChatId: string | null;
  activeProjectId: string | null;
}

const POSITION_KEY = 'openplot.position.v1';

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function readPosition(): UiPosition {
  const fallback: UiPosition = { route: 'chat', activeChatId: null, activeProjectId: null };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      route: typeof parsed.route === 'string' && (UI_ROUTES as readonly string[]).includes(parsed.route)
        ? parsed.route
        : 'chat',
      activeChatId: idOrNull(parsed.activeChatId),
      activeProjectId: idOrNull(parsed.activeProjectId)
    };
  } catch {
    return fallback;
  }
}

export function writePosition(position: UiPosition): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  } catch {
    /* storage full/unavailable — restoring a position is a convenience */
  }
}
