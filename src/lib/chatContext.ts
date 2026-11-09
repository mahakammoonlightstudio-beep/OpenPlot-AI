/**
 * Chat view helpers (pure): token estimates, compact labels and the context
 * guard constants. Extracted from ChatView so the transcript can be reasoned
 * about — and tested — without mounting the whole view.
 */
import type { Message } from '../types';

export function clampNum(v: number, min: number, max: number, fb: number): number {
  if (!Number.isFinite(v)) return fb;
  return Math.min(max, Math.max(min, v));
}

export const contentWordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;

/** One file/story/chapter attached to the NEXT message (card, not inline text). */
export interface Attachment { id: string; name: string; kind: 'file' | 'story' | 'chapter'; content: string; bytes?: number }

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** Compact relative timestamp for a message meta row ('' when unknown). */
export function relativeTime(ts: number | undefined, t: (k: string) => string): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 45_000) return t('time.now');
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return t('time.min').replace('{n}', String(mins));
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('time.hour').replace('{n}', String(hours));
  const days = Math.round(hours / 24);
  if (days < 7) return t('time.day').replace('{n}', String(days));
  try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
}

/** Compact "in→out" token label for a message meta row ('' when unknown). */
export function tokenLabel(m: Message): string {
  const i = fmtTokens(m.tokens_in);
  const o = fmtTokens(m.tokens_out);
  if (i && o) return `${i}→${o} tok`;
  if (o) return `${o} tok`;
  if (i) return `${i} tok`;
  return '';
}

// ---- context guard ----
// Rough token estimate (~4 chars/token) is good enough for guarding; exact
// tokenization is model-specific and not worth a dependency. When the
// estimated prompt exceeds the model's context window minus the output
// reserve, the OLDEST turns are dropped from the request (never from the DB
// or the transcript) and the user is told once per chat.
export const CHARS_PER_TOKEN = 4;
export const GUARD_SAFETY_TOKENS = 256; // headroom for provider-side counting drift
export const GUARD_MIN_HISTORY = 4; // always keep at least this many newest turns

export function estimateTokens(s: string): number {
  return Math.ceil((s || '').length / CHARS_PER_TOKEN);
}

// ---- conversation versions -----------------------------------------------
// Two INDEPENDENT axes, so an edit never gets mixed into the reply count:
//   * a user message can have several versions (an edit forks a new one), and
//   * each version can have several replies (a restart adds one).
// An edited prompt is a NEW row whose parent is the version it replaced, so
// the old prompt keeps its answers and stays one arrow away.
export interface VersionNav { parentId: string; ids: string[]; index: number }

export interface Transcript {
  visible: Message[];
  /** user version id -> arrows over the prompt versions (parentId = slot). */
  userVersions: Map<string, VersionNav>;
  /** assistant id -> arrows over that answer's restarts (parentId = user id). */
  aiVersions: Map<string, VersionNav>;
  /** slot (the first version of a turn) -> the prompt version on screen. */
  selectedUser: Map<string, string>;
  /** every prompt version id -> the turn it belongs to (its first version). */
  userSlot: Map<string, string>;
}

export function buildTranscript(
  messages: Message[],
  userPick: Record<string, string>,
  variantPick: Record<string, string>,
  streamingTurn: string | null
): Transcript {
  const userIds = new Set(messages.filter((m) => m.role === 'user').map((m) => m.id));
  // User version -> the version it replaced. Only user rows can chain, so an
  // assistant's parent (the turn it answers) is never confused with this.
  const replaced = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const parent = m.parent_id;
    if (parent && parent !== m.id && userIds.has(parent)) replaced.set(m.id, parent);
  }
  const rootOf = (id: string): string => {
    let cur = id;
    for (let guard = 0; replaced.has(cur) && guard < 200; guard++) cur = replaced.get(cur) as string;
    return cur;
  };

  const slots = new Map<string, string[]>();
  const userSlot = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const slot = rootOf(m.id);
    userSlot.set(m.id, slot);
    const list = slots.get(slot);
    if (list) { if (!list.includes(m.id)) list.push(m.id); }
    else slots.set(slot, [m.id]);
  }

  // Replies per prompt version. A row without parent_id falls back to the
  // nearest prompt before it (pre-v1.2.5 rows, imports, plugins).
  const aiGroups = new Map<string, Message[]>();
  const owner = new Map<string, string>();
  let turn: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') { turn = m.id; continue; }
    if (m.role !== 'assistant') continue;
    const parent = m.parent_id && userIds.has(m.parent_id) ? m.parent_id : turn;
    if (!parent) continue;
    owner.set(m.id, parent);
    const list = aiGroups.get(parent);
    if (list) list.push(m); else aiGroups.set(parent, [m]);
  }

  const selectedUser = new Map<string, string>();
  for (const [slot, ids] of slots) {
    selectedUser.set(slot, ids.includes(userPick[slot]) ? userPick[slot] : ids[ids.length - 1]);
  }
  const selectedAi = new Map<string, Message>();
  for (const [uid, list] of aiGroups) {
    selectedAi.set(uid, list.find((m) => m.id === variantPick[uid]) || list[list.length - 1]);
  }

  const userVersions = new Map<string, VersionNav>();
  for (const [slot, ids] of slots) {
    const sel = selectedUser.get(slot);
    if (!sel) continue;
    userVersions.set(sel, { parentId: slot, ids, index: Math.max(0, ids.indexOf(sel)) });
  }
  const aiVersions = new Map<string, VersionNav>();
  for (const [uid, list] of aiGroups) {
    const sel = selectedAi.get(uid);
    if (!sel) continue;
    aiVersions.set(sel.id, {
      parentId: uid,
      ids: list.map((m) => m.id),
      index: Math.max(0, list.findIndex((m) => m.id === sel.id))
    });
  }

  // What the reader sees — and what the model is sent: one prompt version per
  // turn and one reply per version. While a turn is being resent its previous
  // answer is hidden, so the fresh reply appears in place.
  const visible = messages.filter((m) => {
    if (m.role === 'user') return selectedUser.get(rootOf(m.id)) === m.id;
    if (m.role !== 'assistant') return true;
    const uid = owner.get(m.id);
    if (!uid) return true;
    if (selectedUser.get(rootOf(uid)) !== uid) return false;
    if (streamingTurn && streamingTurn === uid) return false;
    return selectedAi.get(uid)?.id === m.id;
  });

  return { visible, userVersions, aiVersions, selectedUser, userSlot };
}
