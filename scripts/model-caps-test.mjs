/**
 * Model capability + cache tests (v1.2.3).
 *
 * Two halves:
 *   1. `src/lib/modelCaps.ts` inference (pure, no DB) — thinking support and
 *      provider cache profiles per model family, including "unknown" answers.
 *   2. `electron/caps.ts` registry — pruning (shape, TTL, 120-model cap),
 *      persistence, cache observations and corrupted-row tolerance.
 *
 * Run: node scripts/model-caps-test.mjs   (requires `npm run build:electron`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadTs } from './lib/load-ts.mjs';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb } = require('../dist-electron/db.js');
const {
  pruneModelCaps, recordModelCaps, recordCacheObservation, listModelCaps,
  markThinkingRejected,
  MODEL_CAPS_KEY, MODEL_CAPS_MAX, MODEL_CAPS_TTL_MS
} = require('../dist-electron/caps.js');
const { readCachedTokens } = require('../dist-electron/ai.js');

const {
  inferThinkingSupport, inferCacheProfile, inferModelCaps, cacheCapacity,
  thinkingSupport, resolveThinking, resolveModelProfile, THINKING_EVIDENCE_TTL_MS
} = await loadTs('src/lib/modelCaps.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ------------------------------------------------------- thinking support ---
const thinkingCases = [
  ['claude-sonnet-4-5', 'anthropic', 'yes'],
  ['claude-opus-4-5', 'anthropic', 'yes'],
  ['claude-3-5-sonnet-20240620', 'anthropic', 'no'],
  ['gpt-5.2', 'openai', 'yes'],
  ['gpt-5.2-mini', 'openai', 'yes'],
  ['o4-mini', 'openai', 'yes'],
  ['o1-preview', 'openai', 'yes'],
  ['gpt-4.1-mini', 'openai', 'no'],
  ['gpt-4o', 'openai', 'no'],
  ['deepseek-reasoner', 'openai', 'yes'],
  ['deepseek-chat', 'openai', 'no'],
  ['grok-4', 'openai', 'yes'],
  ['grok-3', 'openai', 'no'],
  ['qwen3-max', 'openai', 'yes'],
  ['qwen2.5-72b-instruct', 'openai', 'no'],
  ['kimi-k2-0905-preview', 'openai', 'no'],
  ['gemini-3-pro', 'openai', 'unknown'],
  ['some-relay-model', 'auto', 'unknown'],
  ['', 'auto', 'unknown']
];
for (const [model, kind, expected] of thinkingCases) {
  const got = inferThinkingSupport(model, kind);
  check(`thinking: ${model || '(empty)'} -> ${expected}`, got === expected, `got ${got}`);
}

// ------------------------------------------------ evidence-based support ---
// The UI may not claim "no" just because a plain probe lacked a reasoning
// field (Anthropic/OpenAI only stream reasoning when asked). Only a rejection
// or a probe that actually SAW reasoning is evidence.
{
  const now = Date.now();
  const probe = (thinking, ok = true, at = now) => ({
    caps: { model: 'm', tools: true, streaming: true, thinking, contextTokens: 128000, ok, probedAt: at }
  });

  check('support: no evidence falls back to the family table',
    thinkingSupport('claude-sonnet-4-5', { kind: 'anthropic' }) === 'yes'
    && thinkingSupport('gpt-4o', { kind: 'openai' }) === 'no'
    && thinkingSupport('some-relay-model') === 'unknown');
  check('support: a probe that saw reasoning says yes',
    thinkingSupport('some-relay-model', { record: probe(true) }) === 'yes');
  check('support: a probe that saw no reasoning does not override the family',
    thinkingSupport('claude-sonnet-4-5', { kind: 'anthropic', record: probe(false) }) === 'yes');
  check('support: a failed probe is ignored',
    thinkingSupport('claude-sonnet-4-5', { kind: 'anthropic', record: probe(true, false) }) === 'yes'
    && thinkingSupport('gpt-4o', { kind: 'openai', record: probe(true, false) }) === 'no');
  check('support: an explicit rejection says no even for a reasoning family',
    thinkingSupport('claude-sonnet-4-5', { kind: 'anthropic', record: { thinkingRejectedAt: now } }) === 'no');
  check('support: a stale rejection stops counting',
    thinkingSupport('claude-sonnet-4-5', { kind: 'anthropic', record: { thinkingRejectedAt: now - THINKING_EVIDENCE_TTL_MS - 1 } }) === 'yes');
  check('support: a stale positive probe stops counting',
    thinkingSupport('some-relay-model', { record: probe(true, true, now - THINKING_EVIDENCE_TTL_MS - 1) }) === 'unknown');
}

// ------------------------------------------------------- request rule ------
check('resolve: a `no` model never receives thinking, even when preferred',
  resolveThinking('no', true, 4096).enabled === false);
check('resolve: `yes` and `unknown` follow the user preference',
  resolveThinking('yes', true, 4096).enabled === true
  && resolveThinking('unknown', false, 4096).enabled === false);
check('resolve: budget is floored at 1024',
  resolveThinking('yes', true, 10).budget === 1024);
check('resolve: budget is capped at half the known context',
  resolveThinking('yes', true, 80000, 100000).budget === 50000);
check('resolve: a small context drops the budget below the setting',
  resolveThinking('yes', true, 4096, 4096).budget === 2048);
check('resolve: unknown context leaves the budget alone',
  resolveThinking('yes', true, 8192, 0).budget === 8192);

// ---------------------------------------------------------- cache profile ---
check('cache: anthropic 4.x uses explicit breakpoints',
  inferCacheProfile('claude-sonnet-4-5', { kind: 'anthropic' }).mode === 'explicit');
check('cache: anthropic 3.5 is explicit',
  inferCacheProfile('claude-3-5-sonnet-20241022', { kind: 'anthropic' }).mode === 'explicit');
check('cache: older anthropic ids stay unknown',
  inferCacheProfile('claude-3-opus-20240229', { kind: 'anthropic' }).mode === 'unknown');
check('cache: openai is automatic (min 1024)',
  inferCacheProfile('gpt-5.2', { kind: 'openai' }).mode === 'auto'
  && inferCacheProfile('gpt-5.2').minTokens === 1024);
check('cache: deepseek caches from 64 tokens',
  inferCacheProfile('deepseek-chat').mode === 'auto' && inferCacheProfile('deepseek-chat').minTokens === 64);
check('cache: gemini 2.5/3 is automatic',
  inferCacheProfile('gemini-3-flash').mode === 'auto' && inferCacheProfile('gemini-2.5-flash-lite').mode === 'auto');
check('cache: unknown relays are unknown',
  inferCacheProfile('some-relay-model', { kind: 'auto' }).mode === 'unknown');
check('cache: local endpoints have no cache',
  inferCacheProfile('llama3.2', { baseUrl: 'http://localhost:11434/v1' }).mode === 'none'
  && inferCacheProfile('llama3.2', { baseUrl: 'http://127.0.0.1:1234/v1' }).mode === 'none');
check('inferModelCaps combines both answers',
  inferModelCaps('claude-opus-4-5', { kind: 'anthropic' }).thinking === 'yes'
  && inferModelCaps('claude-opus-4-5', { kind: 'anthropic' }).cache.mode === 'explicit');

// -------------------------------------------------- provider usage shapes ----
check('usage: OpenAI cached_tokens is read',
  readCachedTokens({ prompt_tokens_details: { cached_tokens: 2048 } }) === 2048);
check('usage: DeepSeek prompt_cache_hit_tokens is read',
  readCachedTokens({ prompt_cache_hit_tokens: 640 }) === 640);
check('usage: Anthropic cache_read_input_tokens is read',
  readCachedTokens({ cache_read_input_tokens: 1536 }) === 1536);
check('usage: unreported cache is undefined, not zero',
  readCachedTokens(null) === undefined && readCachedTokens({}) === undefined
  && readCachedTokens({ prompt_tokens: 10 }) === undefined);
check('usage: negative values are ignored', readCachedTokens({ cached_tokens: -1 }) === undefined);
check('usage: zero is preserved as a real observation', readCachedTokens({ cached_tokens: 0 }) === 0);

// ------------------------------------------------------------- capacity -----
check('capacity: unknown cache reports 0',
  cacheCapacity(inferCacheProfile('some-relay-model'), 128000) === 0);
check('capacity: none reports 0',
  cacheCapacity(inferCacheProfile('llama3.2', { baseUrl: 'http://localhost:11434/v1' }), 128000) === 0);
check('capacity: bounded by the probed context',
  cacheCapacity(inferCacheProfile('claude-sonnet-4-5', { kind: 'anthropic' }), 200000) === 200000);
check('capacity: no context probe = no number',
  cacheCapacity(inferCacheProfile('claude-sonnet-4-5', { kind: 'anthropic' }), 0) === 0);

// ---------------------------------------------------- model profile --------
// The card in Settings renders exactly this object; every "unknown" here is a
// row that must read "unknown" instead of a made-up number.
const profileNow = Date.now();
const probed = {
  caps: { model: 'claude-sonnet-4-5', tools: true, streaming: true, thinking: true, contextTokens: 200000, ok: true, probedAt: profileNow }
};
const profile = (model, extra = {}) => resolveModelProfile({
  model,
  kind: extra.kind || 'anthropic',
  record: extra.record,
  override: extra.override,
  defaultMaxTokens: extra.defaultMaxTokens ?? 4096,
  now: profileNow
});

{
  const bare = profile('some-relay-model');
  check('profile: a model nobody knows reports no context', bare.contextTokens === null);
  check('profile: an unknown model keeps cache mode unknown',
    bare.cache.mode === 'unknown' && bare.cacheCapacityTokens === 0);
  check('profile: max output falls back to the global default',
    bare.maxOutputTokens === 4096 && bare.maxOutputFromDefault === true);

  const fromProbe = profile('claude-sonnet-4-5', { record: probed });
  check('profile: a successful probe supplies the context window',
    fromProbe.contextTokens === 200000 && fromProbe.probedAt === profileNow);
  check('profile: cache capacity follows the probed context',
    fromProbe.cache.mode === 'explicit' && fromProbe.cacheCapacityTokens === 200000);

  const overridden = profile('claude-sonnet-4-5', {
    record: probed,
    override: { context: 128000, maxTokens: 8192 },
    defaultMaxTokens: 4096
  });
  check('profile: a per-model override beats the probe', overridden.contextTokens === 128000);
  check('profile: a per-model max output is not flagged as default',
    overridden.maxOutputTokens === 8192 && overridden.maxOutputFromDefault === false);
  check('profile: cache capacity follows the overridden context',
    overridden.cacheCapacityTokens === 128000);

  check('profile: a failed probe is not evidence',
    profile('claude-sonnet-4-5', { record: { caps: { ...probed.caps, ok: false, contextTokens: 0 } } }).probedAt === null);

  const observed = profile('gpt-5.2', {
    kind: 'openai',
    record: { cacheObserved: { cachedTokens: 4096, at: profileNow } }
  });
  check('profile: an observed cache count is reported', observed.observedCachedTokens === 4096);
  check('profile: a stale observation is dropped',
    profile('gpt-5.2', {
      kind: 'openai',
      record: { cacheObserved: { cachedTokens: 4096, at: profileNow - THINKING_EVIDENCE_TTL_MS - 1 } }
    }).observedCachedTokens === null);
  check('profile: no observation stays null, never zero', profile('gpt-5.2', { kind: 'openai' }).observedCachedTokens === null);

  const rejected = profile('claude-sonnet-4-5', { record: { ...probed, thinkingRejectedAt: profileNow } });
  check('profile: reasoning follows the evidence rule',
    rejected.thinking === 'no' && profile('some-relay-model').thinking === 'unknown');
  check('profile: a local endpoint reports no cache',
    resolveModelProfile({ model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', now: profileNow }).cache.mode === 'none');
}

// ------------------------------------------------------- prune (pure) -------
const now = Date.now();
const freshCaps = {
  model: 'm', tools: true, streaming: true, thinking: true,
  contextTokens: 128000, ok: true, probedAt: now
};
const staleCaps = { ...freshCaps, probedAt: now - MODEL_CAPS_TTL_MS - 1000 };
const pruned = pruneModelCaps({
  'p1::fresh': { caps: freshCaps },
  'p1::stale': { caps: staleCaps },
  'p1::observed': { cacheObserved: { cachedTokens: 1234, at: now } },
  'badkey': { caps: freshCaps },
  'p2::broken': { caps: 'nope' },
  'p2::negatives': { cacheObserved: { cachedTokens: -5, at: now } },
  'p3::zero': { cacheObserved: { cachedTokens: 0, at: now } }
}, now);
check('prune: keeps fresh probe', !!pruned['p1::fresh']?.caps);
check('prune: drops stale probe', !pruned['p1::stale']);
check('prune: keeps observed cache without a probe', pruned['p1::observed']?.cacheObserved?.cachedTokens === 1234);
check('prune: drops keys without a provider::model shape', !pruned.badkey);
check('prune: drops unreadable caps', !pruned['p2::broken']);
check('prune: drops negative cache counts', !pruned['p2::negatives']);
check('prune: keeps a real zero observation', pruned['p3::zero']?.cacheObserved?.cachedTokens === 0);
const rejectedPrune = pruneModelCaps({
  'p1::rejected': { thinkingRejectedAt: now },
  'p1::stale-rejected': { thinkingRejectedAt: now - MODEL_CAPS_TTL_MS - 1 }
}, now);
check('prune: a rejection alone is kept', rejectedPrune['p1::rejected']?.thinkingRejectedAt === now);
check('prune: a stale rejection is dropped', !rejectedPrune['p1::stale-rejected']);
check('prune: garbage input returns an empty map',
  Object.keys(pruneModelCaps(null)).length === 0 && Object.keys(pruneModelCaps('x')).length === 0);

// ------------------------------------------------------------- registry -----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-caps-'));
await initDb(tmp, 'caps.db');

check('registry: empty on a fresh database', Object.keys(listModelCaps()).length === 0);

recordModelCaps('prov-1', 'gpt-5.2', freshCaps);
const stored = listModelCaps();
check('registry: probe is persisted', stored['prov-1::gpt-5.2']?.caps?.contextTokens === 128000);

recordCacheObservation('prov-1', 'gpt-5.2', 4096);
const withCache = listModelCaps()['prov-1::gpt-5.2'];
check('registry: cache observation is folded in', withCache?.cacheObserved?.cachedTokens === 4096);
check('registry: observation keeps the probe', withCache?.caps?.thinking === true);

// A rejection recorded by the renderer must survive later probe/cache writes.
handleDb('setSetting', { key: MODEL_CAPS_KEY, value: JSON.stringify({ ...listModelCaps(), 'prov-1::gpt-5.2': { thinkingRejectedAt: Date.now() } }) });
recordCacheObservation('prov-1', 'gpt-5.2', 1024);
check('registry: cache write preserves a thinking rejection',
  listModelCaps()['prov-1::gpt-5.2']?.thinkingRejectedAt > 0);
recordModelCaps('prov-1', 'gpt-5.2', { ...freshCaps, thinking: false });
check('registry: a probe without reasoning preserves the rejection',
  listModelCaps()['prov-1::gpt-5.2']?.thinkingRejectedAt > 0);
recordModelCaps('prov-1', 'gpt-5.2', { ...freshCaps, thinking: true });
check('registry: a probe that saw reasoning clears the rejection',
  listModelCaps()['prov-1::gpt-5.2']?.thinkingRejectedAt === undefined
  && listModelCaps()['prov-1::gpt-5.2']?.caps?.thinking === true);

markThinkingRejected('prov-1', 'gpt-5.2');
const marked = listModelCaps()['prov-1::gpt-5.2'];
check('registry: markThinkingRejected merges with probe and cache',
  marked?.thinkingRejectedAt > 0 && marked?.caps?.thinking === true && marked?.cacheObserved?.cachedTokens === 1024,
  JSON.stringify(marked));
check('registry: markThinkingRejected ignores empty ids',
  (markThinkingRejected('', 'm'), markThinkingRejected('p', ''), Object.keys(listModelCaps()).length === 1));

recordCacheObservation('prov-1', 'deepseek-chat', 512);
const observedOnly = listModelCaps()['prov-1::deepseek-chat'];
check('registry: observation works without a probe',
  observedOnly?.cacheObserved?.cachedTokens === 512 && observedOnly?.caps === undefined);
check('registry: invalid observations are ignored',
  (recordCacheObservation('', 'x', 10), recordCacheObservation('prov-1', '', 10), Object.keys(listModelCaps()).length === 2));

// 120-model cap: seed 140 synthetic entries directly, then prune through read.
const raw = JSON.parse(handleDb('getAllSettings', {})[MODEL_CAPS_KEY]);
for (let i = 0; i < 140; i++) {
  raw[`bulk::model-${i}`] = { caps: { ...freshCaps, model: `model-${i}` } };
}
handleDb('setSetting', { key: MODEL_CAPS_KEY, value: JSON.stringify(raw) });
check('registry: never exceeds the model cap', Object.keys(listModelCaps()).length <= MODEL_CAPS_MAX,
  String(Object.keys(listModelCaps()).length));

// Corrupted row (hand-edited DB, failed write) must not throw on boot.
handleDb('setSetting', { key: MODEL_CAPS_KEY, value: '{not json' });
let crashed = false;
try { listModelCaps(); } catch { crashed = true; }
check('registry: a corrupted settings row is tolerated', !crashed);

closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL MODEL-CAPS TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
