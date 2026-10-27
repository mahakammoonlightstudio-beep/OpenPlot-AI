/**
 * In-app guide tests (v1.2.3 Task 9).
 *
 * The guide ships as Markdown files, and the parser is the only thing that
 * decides what they mean — so this test reads the real files from disk and runs
 * them through the same TypeScript module the app bundles:
 *   - every article parses with a title, summary and order,
 *   - EN and ID cover the same slugs (no blank pages after a language switch),
 *   - every [[settings:…]] / [[route:…]] / [[guide:…]] token resolves,
 *   - token rewriting round-trips through the click parser,
 *   - search finds "cache" in both languages and ranks title hits first,
 *   - a missing translation falls back to English with a badge flag,
 *   - the guide/shortcut/whatsnew chrome exists in both dictionaries.
 *
 * Run: node scripts/guide-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const {
  parseArticle, sortDocs, articleList, resolveArticle, neighbours,
  searchGuide, rewriteTokens, parseActionHref, tokensIn, headingId
} = await loadTs('src/guide/content.ts');
const { SETTINGS_SECTIONS } = await loadTs('src/lib/settingsIndex.ts');
const { SHORTCUTS } = await loadTs('src/lib/shortcuts.ts');
const { dictionaries } = await loadTs('src/i18n.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const ROOT = path.resolve(import.meta.dirname, '..', 'src', 'guide');
const readLang = (lang) => Object.fromEntries(
  fs.readdirSync(path.join(ROOT, lang))
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const slug = f.replace(/\.md$/, '');
      return [slug, parseArticle(slug, fs.readFileSync(path.join(ROOT, lang, f), 'utf8'))];
    })
);

const EN = readLang('en');
const ID = readLang('id');
const enDocs = sortDocs(Object.values(EN));
const idDocs = sortDocs(Object.values(ID));
const sets = { en: enDocs, id: idDocs };

// ---------------------------------------------------------------- structure ---
check('articles: 19 English articles', enDocs.length === 19, String(enDocs.length));
check('articles: 19 Indonesian articles', idDocs.length === 19, String(idDocs.length));
check('articles: slugs match across languages',
  enDocs.map((d) => d.slug).join(',') === idDocs.map((d) => d.slug).join(','));
check('articles: no article is empty', enDocs.every((d) => d.body.length > 300 && d.headings.length >= 2),
  enDocs.filter((d) => d.body.length <= 300 || d.headings.length < 2).map((d) => d.slug).join(','));
check('articles: every article has title + summary + order',
  [...enDocs, ...idDocs].every((d) => d.title && d.title !== d.slug && d.summary && d.order < 999));
check('articles: order is unique and starts at 1',
  new Set(enDocs.map((d) => d.order)).size === 19 && enDocs[0].order === 1 && enDocs.at(-1).order === 19);
check('articles: headings get stable ids', headingId('Same Title') === 'same-title'
  && headingId('Cache & Tokens') === 'cache-tokens');
const seen = new Set();
const ids = ['Rules', 'Rules', 'Rules'].map((t) => headingId(t, seen));
check('articles: duplicate headings get numbered ids', ids.join(',') === 'rules,rules-2,rules-3', ids.join(','));

// ------------------------------------------------------------------- tokens ---
const settingsIds = new Set(SETTINGS_SECTIONS);
const routes = new Set(['chat', 'story', 'agent', 'flow', 'chapters', 'projects', 'stats', 'settings', 'about', 'guide']);
const guides = new Set(enDocs.map((d) => d.slug));
const bad = [];
for (const [lang, docs] of [['en', enDocs], ['id', idDocs]]) {
  for (const doc of docs) {
    for (const tok of tokensIn(doc.body)) {
      const ok = tok.kind === 'settings' ? settingsIds.has(tok.target)
        : tok.kind === 'route' ? routes.has(tok.target)
          : guides.has(tok.target);
      if (!ok) bad.push(`${lang}/${doc.slug}: ${tok.kind}:${tok.target}`);
    }
  }
}
check('tokens: every in-app token resolves', bad.length === 0, bad.join(', '));
check('tokens: the guide actually links around', enDocs.some((d) => tokensIn(d.body).length >= 2));

const rewritten = rewriteTokens('See [[settings:skills]] and [[route:flow]].', (t) => `${t.kind}:${t.target}`);
check('tokens: rewritten to hash links the sanitizer keeps', /\]\(#guide-action-settings:skills\)/.test(rewritten));
const href = rewritten.match(/\((#guide-action-[^)]+)\)/)[1];
const parsed = parseActionHref(href);
check('tokens: click parser round-trips', parsed?.kind === 'settings' && parsed?.target === 'skills', href);
check('tokens: foreign links are ignored', parseActionHref('https://example.com') === null && parseActionHref('#guide/skills') === null);

// ------------------------------------------------------------------- search ---
const enList = articleList('en', sets);
const idList = articleList('id', sets);
const enCache = searchGuide('cache', enList);
const idCache = searchGuide('cache', idList);
check('search: finds "cache" in English', enCache.length > 0 && enCache[0].slug === 'models-and-cache', enCache.map((h) => h.slug).join(','));
check('search: finds "cache" in Indonesian', idCache.length > 0, idCache.map((h) => h.slug).join(','));
check('search: two characters are required', searchGuide('c', enList).length === 0);
check('search: title hits outrank body hits',
  searchGuide('skills', enList)[0].slug === 'skills', searchGuide('skills', enList).map((h) => h.slug + ':' + h.score).join(','));
check('search: hits carry a readable snippet', enCache.every((h) => h.snippet.length > 0 && h.snippet.length < 200));
check('search: nonsense finds nothing', searchGuide('zzqqxx', enList).length === 0);

// ------------------------------------------------------------ language flow ---
const translated = resolveArticle('skills', 'id', sets);
check('language: Indonesian resolves to the ID article', translated?.lang === 'id' && !translated?.fallback
  && translated.title === 'Skill', translated?.title);
const missing = { en: enDocs, id: idDocs.filter((d) => d.slug !== 'files') };
const fallback = resolveArticle('files', 'id', missing);
check('language: a missing translation falls back to English with a badge', fallback?.lang === 'en' && fallback?.fallback === true);
const fallbackList = articleList('id', missing);
check('language: the article list marks untranslated entries', fallbackList.find((d) => d.slug === 'files')?.fallback === true
  && fallbackList.find((d) => d.slug === 'files')?.title === 'Files in chat');
check('language: unknown slug resolves to null', resolveArticle('nope', 'en', sets) === null);

const nav = neighbours('skills', enList);
check('navigation: prev/next follow the reading order',
  nav.prev?.slug === 'thinking' && nav.next?.slug === 'agent-md',
  `${nav.prev?.slug} < skills > ${nav.next?.slug}`);
check('navigation: the first article has no previous',
  neighbours('getting-started', enList).prev === null);

// ----------------------------------------------------------------- shortcut ---
const shortcutIds = SHORTCUTS.map((s) => s.id);
check('shortcuts: registry ids are unique', new Set(shortcutIds).size === shortcutIds.length);
check('shortcuts: every shortcut has a label in both dictionaries',
  SHORTCUTS.every((s) => dictionaries.en[s.labelKey] && dictionaries.id[s.labelKey]),
  SHORTCUTS.filter((s) => !dictionaries.en[s.labelKey] || !dictionaries.id[s.labelKey]).map((s) => s.labelKey).join(','));
check('shortcuts: the guide documents the same keys',
  SHORTCUTS.every((s) => EN.shortcuts.body.includes(s.keys[0]) || ID.shortcuts.body.includes(s.keys[0])),
  SHORTCUTS.filter((s) => !EN.shortcuts.body.includes(s.keys[0])).map((s) => s.id).join(','));

// ------------------------------------------------------------------- chrome ---
const chrome = [
  'guide.title', 'guide.sub', 'guide.search', 'guide.notTranslated', 'guide.onThisPage',
  'guide.prev', 'guide.next', 'guide.copyLink',
  'shortcut.title', 'shortcut.hint', 'shortcut.group.global', 'shortcut.group.composer',
  'whatsnew.title', 'whatsnew.sub', 'whatsnew.showMe', 'whatsnew.start'
];
const missingChrome = chrome.filter((k) => !dictionaries.en[k] || !dictionaries.id[k]);
check('chrome: guide + sheet + what\'s new exist in both languages', missingChrome.length === 0, missingChrome.join(','));
const untranslated = ['guide.title', 'guide.search', 'whatsnew.title', 'shortcut.title']
  .filter((k) => dictionaries.id[k] === dictionaries.en[k]);
check('chrome: Indonesian chrome is actually translated', untranslated.length === 0, untranslated.join(','));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL GUIDE TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
