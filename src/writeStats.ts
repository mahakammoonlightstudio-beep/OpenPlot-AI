import { create } from 'zustand';

// Local writing statistics — no AI involved. Deltas are recorded whenever a
// chapter is saved; today's positive delta is also folded into the heatmap so
// the current session is visible before the first save-of-the-day completes.
// All state persists to localStorage (openplot.writeStats.v1).

export interface DayStat {
  delta: number;   // words added that day (can be negative after deletes)
  total: number;   // cumulative project words at end of that day
}

export interface ProjectStat {
  words: number;          // latest known word count
  title: string;
  goal: number;           // 0 = no goal
  stakes: Record<string, number>; // chapterId -> 1..10 (story arc)
}

interface WriteStatsState {
  days: Record<string, DayStat>;        // 'YYYY-MM-DD' -> stat
  projects: Record<string, ProjectStat>;
  // Per-project day deltas — powers the per-project streak in Stats.
  projectDays: Record<string, Record<string, number>>; // projectId -> dayKey -> delta
  todayKey: string;
  recordDelta(projectId: string, projectTitle: string, delta: number, totalWords: number): void;
  getGoal(projectId: string): number;
  setGoal(projectId: string, goal: number): void;
  recordStakes(projectId: string, chapterId: string, level: number): void;
  clearStakes(projectId: string): void;
}

const KEY = 'openplot.writeStats.v1';
const MAX_DAYS = 400;

export function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadPersisted(): Pick<WriteStatsState, 'days' | 'projects' | 'projectDays'> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { days: parsed.days || {}, projects: parsed.projects || {}, projectDays: parsed.projectDays || {} };
    }
  } catch { /* corrupted state — start fresh */ }
  return { days: {}, projects: {}, projectDays: {} };
}

function persist(s: WriteStatsState): void {
  try {
    // keep only the most recent MAX_DAYS entries
    const keys = Object.keys(s.days).sort();
    const trimmed: Record<string, DayStat> = {};
    for (const k of keys.slice(-MAX_DAYS)) trimmed[k] = s.days[k];
    // Trim per-project day maps with the same window.
    const keep = new Set(keys.slice(-MAX_DAYS));
    const trimmedProjectDays: Record<string, Record<string, number>> = {};
    for (const [pid, dayMap] of Object.entries(s.projectDays || {})) {
      const m: Record<string, number> = {};
      for (const k of Object.keys(dayMap)) if (keep.has(k)) m[k] = dayMap[k];
      if (Object.keys(m).length) trimmedProjectDays[pid] = m;
    }
    localStorage.setItem(KEY, JSON.stringify({ days: trimmed, projects: s.projects, projectDays: trimmedProjectDays }));
  } catch { /* storage full — stats stay in memory */ }
}

export const useWriteStats = create<WriteStatsState>((set, get) => ({
  ...loadPersisted(),
  projectDays: {},
  todayKey: dayKey(),
  recordDelta(projectId, projectTitle, delta, totalWords) {
    const key = dayKey();
    set((s) => {
      const days = { ...s.days };
      const prev = days[key] || { delta: 0, total: 0 };
      days[key] = { delta: prev.delta + delta, total: totalWords || prev.total };
      const pd = { ...(s.projectDays || {}) };
      pd[projectId] = { ...(pd[projectId] || {}) };
      pd[projectId][key] = (pd[projectId][key] || 0) + delta;
      const old = s.projects[projectId] || { words: 0, title: projectTitle, goal: 0, stakes: {} };
      const projects = {
        ...s.projects,
        [projectId]: { ...old, words: totalWords, title: projectTitle }
      };
      const next = { ...s, days, projects, projectDays: pd, todayKey: key };
      persist(next);
      return next;
    });
  },
  getGoal(projectId) {
    return get().projects[projectId]?.goal || 0;
  },
  setGoal(projectId, goal) {
    set((s) => {
      const old = s.projects[projectId] || { words: 0, title: '', goal: 0, stakes: {} };
      const projects = { ...s.projects, [projectId]: { ...old, goal: Math.max(0, Math.round(goal)) } };
      const next = { ...s, projects };
      persist(next);
      return next;
    });
  },
  recordStakes(projectId, chapterId, level) {
    set((s) => {
      const old = s.projects[projectId] || { words: 0, title: '', goal: 0, stakes: {} };
      const stakes = { ...old.stakes };
      if (level >= 1 && level <= 10) stakes[chapterId] = level;
      else delete stakes[chapterId];
      const projects = { ...s.projects, [projectId]: { ...old, stakes } };
      const next = { ...s, projects };
      persist(next);
      return next;
    });
  },
  clearStakes(projectId) {
    set((s) => {
      const old = s.projects[projectId];
      if (!old) return s;
      const projects = { ...s.projects, [projectId]: { ...old, stakes: {} } };
      const next = { ...s, projects };
      persist(next);
      return next;
    });
  }
}));

// ---------- selectors / helpers ----------

// Streak of consecutive writing days for ONE project's day-delta map
// (same rules as statsSummary: today counts if positive, otherwise the
// streak stays alive from yesterday until midnight).
export function projectStreak(dayMap: Record<string, number> | undefined): number {
  if (!dayMap) return 0;
  const key = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  let streak = 0;
  if ((dayMap[key] ?? 0) > 0) streak = 1;
  else if (!((dayMap[yesterday] ?? 0) > 0)) return 0;
  for (let i = 1; i < 365; i++) {
    const k = dayKey(new Date(Date.now() - i * 86400000));
    if ((dayMap[k] ?? 0) > 0) streak++;
    else break;
  }
  return streak;
}

export function statsSummary(days: Record<string, DayStat>) {
  const key = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const weekKeys = Array.from({ length: 7 }, (_, i) => dayKey(new Date(Date.now() - i * 86400000)));
  const today = days[key]?.delta ?? 0;
  const thisWeek = weekKeys.reduce((a, k) => a + (days[k]?.delta ?? 0), 0);
  const allDeltas = Object.entries(days);
  const best = allDeltas.reduce<{ key: string; delta: number }>((acc, [k, v]) =>
    v.delta > acc.delta ? { key: k, delta: v.delta } : acc, { key: '', delta: 0 });
  let streak = 0;
  if ((days[key]?.delta ?? 0) > 0) {
    streak = 1;
    for (let i = 1; i < 365; i++) {
      const k = dayKey(new Date(Date.now() - i * 86400000));
      if ((days[k]?.delta ?? 0) > 0) streak++;
      else break;
    }
  } else if ((days[yesterday]?.delta ?? 0) > 0) {
    // streak alive until the end of today — count from yesterday backwards
    streak = 0;
    for (let i = 1; i < 365; i++) {
      const k = dayKey(new Date(Date.now() - i * 86400000));
      if ((days[k]?.delta ?? 0) > 0) streak++;
      else break;
    }
  }
  return { today, thisWeek, best, streak };
}
