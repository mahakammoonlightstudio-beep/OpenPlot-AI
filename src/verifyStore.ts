import { create } from 'zustand';
import { Provider } from './types';

/**
 * Shared model health & verification state.
 * - results: one-shot probe results (key `${providerId}::${modelId}`)
 * - history: rolling event log per model for the segmented status bar
 *   (green = success, yellow = degraded/slow, red = failure)
 * - persisted to localStorage so the bar survives restarts
 * - verifyAll runs capped-parallel and can be cancelled mid-sweep
 *
 * Accuracy note: the bar only reflects events seen on this machine
 * (manual verifies + real chat generations). It is a local heuristic,
 * not the provider's official uptime — the UI shows a disclaimer.
 */

export type HealthState = 'ok' | 'degraded' | 'fail';

export interface HealthEvent {
  state: HealthState;
  latencyMs: number;
  at: number;
}

export interface VerifyEntry {
  ok: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: number;
}

const HISTORY_KEY = 'openplot.modelHealth.v1';
const MAX_EVENTS = 40; // segments in the status bar
const DEGRADED_MS = 6000; // slower than this = yellow
const MAX_PARALLEL = 4; // cap for the Verify all sweep (rate-limit safety)

function loadHistory(): Record<string, HealthEvent[]> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistory(history: Record<string, HealthEvent[]>) {
  try {
    // keep storage small: only the last MAX_EVENTS per model
    const trimmed: Record<string, HealthEvent[]> = {};
    for (const [k, events] of Object.entries(history)) {
      trimmed[k] = events.slice(-MAX_EVENTS);
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch { /* storage full/unavailable — non-fatal */ }
}

export function keyOf(providerId: string | undefined, modelId: string): string {
  return `${providerId || '?'}::${modelId}`;
}

interface VerifyState {
  results: Record<string, VerifyEntry>;
  pending: Set<string>;
  history: Record<string, HealthEvent[]>;
  /** True while a Verify-all sweep is running. */
  verifying: boolean;
  verify(provider: Partial<Provider>, model: string): Promise<VerifyEntry>;
  verifyAll(providers: Provider[]): Promise<void>;
  /** Cancel a running sweep: aborts in-flight probes and skips the queue. */
  stopVerifyAll(): void;
  /** Record a real chat generation outcome without an extra probe request. */
  record(providerId: string | undefined, modelId: string, state: HealthState, latencyMs: number): void;
  clear(): void;
}

export const useVerifyStore = create<VerifyState>((set, get) => {
  // ---- sweep internals (module-closure state, not in the store shape) ----
  let sweepRunId = 0;
  let sweepIndex = 0;
  let sweepJobs: Array<() => Promise<unknown>> = [];

  const recordEvent = (key: string, ev: HealthEvent) => {
    set((s) => {
      const history = { ...s.history, [key]: [...(s.history[key] || []), ev].slice(-MAX_EVENTS) };
      saveHistory(history);
      return { history };
    });
  };

  return {
    results: {},
    pending: new Set(),
    history: loadHistory(),
    verifying: false,

    async verify(provider, model) {
      const key = keyOf(provider?.id, model);
      set((s) => ({ pending: new Set(s.pending).add(key) }));
      let entry: VerifyEntry;
      try {
        // reqId routes through the same abort map as chat — stopVerifyAll
        // cancels slow in-flight probes with it.
        const res = await window.inkwell.verifyModel({ ...provider, kind: (provider as any).kind || 'auto' }, model, 'verify-' + key);
        entry = res.ok && res.data
          ? { ok: res.data.ok, latencyMs: res.data.latencyMs, error: res.data.error, checkedAt: Date.now() }
          : { ok: false, latencyMs: 0, error: res.error || 'request failed', checkedAt: Date.now() };
      } catch (err: any) {
        entry = { ok: false, latencyMs: 0, error: err?.message || String(err), checkedAt: Date.now() };
      }
      set((s) => {
        const pending = new Set(s.pending); pending.delete(key);
        const ev: HealthEvent = {
          state: entry.ok ? (entry.latencyMs > DEGRADED_MS ? 'degraded' : 'ok') : 'fail',
          latencyMs: entry.latencyMs,
          at: entry.checkedAt
        };
        const history = { ...s.history, [key]: [...(s.history[key] || []), ev].slice(-MAX_EVENTS) };
        saveHistory(history);
        return { results: { ...s.results, [key]: entry }, pending, history };
      });
      return entry;
    },

    async verifyAll(providers) {
      if (get().verifying) return; // one sweep at a time
      const runId = ++sweepRunId;
      set({ verifying: true });

      // Build the job list (queue) and drain it with MAX_PARALLEL workers so
      // big provider lists don't fire unbounded probes (429 storms that then
      // polluted the health bars with fake "fails").
      sweepJobs = [];
      for (const p of providers) {
        for (const m of (Array.isArray(p.models) ? p.models : [])) {
          sweepJobs.push(() => get().verify(p, m));
        }
      }
      sweepIndex = 0;

      const workers = Array.from({ length: Math.min(MAX_PARALLEL, sweepJobs.length) }, async () => {
        while (sweepIndex < sweepJobs.length) {
          if (runId !== sweepRunId) return; // sweep was cancelled
          const job = sweepJobs[sweepIndex++];
          try { await job(); } catch { /* recorded as a failed check */ }
        }
      });
      await Promise.allSettled(workers);

      if (runId === sweepRunId) set({ verifying: false });
    },

    stopVerifyAll() {
      // Bump the run id: every worker sees a stale id and exits without
      // draining the rest of the queue.
      sweepRunId++;
      // Abort in-flight probes (their results land as cancelled-fails, which
      // is honest: we don't know how they would have turned out).
      for (const k of get().pending) {
        window.inkwell.abort('verify-' + k).catch(() => {});
      }
      set({ verifying: false });
    },

    record(providerId, modelId, state, latencyMs) {
      recordEvent(keyOf(providerId, modelId), { state, latencyMs, at: Date.now() });
    },

    clear() {
      set({ results: {}, pending: new Set(), history: {} });
      saveHistory({});
    }
  };
});
