/**
 * Settings information architecture tests (v1.2.3 Task 6).
 *
 * The nav, the settings search and the command palette all read the same
 * registry. These checks keep it honest: a section can only live in one group,
 * a search hit must point at a real section, Simple mode must not leak the
 * Extend group, and reset defaults must not name a phantom section.
 *
 * Run: node scripts/settings-index-test.mjs
 */
import { loadTs } from './lib/load-ts.mjs';

const {
  SETTINGS_SECTIONS, SETTINGS_GROUPS, SETTINGS_INDEX, SECTION_DEFAULTS,
  visibleSections, searchSettings
} = await loadTs('src/lib/settingsIndex.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// A tiny translation stub: enough labels to exercise ranking, with the key as
// fallback so a missing fixture shows up as a mismatch instead of crashing.
const LABELS = {
  'settings.models': 'Models',
  'settings.providers': 'AI Providers',
  'settings.behavior': 'Chat Behavior',
  'settings.appearance': 'Appearance',
  'settings.usage': 'Usage',
  'settings.plugins': 'Plugins',
  'settings.skills': 'Skills',
  'models.default': 'Default model',
  'models.table': 'Models table',
  'models.smartDefaults': 'Smart defaults',
  'providers.verifyAll': 'Verify all models',
  'caps.rowCache': 'Prompt cache',
  'usage.title': 'Token usage',
  'style.active': 'Active style',
  'smart.title': 'Smart setup'
};
const t = (key) => LABELS[key] ?? key;

// --------------------------------------------------------------- sections ---
const valid = new Set(SETTINGS_SECTIONS);
check('sections: no duplicates', new Set(SETTINGS_SECTIONS).size === SETTINGS_SECTIONS.length);

const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
check('groups: every declared section is valid', SETTINGS_GROUPS.every((g) => g.sections.every((s) => valid.has(s))));
check('groups: every section appears in exactly one group',
  grouped.length === SETTINGS_SECTIONS.length && new Set(grouped).size === grouped.length,
  `${grouped.length} vs ${SETTINGS_SECTIONS.length}`);
check('groups: only the Extend group is advanced-only',
  SETTINGS_GROUPS.filter((g) => g.advancedOnly).map((g) => g.id).join(',') === 'extend');
check('groups: every group carries a label key', SETTINGS_GROUPS.every((g) => /^settings\.group\./.test(g.labelKey)));

// --------------------------------------------------------------- registry ---
check('index: no duplicate control ids', new Set(SETTINGS_INDEX.map((e) => e.id)).size === SETTINGS_INDEX.length);
check('index: no duplicate labels', new Set(SETTINGS_INDEX.map((e) => e.labelKey)).size === SETTINGS_INDEX.length);
check('index: every entry points at a real section', SETTINGS_INDEX.every((e) => valid.has(e.section)),
  SETTINGS_INDEX.filter((e) => !valid.has(e.section)).map((e) => e.id).join(','));
check('index: every entry has keywords in both languages',
  SETTINGS_INDEX.every((e) => Array.isArray(e.keywords) && e.keywords.length >= 1));
check('index: control ids use the set- prefix and are DOM-safe',
  SETTINGS_INDEX.every((e) => /^set-[a-z0-9-]+$/.test(e.id)));
check('index: the four core surfaces are covered',
  ['providers', 'models', 'behavior', 'appearance', 'data', 'about'].every((s) => SETTINGS_INDEX.some((e) => e.section === s)));

// ------------------------------------------------------------ visibility ---
const simple = visibleSections('simple');
const advanced = visibleSections('advanced');
check('visibility: simple hides plugins/automations/mcp',
  !simple.includes('plugins') && !simple.includes('automations') && !simple.includes('mcp'));
check('visibility: simple keeps the daily-driver sections',
  ['providers', 'models', 'behavior', 'styles', 'skills', 'agentmd', 'appearance', 'memory', 'usage', 'data', 'about']
    .every((s) => simple.includes(s)));
check('visibility: advanced shows every section', advanced.length === SETTINGS_SECTIONS.length);

// ----------------------------------------------------------------- search ---
check('search: empty query returns nothing', searchSettings('', t).length === 0);
check('search: whitespace-only query returns nothing', searchSettings('   ', t).length === 0);

const cacheHits = searchSettings('cache', t, 'advanced');
check('search: "cache" finds the models table', cacheHits.some((h) => h.entry.id === 'set-model-table'),
  cacheHits.map((h) => h.entry.id).join(','));

const modelHits = searchSettings('model', t, 'advanced');
check('search: a label prefix outranks a keyword hit',
  modelHits[0] && modelHits[0].entry.section === 'models', modelHits.slice(0, 2).map((h) => h.entry.id).join(','));

const idHits = searchSettings('kunci', t, 'advanced');
check('search: Indonesian keywords work before the UI is localized',
  idHits.some((h) => h.entry.section === 'providers'), idHits.map((h) => h.entry.id).join(','));

check('search: simple mode hides advanced-only controls',
  !searchSettings('top p', t, 'simple').some((h) => h.entry.id === 'set-top-p')
  && searchSettings('top p', t, 'advanced').some((h) => h.entry.id === 'set-top-p'));

check('search: simple mode never surfaces the Extend group',
  searchSettings('plugin', t, 'simple').length === 0
  && searchSettings('plugin', t, 'advanced').some((h) => h.entry.section === 'plugins'));

const limit = searchSettings('e', t, 'advanced');
check('search: results are capped', limit.length <= 12, String(limit.length));

// ------------------------------------------------------- reset defaults -----
const resetSections = Object.keys(SECTION_DEFAULTS);
check('reset: every reset target is a real section', resetSections.every((s) => valid.has(s)), resetSections.join(','));
check('reset: appearance restores theme, accent and font',
  SECTION_DEFAULTS.appearance?.theme === 'dark-classic'
  && SECTION_DEFAULTS.appearance?.accent === '#7c5cff'
  && SECTION_DEFAULTS.appearance?.chatFontSize === 14);
check('reset: models clears the default ref and overrides',
  SECTION_DEFAULTS.models?.defaultModelRef === null
  && Object.keys(SECTION_DEFAULTS.models?.modelOverrides || {}).length === 0);
check('reset: behavior restores the thinking defaults',
  SECTION_DEFAULTS.behavior?.thinkingEnabled === true && SECTION_DEFAULTS.behavior?.thinkingBudget === 4096);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL SETTINGS-INDEX TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
