/**
 * Persisted model-capability registry (v1.2.3).
 *
 * The capability probe used to live in React state: close the modal, restart
 * the app, and everything the app had learned about a model was gone. This
 * module stores the last probe per provider+model in the `settings` table and
 * folds in the one thing only real traffic can tell us — how many prompt tokens
 * the provider actually served from its cache.
 *
 * Rules that keep it honest and bounded:
 *  - an unknown model keeps `caps` undefined (the UI says "unverified"),
 *  - a probe older than 14 days is dropped so it is re-checked, not trusted,
 *  - at most 120 models are retained (relays can advertise thousands),
 *  - a cache observation never invents a probe (it is stored separately),
 *  - the stored cache count is whatever the provider reported — never zeroed.
 */
import { handleDb } from './db';
import type { ModelCapabilities } from './ai';

export interface ModelCapsRecord {
  /** Last capability probe, absent when the model was only used in a chat. */
  caps?: ModelCapabilities;
  /** Provider-reported prompt-cache reuse from real generations. */
  cacheObserved?: { cachedTokens: number; at: number };
  /** The provider rejected a thinking request (sent by the renderer on failure). */
  thinkingRejectedAt?: number;
}

export const MODEL_CAPS_KEY = 'modelCaps';
export const MODEL_CAPS_MAX = 120;
export const MODEL_CAPS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHED_TOKENS = 10_000_000;

export function capsKey(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

function normalizeCaps(raw: any): ModelCapabilities | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const probedAt = Number(raw.probedAt) || 0;
  if (!probedAt) return undefined;
  return {
    model: String(raw.model || ''),
    tools: !!raw.tools,
    streaming: !!raw.streaming,
    thinking: !!raw.thinking,
    contextTokens: Math.max(0, Math.round(Number(raw.contextTokens) || 0)),
    ok: !!raw.ok,
    ...(raw.error ? { error: String(raw.error).slice(0, 500) } : {}),
    probedAt
  };
}

/**
 * Validate, age out and cap the registry. Pure on purpose: the shape guards are
 * the part that has to be tested, and a corrupted settings row (hand-edited DB,
 * old build) must never crash the app on boot.
 */
export function pruneModelCaps(raw: unknown, now = Date.now()): Record<string, ModelCapsRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const kept: Array<[string, ModelCapsRecord, number]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.includes('::') || !value || typeof value !== 'object') continue;
    const record = value as ModelCapsRecord;
    const caps = normalizeCaps(record.caps);
    const observed = record.cacheObserved;
    const observedTokens = Number(observed?.cachedTokens);
    const observedAt = Number(observed?.at) || 0;
    const cacheObserved = observed && Number.isFinite(observedTokens) && observedTokens >= 0 && observedAt
      ? { cachedTokens: Math.min(MAX_CACHED_TOKENS, Math.round(observedTokens)), at: observedAt }
      : undefined;
    const rejectedAt = Number((record as any).thinkingRejectedAt) || 0;
    const thinkingRejectedAt = rejectedAt > 0 ? rejectedAt : 0;
    if (!caps && !cacheObserved && !thinkingRejectedAt) continue;
    const at = Math.max(caps?.probedAt || 0, cacheObserved?.at || 0, thinkingRejectedAt);
    if (!at || now - at > MODEL_CAPS_TTL_MS) continue;
    kept.push([
      key,
      {
        ...(caps ? { caps } : {}),
        ...(cacheObserved ? { cacheObserved } : {}),
        ...(thinkingRejectedAt ? { thinkingRejectedAt } : {})
      },
      at
    ]);
  }
  kept.sort((a, b) => b[2] - a[2]);
  const out: Record<string, ModelCapsRecord> = {};
  for (const [key, record] of kept.slice(0, MODEL_CAPS_MAX)) out[key] = record;
  return out;
}

function readAll(): Record<string, ModelCapsRecord> {
  try {
    const rows = handleDb('getAllSettings', {}) as Record<string, string>;
    const raw = rows?.[MODEL_CAPS_KEY];
    return pruneModelCaps(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, ModelCapsRecord>): void {
  try {
    handleDb('setSetting', { key: MODEL_CAPS_KEY, value: JSON.stringify(map) });
  } catch (err) {
    // The registry is an optimization; a write failure must never fail a chat.
    console.error('Could not persist model capabilities:', err);
  }
}

export function listModelCaps(): Record<string, ModelCapsRecord> {
  return readAll();
}

/** Store a completed probe (called by the `ai:probeCapabilities` handler). */
export function recordModelCaps(providerId: string, model: string, caps: ModelCapabilities): void {
  if (!providerId || !model || !caps) return;
  const all = readAll();
  const key = capsKey(providerId, model);
  const existing = all[key];
  // A probe that actually SAW reasoning contradicts an earlier rejection, so
  // it clears the flag. A probe that merely saw nothing does not (see
  // thinkingSupport: absence of reasoning is not evidence).
  const keepRejection = !!existing?.thinkingRejectedAt && !caps.thinking;
  all[key] = {
    caps: { ...caps, model: caps.model || model },
    ...(existing?.cacheObserved ? { cacheObserved: existing.cacheObserved } : {}),
    ...(keepRejection ? { thinkingRejectedAt: existing!.thinkingRejectedAt } : {})
  };
  writeAll(pruneModelCaps(all));
}

/**
 * Record that the provider refused a thinking request. This is direct evidence
 * (unlike a probe that merely saw no reasoning field), so it beats the family
 * table for the next 14 days. Written in the main process so it merges with the
 * freshest registry instead of clobbering a cache observation the renderer has
 * not seen yet.
 */
export function markThinkingRejected(providerId: string, model: string): void {
  if (!providerId || !model) return;
  const all = readAll();
  const key = capsKey(providerId, model);
  const existing = all[key];
  all[key] = {
    ...(existing?.caps ? { caps: existing.caps } : {}),
    ...(existing?.cacheObserved ? { cacheObserved: existing.cacheObserved } : {}),
    thinkingRejectedAt: Date.now()
  };
  writeAll(pruneModelCaps(all));
}

/**
 * Fold the provider-reported cache reuse from a real generation into the
 * registry. No probe record is fabricated — the UI shows "observed" separately
 * from "probed".
 */
export function recordCacheObservation(providerId: string, model: string, cachedTokens: unknown): void {
  const tokens = Number(cachedTokens);
  if (!providerId || !model || !Number.isFinite(tokens) || tokens < 0) return;
  const all = readAll();
  const key = capsKey(providerId, model);
  const existing = all[key];
  all[key] = {
    ...(existing?.caps ? { caps: existing.caps } : {}),
    cacheObserved: { cachedTokens: Math.min(MAX_CACHED_TOKENS, Math.round(tokens)), at: Date.now() },
    ...(existing?.thinkingRejectedAt ? { thinkingRejectedAt: existing.thinkingRejectedAt } : {})
  };
  writeAll(pruneModelCaps(all));
}
