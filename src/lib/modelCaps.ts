/**
 * Model capability inference (renderer, pure).
 *
 * A probe is the only *truth* about what a relay supports, but the UI cannot
 * wait for one before it decides whether to show a thinking control or what to
 * say about prompt caching. This module answers the instant, offline question:
 * "based on the family this model id belongs to, what is likely true?"
 *
 * Rules:
 *  - `unknown` is a real answer. Never turn a guess into a capability.
 *  - thinking = can the model EXPOSE reasoning to the client (not "does it
 *    reason internally"), because the UI only has something to show when the
 *    provider streams a reasoning field.
 *  - cache profile = how the provider caches prompt tokens, not whether this
 *    particular request will hit. Observed hits come from real usage.
 */
import type { CacheMode, ModelCacheProfile, ModelCapsRecord, ModelCapabilities, ThinkingSupport } from '../types';

export interface ModelInference {
  thinking: ThinkingSupport;
  cache: ModelCacheProfile;
}

const profile = (mode: CacheMode, minTokens: number, ttlSeconds: number): ModelCacheProfile => ({
  mode,
  maxTokens: 0,
  minTokens,
  ttlSeconds
});

const NONE = profile('none', 0, 0);
const UNKNOWN = profile('unknown', 0, 0);
const ANTHROPIC_CACHE = profile('explicit', 1024, 300);
const OPENAI_CACHE = profile('auto', 1024, 300);
const DEEPSEEK_CACHE = profile('auto', 64, 3600);
const GEMINI_CACHE = profile('auto', 1024, 300);

/** Local endpoints don't bill prompt tokens and have no cache to report. */
function isLocalEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl);
}

export function inferThinkingSupport(model: string, kind: string = 'auto'): ThinkingSupport {
  const id = String(model || '').toLowerCase();
  if (!id) return 'unknown';
  const anthropic = kind === 'anthropic' || /claude|anthropic/.test(id);

  if (anthropic || /claude/.test(id)) {
    if (/claude-(opus|sonnet|haiku)-4/.test(id)) return 'yes';
    if (/claude-(3|2|instant)/.test(id)) return 'no';
    return 'unknown';
  }

  // OpenAI reasoning families expose a reasoning summary / reasoning content.
  if (/^o[1-9](?:[-.]|$)/.test(id) || /gpt-5/.test(id)) return 'yes';
  if (/gpt-4\.1|gpt-4o|gpt-4-turbo|gpt-3\.5|gpt-4(?:$|[-.])/.test(id)) return 'no';

  if (/deepseek-(reasoner|r1)/.test(id)) return 'yes';
  if (/deepseek-(chat|v3)/.test(id)) return 'no';

  if (/grok-4/.test(id)) return 'yes';
  if (/grok-3/.test(id)) return 'no';

  // Qwen3 and QwQ stream a reasoning field when thinking mode is on.
  if (/qwq|qwen3/.test(id)) return 'yes';
  if (/qwen2\.5|qwen2(?:\b|[-.:])/.test(id)) return 'no';

  if (/kimi-k2-thinking|kimi-thinking/.test(id)) return 'yes';
  if (/kimi-k2|kimi-k1\.5/.test(id)) return 'no';

  // Gemini thinking is internal; the OpenAI-compat endpoint doesn't stream a
  // reasoning field, so "unknown" is the honest answer.
  return 'unknown';
}

export function inferCacheProfile(model: string, opts: { kind?: string; baseUrl?: string } = {}): ModelCacheProfile {
  const id = String(model || '').toLowerCase();
  const kind = opts.kind || 'auto';
  if (isLocalEndpoint(opts.baseUrl)) return NONE;

  if (kind === 'anthropic' || /claude|anthropic/.test(id)) {
    // cache_control is documented for Claude 3.5+ / 4.x. Older ids (and opaque
    // proxy aliases) stay "unknown" — never promise a cache we cannot use.
    return /claude-(?:3[-.]5|3[-.]7|opus-4|sonnet-4|haiku-4|4)/.test(id) ? ANTHROPIC_CACHE : UNKNOWN;
  }

  if (/^o[1-9](?:[-.]|$)/.test(id) || /gpt-5|gpt-4\.1|gpt-4o/.test(id)) return OPENAI_CACHE;
  if (/deepseek/.test(id)) return DEEPSEEK_CACHE;
  if (/gemini-(2\.5|3)/.test(id)) return GEMINI_CACHE;
  // Groq, Mistral, Qwen, GLM, Kimi and unknown relays: no documented automatic
  // prompt caching we can promise. Observed usage still updates the registry.
  return UNKNOWN;
}

export function inferModelCaps(
  model: string,
  opts: { kind?: string; baseUrl?: string } = {}
): ModelInference {
  return {
    thinking: inferThinkingSupport(model, opts.kind),
    cache: inferCacheProfile(model, opts)
  };
}

/**
 * Instant family numbers, used ONLY while nothing has measured the model.
 *
 * The capability card used to show "Context unknown / Max output 4.1k tok
 * global default" until the user waited for a probe. Users read that as broken.
 * These are the documented windows of each family (Claude 4.x 200k, Gemini 2.5/3
 * 1M, GPT-5 400k, DeepSeek/Qwen 128k …), rendered with a `≈` so an estimate is
 * never mistaken for evidence. An override or a successful probe always wins.
 */
export function inferFamilyCaps(model: string): { context: number; maxOutput: number } {
  const id = String(model || '').toLowerCase();
  const out = { context: 0, maxOutput: 0 };
  if (/gemini-(2\.5|3)/.test(id)) { out.context = 1_000_000; out.maxOutput = 65_536; }
  else if (/gemini-(1\.5|1)/.test(id)) { out.context = 1_000_000; out.maxOutput = 8_192; }
  else if (/claude-(opus|sonnet|haiku)-4|claude-4/.test(id)) { out.context = 200_000; out.maxOutput = 32_000; }
  else if (/claude-3[-.]?(5|7)/.test(id)) { out.context = 200_000; out.maxOutput = 8_192; }
  else if (/claude/.test(id)) { out.context = 200_000; out.maxOutput = 4_096; }
  else if (/gpt-5/.test(id)) { out.context = 400_000; out.maxOutput = 64_000; }
  else if (/^o[1-9](?:[-.]|$)/.test(id)) { out.context = 200_000; out.maxOutput = 32_000; }
  else if (/gpt-4\.1/.test(id)) { out.context = 1_000_000; out.maxOutput = 32_000; }
  else if (/gpt-4o|gpt-4-turbo/.test(id)) { out.context = 128_000; out.maxOutput = 16_384; }
  else if (/deepseek/.test(id)) { out.context = 128_000; out.maxOutput = 8_192; }
  else if (/qwen3|qwq/.test(id)) { out.context = 128_000; out.maxOutput = 8_192; }
  else if (/kimi/.test(id)) { out.context = 128_000; out.maxOutput = 8_192; }
  else if (/glm-4/.test(id)) { out.context = 128_000; out.maxOutput = 4_096; }
  else if (/grok-4/.test(id)) { out.context = 256_000; out.maxOutput = 16_384; }
  else if (/mistral|mixtral|ministral/.test(id)) { out.context = 128_000; out.maxOutput = 8_192; }
  return out;
}

/**
 * How much prompt input can actually sit in the cache: the whole input up to
 * the context window. 0 means "unknown / not applicable" — never a fake number.
 */
export function cacheCapacity(cache: ModelCacheProfile, contextTokens: number | null | undefined): number {
  if (cache.mode === 'none' || cache.mode === 'unknown') return 0;
  const context = Number(contextTokens) || 0;
  if (context <= 0) return 0;
  if (cache.maxTokens > 0) return Math.min(cache.maxTokens, context);
  return context;
}

/**
 * How many output tokens to ask for.
 *
 * A configured number is obeyed. `0` / unset means "let the model go": the app
 * asks for the family's own output ceiling instead of cutting every reply at
 * one global default (4k used to end long chapters mid-sentence). The hard cap
 * only exists so a runaway generation cannot bill indefinitely.
 */
export const REPLY_HARD_CEILING = 32_000;

export function replyBudget(configured: number | null | undefined, model: string): number {
  const n = Math.round(Number(configured) || 0);
  if (n > 0) return n;
  const family = inferFamilyCaps(model).maxOutput;
  return Math.min(family || 8_192, REPLY_HARD_CEILING);
}

/**
 * A one-letter read-out of what the resolved numbers mean for real work.
 * It summarises `ModelProfile` only — an unknown context never earns a high
 * tier, so the badge cannot flatter a model the app knows nothing about.
 */
export function modelTier(profile: ModelProfile): 'S' | 'A' | 'B' | 'C' {
  const ctx = profile.contextTokens || 0;
  const thinks = profile.thinking === 'yes';
  if (thinks && ctx >= 200_000) return 'S';
  if (thinks || ctx >= 200_000) return 'A';
  if (ctx >= 32_000) return 'B';
  return 'C';
}

/** True when the model is not a reasoning model and has no cache we can name. */
export function isPlainModel(inference: ModelInference): boolean {
  return inference.thinking === 'no' && inference.cache.mode === 'none';
}

/**
 * Everything the UI is allowed to state about one model, resolved in one place
 * so the card and the composer can never disagree.
 *
 * Precedence is deliberate: a per-model override is the user speaking, a probe
 * is the provider speaking, and the family table is only a hint. Nothing is
 * filled in when no source knows it — `null`/0 mean "say unknown", never a
 * plausible-looking number.
 */
export interface ModelProfile {
  /** Largest prompt the model accepts, or null when nothing knows it. */
  contextTokens: number | null;
  /** True when contextTokens came from the family table, not a probe/override. */
  contextEstimated: boolean;
  /** Output cap the app will request (override, else the global default). */
  maxOutputTokens: number;
  /** True when maxOutputTokens came from the global default, not this model. */
  maxOutputFromDefault: boolean;
  /** True when maxOutputTokens came from the family table (a ceiling). */
  maxOutputEstimated: boolean;
  thinking: ThinkingSupport;
  cache: ModelCacheProfile;
  /** Prompt tokens that can sit in cache; 0 = unknown or not applicable. */
  cacheCapacityTokens: number;
  /** Provider-reported reuse from a real reply, or null when never observed. */
  observedCachedTokens: number | null;
  observedAt: number | null;
  /** Time of the last successful probe, or null. */
  probedAt: number | null;
}

export function resolveModelProfile(opts: {
  model: string;
  kind?: string;
  baseUrl?: string;
  record?: ModelCapsRecord | null;
  override?: { context?: number; maxTokens?: number } | null;
  defaultMaxTokens?: number;
  now?: number;
}): ModelProfile {
  const now = opts.now ?? Date.now();
  const record = opts.record || null;
  const caps = record?.caps;
  const probedAt = caps?.ok && Number(caps.probedAt) > 0 ? Number(caps.probedAt) : null;

  const overrideContext = Math.round(Number(opts.override?.context) || 0);
  const probedContext = caps?.ok ? Math.round(Number(caps.contextTokens) || 0) : 0;
  // The family table fills the row INSTANTLY so the card is readable without
  // waiting on a probe. Estimates render with `≈`, never as a measurement.
  const family = inferFamilyCaps(opts.model);
  const contextTokens = overrideContext > 0 ? overrideContext
    : probedContext > 0 ? probedContext
      : family.context > 0 ? family.context : null;
  const contextEstimated = overrideContext <= 0 && probedContext <= 0 && family.context > 0;

  const overrideMax = Math.round(Number(opts.override?.maxTokens) || 0);
  const globalMax = Math.max(0, Math.round(Number(opts.defaultMaxTokens) || 0));
  // A family output cap is a ceiling: the app default still wins when smaller.
  const familyMax = overrideMax > 0 ? 0 : family.maxOutput;
  const effectiveMax = overrideMax > 0 ? overrideMax
    : familyMax > 0 ? Math.min(globalMax > 0 ? globalMax : familyMax, familyMax)
      : globalMax;

  // An observation older than the registry TTL is re-checked rather than
  // trusted (matches electron/caps.ts pruning).
  const observed = record?.cacheObserved;
  const observedAt = Number(observed?.at) || 0;
  const freshObservation = observed && observedAt && now - observedAt <= THINKING_EVIDENCE_TTL_MS ? observed : null;
  const observedTokens = freshObservation ? Math.max(0, Math.round(Number(freshObservation.cachedTokens) || 0)) : null;

  const cache = inferCacheProfile(opts.model, { kind: opts.kind, baseUrl: opts.baseUrl });

  return {
    contextTokens,
    contextEstimated,
    maxOutputTokens: effectiveMax,
    maxOutputFromDefault: overrideMax <= 0 && familyMax <= 0,
    maxOutputEstimated: familyMax > 0,
    thinking: thinkingSupport(opts.model, { kind: opts.kind || 'auto', record, now }),
    cache,
    cacheCapacityTokens: cacheCapacity(cache, contextTokens),
    observedCachedTokens: observedTokens,
    observedAt: freshObservation ? observedAt : null,
    probedAt
  };
}

/** Evidence older than this is re-checked rather than trusted (matches main). */
export const THINKING_EVIDENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What the UI is allowed to claim about reasoning for one model.
 *
 * Evidence order, strongest first:
 *  1. the provider REJECTED a thinking request (`thinkingRejectedAt`) → `no`,
 *  2. a probe actually streamed a reasoning field → `yes`,
 *  3. otherwise the family table decides (`unknown` stays a real answer).
 *
 * A failed probe or a plain request that merely LACKS a reasoning field is not
 * proof of unsupported: Anthropic/OpenAI only stream reasoning when asked, so
 * their probes report `thinking: false` even on models that support it.
 */
export function thinkingSupport(
  model: string,
  opts: { kind?: string; record?: ModelCapsRecord | null; now?: number } = {}
): ThinkingSupport {
  const now = opts.now ?? Date.now();
  const record = opts.record;
  const rejectedAt = Number(record?.thinkingRejectedAt) || 0;
  if (rejectedAt && now - rejectedAt < THINKING_EVIDENCE_TTL_MS) return 'no';
  const caps = record?.caps;
  if (caps?.ok && caps.thinking && now - (Number(caps.probedAt) || 0) < THINKING_EVIDENCE_TTL_MS) return 'yes';
  return inferThinkingSupport(model, opts.kind || 'auto');
}

/**
 * Settings “Smart defaults” should realign, derived from one probe.
 *
 * Only fields the evidence actually speaks to are returned — an unprobed model
 * (or a failed probe) yields `{}`, so turning the toggle on never overwrites a
 * manual choice on a hunch. The caller applies what comes back.
 */
export interface SmartDefaultChanges {
  toolsEnabled?: boolean;
  thinkingEnabled?: boolean;
  maxTokens?: number;
}

export function smartDefaults(
  caps: ModelCapabilities | null | undefined,
  opts: { kind?: string } = {}
): SmartDefaultChanges {
  if (!caps || !caps.ok) return {};
  const changes: SmartDefaultChanges = {};
  if (!caps.tools) changes.toolsEnabled = false;
  // A probe that saw reasoning is positive evidence; one that saw nothing is
  // not negative evidence (see thinkingSupport).
  if (thinkingSupport(caps.model, { kind: opts.kind || 'auto', record: { caps } }) === 'no') {
    changes.thinkingEnabled = false;
  }
  if (caps.contextTokens > 0) {
    changes.maxTokens = caps.contextTokens >= 8192
      ? Math.min(4096, Math.floor(caps.contextTokens / 4))
      : Math.max(512, Math.floor(caps.contextTokens / 3));
  }
  return changes;
}

/**
 * The request rule: never ask a non-reasoning model to think, and never send a
 * budget that eats more than half of a known context window.
 */
export function resolveThinking(
  support: ThinkingSupport,
  pref: boolean,
  budget: number,
  contextTokens?: number | null
): { enabled: boolean; budget: number } {
  const requested = Number(budget);
  const base = Number.isFinite(requested) ? Math.max(1024, Math.round(requested)) : 4096;
  const context = Number(contextTokens) || 0;
  const clamped = context > 2048 ? Math.min(base, Math.max(1024, Math.floor(context / 2))) : base;
  return { enabled: support === 'no' ? false : !!pref, budget: clamped };
}
