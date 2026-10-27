/**
 * Headless UI smoke test — no display, no Electron.
 *
 * Renders the real React views with react-dom/server after installing minimal
 * browser stubs. This catches render-time crashes, broken imports and bad hook
 * usage in views that the headless DB tests never touch (Story Agent, Story
 * Bible attachments, Settings → Data). Effects are intentionally not executed;
 * interactive behaviour is covered by the Electron GUI suites where a display
 * is available.
 *
 * Run: node scripts/ui-render-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const PROJ = path.resolve(import.meta.dirname, '..');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ---------- browser stubs (only what import-time + render needs) ----------
const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
  setItem: (k, v) => { storage.set(String(k), String(v)); },
  removeItem: (k) => { storage.delete(String(k)); },
  clear: () => storage.clear(),
  key: (i) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size; }
};
const noop = () => {};
const fakeElement = () => ({
  style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, removeChild: noop, setAttribute: noop, removeAttribute: noop,
  getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], focus: noop,
  addEventListener: noop, removeEventListener: noop, insertBefore: noop, contains: () => false
});
globalThis.localStorage = localStorageStub;
globalThis.document = {
  nodeType: 9,
  documentElement: fakeElement(),
  body: fakeElement(),
  head: fakeElement(),
  createElement: fakeElement,
  createTextNode: () => ({ nodeValue: '' }),
  implementation: { createHTMLDocument: () => ({ body: fakeElement(), head: fakeElement() }) },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  contains: () => false,
  activeElement: null
};
globalThis.window = {
  document: globalThis.document,
  localStorage: localStorageStub,
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: () => true,
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  innerWidth: 1280,
  innerHeight: 800,
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  navigator: { userAgent: 'node-smoke' },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop }),
  inkwell: {
    dbCall: async () => ({ ok: true, data: [] }),
    appInfo: async () => ({ version: '1.2.0', platform: 'linux', dataPath: '/tmp', donateUrl: '' }),
    onUi: () => noop,
    onAiChunk: () => noop,
    pathForFile: () => '',
    readFiles: async () => [],
    pickFiles: async () => [],
    openExternal: async () => {},
    setUnreadCount: async () => true
  }
};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
}

// ---------- bundle + render ----------
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-ui-'));
const outfile = path.join(outDir, 'smoke.cjs');
try {
  await build({
    entryPoints: [path.join(PROJ, 'scripts/lib/ui-smoke-entry.tsx')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    // Guide articles use Vite's `?raw` suffix; esbuild has no such loader, so
    // resolve the path without the suffix and return the file text.
    plugins: [{
      name: 'raw-md',
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
          namespace: 'raw-md'
        }));
        build.onLoad({ filter: /.*/, namespace: 'raw-md' }, (args) => ({
          contents: fs.readFileSync(args.path, 'utf8'),
          loader: 'text'
        }));
      }
    }]
  });
} catch (e) {
  console.error('FAIL  esbuild bundle — ' + (e?.message || e));
  process.exit(1);
}

const { smoke } = require(outfile);
const views = smoke();

for (const name of ['app', 'agent', 'story', 'settings', 'chat']) {
  const err = views[name + 'Error'];
  check(`renders ${name} without crashing`, !err, err ? err.split('\n').slice(0, 2).join(' | ') : '');
}
check('app shell renders the sidebar + welcome', /nav-tree/.test(views.app || '') && /Plot/.test(views.app || ''));
check('story agent renders Plot Smith + all four steps', /Plot Smith/.test(views.agent || '') && /Brief/.test(views.agent || '') && /Outline/.test(views.agent || ''));
check('story agent renders the option chips (genres + tones)', /Fantasy/.test(views.agent || '') && /Hopeful/.test(views.agent || ''));
check('story bible renders import + attachment affordances', /Import/.test(views.story || '') && /Story Bible/.test(views.story || ''));
check('settings data view renders the storage card', /Local database/.test(views.settings || '') || /database/i.test(views.settings || ''));
const SETTINGS_SECTIONS = [
  'providers', 'models', 'behavior', 'styles', 'skills', 'agentmd',
  'appearance', 'memory', 'usage', 'data', 'plugins', 'automations', 'mcp', 'about'
];
check('every settings section renders without crashing',
  SETTINGS_SECTIONS.every((s) => !views['settings-' + s + 'Error']),
  SETTINGS_SECTIONS.filter((s) => views['settings-' + s + 'Error']).join(','));
check('settings shell renders grouped nav, search and mode switch',
  /settings-group-label/.test(views['settings-models'] || '')
  && /settings-search/.test(views['settings-models'] || '')
  && /settings-mode-toggle/.test(views['settings-models'] || ''));
check('simple mode keeps Extend out of the nav',
  !/settings-group-label[^>]*>Extend</.test(views['settings-models'] || '')
  && /Show advanced settings/.test(views['settings-models'] || ''));
check('advanced mode renders the Extend group and sampling controls',
  /settings-group-label[^>]*>Extend</.test(views['settingsA-models'] || '')
  && /set-top-p/.test(views['settingsA-behavior'] || '')
  && /set-thinking-budget/.test(views['settingsA-behavior'] || ''));
check('models section renders the capability table card',
  /set-model-table/.test(views['settings-models'] || '')
  && /set-default-model/.test(views['settings-models'] || '')
  && /set-smart-defaults/.test(views['settings-models'] || ''));
check('providers section renders the smart setup card',
  /set-smart-setup/.test(views['settings-providers'] || '')
  && /Smart setup/.test(views['settings-providers'] || ''));
check('about section publishes the feedback address',
  /set-feedback-email/.test(views['settings-about'] || '')
  && /mahakammoonlightstudio@gmail\.com/.test(views['settings-about'] || ''));
check('chat welcome renders without a provider', /Start a story/i.test(views.chat || '')
  && /Continue the open chapter/i.test(views.chat || ''));
check('welcome shows exactly four quick-start cards',
  ((views.chat || '').match(/class="welcome-card[" ]/g) || []).length === 4);
check('welcome leads with Connect a model when nothing is connected',
  /welcome-card primary/.test(views.chat || '') && /No model connected yet/.test(views.chat || ''));
check('composer renders an attachment card with name and size', /file-card/.test(views.composerFiles || '')
  && /notes\.md/.test(views.composerFiles || '') && /4 B/.test(views.composerFiles || ''));
check('composer ability row shows tools, thinking and skills',
  /ability-row/.test(views.composerFiles || '') && /Skills \(0\)/.test(views.composerFiles || '')
  && /think-btn/.test(views.composerFiles || ''));
check('composer explains a disabled send', /Type a message or attach a file first/.test(views.composerFiles || ''));
check('composer estimates draft tokens', /~\d+ tok/.test(views.composerDraft || '') && /\d+ words/.test(views.composerDraft || ''));
check('plain-text preview renders the body in a <pre>', /fp-pre/.test(views.filePreviewText || '')
  && /line two/.test(views.filePreviewText || ''));
check('markdown preview renders formatted prose', /fp-md/.test(views.filePreviewMarkdown || '')
  && /<h1>Hi<\/h1>/.test(views.filePreviewMarkdown || ''));
check('thinking control is hidden for a non-reasoning model', !/think-btn/.test(views.composerNoThink || ''));
check('unverified reasoning shows the ? marker', /think-btn/.test(views.composerUnknownThink || '')
  && /think-unknown/.test(views.composerUnknownThink || ''));
check('always mode keeps the switch for a non-reasoning model', /think-btn/.test(views.composerAlwaysThink || '')
  && /support-no/.test(views.composerAlwaysThink || ''));
check('model settings explains an unsupported model', /caps-line/.test(views.modelCapsLine || '')
  && /does not expose reasoning/.test(views.modelCapsLine || ''));
check('model card shows the four capability rows', /caps-card/.test(views.modelCapCardUnknown || '')
  && /Context/.test(views.modelCapCardUnknown || '')
  && /Max output/.test(views.modelCapCardUnknown || '')
  && /Reasoning/.test(views.modelCapCardUnknown || '')
  && /Prompt cache/.test(views.modelCapCardUnknown || ''));
check('model card says unknown instead of inventing a context window',
  /Context window unknown/.test(views.modelCapCardUnknown || '')
  && /<dd>unknown<\/dd>/.test(views.modelCapCardUnknown || '')
  && /Verify/.test(views.modelCapCardUnknown || '')
  && !/~\d/.test(views.modelCapCardUnknown || ''));
check('model profile rows read a probe plus a cache observation',
  /~200k tok/.test(views.modelProfileKnown || '') && /supported/.test(views.modelProfileKnown || '')
  && /up to ~200k tok · explicit breakpoints/.test(views.modelProfileKnown || '')
  && /reused 4096 cached tokens/.test(views.modelProfileKnown || '')
  && /Context window 200000 tokens/.test(views.modelProfileKnown || ''));

// ---------- pure helpers (bundled with esbuild so TS is testable in node) ----------
async function bundleHelper(entry, outfile) {
  await build({
    entryPoints: [path.join(PROJ, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  });
}
const storyHelperFile = path.join(outDir, 'story-data.cjs');
const positionFile = path.join(outDir, 'ui-position.cjs');
const chatFilesHelperFile = path.join(outDir, 'chat-files.cjs');
const settingsIndexFile = path.join(outDir, 'settings-index.cjs');
let helperError = '';
try {
  await bundleHelper('src/lib/storyData.ts', storyHelperFile);
  await bundleHelper('src/lib/uiPosition.ts', positionFile);
  await bundleHelper('src/lib/chatFiles.ts', chatFilesHelperFile);
  await bundleHelper('src/lib/settingsIndex.ts', settingsIndexFile);
} catch (e) {
  helperError = String(e?.message || e);
}
check('pure helper modules bundle', !helperError, helperError);
if (!helperError) {
  const { toStoryArray } = require(storyHelperFile);
  const json = (v) => JSON.stringify(v);
  check('story tags: JSON array parses', json(toStoryArray('["a","b"]')) === '["a","b"]');
  check('story tags: plain comma string parses', json(toStoryArray('fantasy, politics')) === '["fantasy","politics"]');
  check('story tags: JSON-encoded string parses (the crash row)', json(toStoryArray('"fantasy"')) === '["fantasy"]');
  check('story tags: JSON object never becomes a chip', json(toStoryArray('{"a":1}')) === '[]' && json(toStoryArray({ a: 1 })) === '[]');
  check('story tags: null/undefined/number → []', json(toStoryArray(null)) === '[]' && json(toStoryArray(undefined)) === '[]' && json(toStoryArray(7)) === '[]');

  const position = require(positionFile);
  localStorage.removeItem('openplot.position.v1');
  const fresh = position.readPosition();
  check('position: defaults to chat with no ids', fresh.route === 'chat' && fresh.activeChatId === null && fresh.activeProjectId === null, json(fresh));
  position.writePosition({ route: 'story', activeChatId: 'c1', activeProjectId: 'p1' });
  const restored = position.readPosition();
  check('position: round-trips route/chat/project', restored.route === 'story' && restored.activeChatId === 'c1' && restored.activeProjectId === 'p1', json(restored));
  localStorage.setItem('openplot.position.v1', '{not json');
  check('position: corrupt storage falls back safely', position.readPosition().route === 'chat');
  localStorage.setItem('openplot.position.v1', JSON.stringify({ route: '../evil', activeChatId: 42, activeProjectId: 'p2' }));
  const sanitized = position.readPosition();
  check('position: unknown route and non-string ids are dropped', sanitized.route === 'chat' && sanitized.activeChatId === null && sanitized.activeProjectId === 'p2', json(sanitized));
  localStorage.removeItem('openplot.position.v1');

  const chatFiles = require(chatFilesHelperFile);
  check('chat files: formatBytes covers B/KB/MB', chatFiles.formatBytes(4) === '4 B'
    && chatFiles.formatBytes(1536) === '1.5 KB' && chatFiles.formatBytes(1024 * 1024) === '1.0 MB');
  check('chat files: no attachments → no prompt block', chatFiles.buildAttachmentPrompt([]) === null);
  const small = chatFiles.buildAttachmentPrompt([{ name: 'a.txt', kind: 'file', content: 'hello' }]);
  check('chat files: small file is included verbatim', /=== FILE: a\.txt ===/.test(small) && /hello/.test(small)
    && !/truncated/.test(small));
  const long = chatFiles.buildAttachmentPrompt([{ name: 'big.txt', kind: 'file', content: 'a'.repeat(20_000) }]);
  check('chat files: a long file is truncated at 16k chars with a marker',
    /truncated: showing the first 16,000 of 20,000 characters/.test(long));
  const many = chatFiles.buildAttachmentPrompt(
    Array.from({ length: 4 }, (_, i) => ({ name: `p${i}.txt`, kind: 'file', content: 'b'.repeat(16_000) }))
  );
  check('chat files: the 48k total budget omits what does not fit',
    /omitted/.test(many) && /=== FILE: p3\.txt ===/.test(many) && many.indexOf('omitted') > many.indexOf('p2.txt'));

  // Deep links and search results scroll to a DOM id. If an entry names an id
  // that no section renders, the user lands on the right page with no target.
  const settingsIndex = require(settingsIndexFile);
  const missingIds = settingsIndex.SETTINGS_INDEX.filter(
    (entry) => !new RegExp('id="' + entry.id + '"').test(views['settingsA-' + entry.section] || '')
  );
  check('every settings index entry resolves to a rendered control',
    missingIds.length === 0, missingIds.map((e) => e.id).join(','));

  // Highlight cache budget (Task 11): 400 distinct code blocks must not be kept
  // — the cache is bounded by entry count and by bytes.
  const cache = JSON.parse(views.__cache || '{"entries":0,"bytes":0}');
  check('highlight cache: stays under its entry cap', cache.entries <= 300, String(cache.entries));
  check('highlight cache: stays under its byte budget', cache.bytes <= 4 * 1024 * 1024 + 64 * 1024,
    String(cache.bytes));
}

fs.rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL UI RENDER TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
