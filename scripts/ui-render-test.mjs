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
    logLevel: 'silent'
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
check('chat welcome renders without a provider', /New Chat|Welcome/i.test(views.chat || ''));

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
let helperError = '';
try {
  await bundleHelper('src/lib/storyData.ts', storyHelperFile);
  await bundleHelper('src/lib/uiPosition.ts', positionFile);
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
}

fs.rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL UI RENDER TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
