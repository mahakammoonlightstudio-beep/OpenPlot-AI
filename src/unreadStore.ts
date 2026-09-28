import { create } from 'zustand';

/**
 * Unread tracking: counts *new assistant replies* that arrived in background
 * chats (anything sent to `markUnread` while the chat was not active).
 * Clearing happens when the user opens the chat. Last-read timestamps are
 * persisted so badges survive an app restart.
 */

const LAST_READ_KEY = 'openplot.lastRead.v1';

function loadLastRead(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch {
    return {};
  }
}

function saveLastRead(map: Record<string, number>) {
  try { localStorage.setItem(LAST_READ_KEY, JSON.stringify(map)); } catch { /* non-fatal */ }
}

interface UnreadState {
  unread: Record<string, number>;
  lastRead: Record<string, number>;
  /** Record a new assistant reply; ignored for the currently open chat. */
  markReply(chatId: string, activeChatId: string | null): void;
  /** Opening a chat clears its badge and stamps last-read. */
  markRead(chatId: string): void;
  /** Remove tracking for deleted chats. */
  forget(chatId: string): void;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  unread: {},
  lastRead: loadLastRead(),

  markReply(chatId, activeChatId) {
    if (chatId === activeChatId) return; // user is watching — nothing to badge
    set((s) => ({ unread: { ...s.unread, [chatId]: (s.unread[chatId] || 0) + 1 } }));
  },

  markRead(chatId) {
    const stamped = { ...get().lastRead, [chatId]: Date.now() };
    saveLastRead(stamped);
    set((s) => {
      if (!s.unread[chatId]) return { lastRead: stamped };
      const unread = { ...s.unread };
      delete unread[chatId];
      return { unread, lastRead: stamped };
    });
  },

  forget(chatId) {
    set((s) => {
      const unread = { ...s.unread };
      delete unread[chatId];
      const lastRead = { ...s.lastRead };
      delete lastRead[chatId];
      saveLastRead(lastRead);
      return { unread, lastRead };
    });
  }
}));
