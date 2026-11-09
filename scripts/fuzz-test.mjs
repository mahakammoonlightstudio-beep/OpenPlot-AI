/**
 * Fuzz suite for the text parsers that eat user/model data.
 *
 * The parsers already handle the shapes we thought of; this hammers them with
 * the shapes nobody thought of: broken JSON, 10k-deep nesting, megabyte lines,
 * unbalanced CSV quotes, lone surrogates, bidi controls, prototype pollution
 * keys. The assertion is not "returns something pretty" — it is:
 *
 *   no throw, no hang (time budget), a bounded result, and a stable contract
 *   (every entry has string title/content and an allowed kind).
 *
 * Deterministic: the PRNG is seeded, so a failure is reproducible.
 *
 * Run: node scripts/fuzz-test.mjs
 */
import { loadTs } from './lib/load-ts.mjs';

const story = await loadTs('src/lib/storyImport.ts');
const { parseStoryFile, parseStoryFiles, parseMarkdownSections, parseCsvRows, parseJsonEntries, normalizeKind } = story;

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ------------------------------------------------------------------ helpers ---
let seed = 0x2f6e2b1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const NASTY = [
  '', ' ', '\n\n\n', '\u0000', '\u0001\u0002', '\u202E', '\u2028', '\uD800', '\uDFFF',
  'x'.repeat(200_000), '😀'.repeat(20_000), 'a\u0000b', '"', ',,,', '{{{{', '"unclosed',
  '#'.repeat(5_000), '[]', '{}', 'null', 'undefined', 'NaN', 'Infinity', '__proto__',
  'constructor', 'prototype', '{"__proto__":{"pwned":1}}', '<script>alert(1)</script>',
  '\t\t\r\n', 'a,b\nc,d\n', 'Name,Kind\n', ',,,\n,,,'
];

const KINDS = new Set(['world', 'location', 'character', 'item', 'lore']);
const TITLE_CAP = 500;
const ENTRY_CAP = 20_000;
const BUDGET_MS = 600;

/** One parser call under a time budget + contract check. */
function probe(label, fn, { allowThrow = false } = {}) {
  const t0 = performance.now();
  let value;
  let threw = null;
  try { value = fn(); } catch (err) { threw = err; }
  const ms = performance.now() - t0;
  if (threw) return check(`${label}: does not throw`, allowThrow, String(threw?.message || threw).slice(0, 80)) && allowThrow;
  if (ms > BUDGET_MS) return check(`${label}: stays within ${BUDGET_MS}ms`, false, `${ms.toFixed(0)}ms`);
  return { value, ms };
}

// ------------------------------------------------------- 1. junk type inputs ---
{
  const shapes = [null, undefined, 0, -1, NaN, true, {}, [], [null], { name: null, content: null }, { name: 5, content: 5 }];
  const broken = [];
  for (const shape of shapes) {
    for (const forced of [undefined, null, 'character', 'banana', 42]) {
      try {
        const res = parseStoryFile(shape, forced);
        if (!res || !Array.isArray(res.entries)) broken.push(`shape ${JSON.stringify(shape)} → no entries[]`);
      } catch (err) { broken.push(`${JSON.stringify(shape)} → ${err?.message || err}`); }
    }
  }
  check('junk inputs never throw and always return entries[]', broken.length === 0, broken.slice(0, 3).join(' | '));
}

// ---------------------------------------------------- 2. random byte-ish fuzz ---
{
  const failures = [];
  for (let i = 0; i < 400; i++) {
    const len = Math.floor(rnd() * 6);
    let body = '';
    for (let j = 0; j < len; j++) body += pick(NASTY);
    const name = pick(['f.md', 'f.json', 'f.csv', 'f.txt', '', 'x'.repeat(300)]);
    const t0 = performance.now();
    try {
      const res = parseStoryFile({ name, content: body }, pick([undefined, 'lore', 'banana']));
      const ms = performance.now() - t0;
      if (!res || !Array.isArray(res.entries)) failures.push('no entries[]');
      else if (res.entries.length > ENTRY_CAP) failures.push('unbounded entries: ' + res.entries.length);
      else if (res.entries.some((e) => typeof e.title !== 'string' || typeof e.content !== 'string')) failures.push('non-string field');
      else if (res.entries.some((e) => !KINDS.has(e.kind))) failures.push('invalid kind');
      else if (res.entries.some((e) => e.title.length > TITLE_CAP)) failures.push('unbounded title');
      if (ms > BUDGET_MS) failures.push('slow: ' + ms.toFixed(0) + 'ms');
    } catch (err) {
      failures.push(String(err?.message || err).slice(0, 60));
    }
    if (failures.length > 3) break;
  }
  check('400 random documents keep the parser contract', failures.length === 0, failures.slice(0, 3).join(' | '));
}

// -------------------------------------------------------- 3. hostile JSON ---
{
  const cases = {
    'deep nesting (5k)': '['.repeat(5000) + ']'.repeat(5000),
    'unbalanced': '{"entries": [{"title": ',
    'single huge array': JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ title: `t${i}`, content: `c${i}` }))),
    'proto pollution': '{"__proto__":{"pwned":1},"entries":[{"__proto__":{"x":1},"title":"t","content":"c","kind":"lore"}]}',
    'wrong types': '{"entries":[{"title":{},"content":[],"kind":42},null,1,"x"]}',
    'bom + trailing garbage': '\uFEFF{"entries":[{"title":"t","content":"c"}]} tail',
    'nan/infinity': '{"entries":[{"title":NaN,"content":Infinity}]}',
    'duplicate keys': '{"entries":[{"title":"a","title":"b","content":"c"}],"entries":[]}'
  };
  const failures = [];
  for (const [label, raw] of Object.entries(cases)) {
    const t0 = performance.now();
    try {
      const rows = parseJsonEntries(raw, 'lore');
      const ms = performance.now() - t0;
      if (!Array.isArray(rows)) failures.push(`${label}: not an array`);
      else if (rows.length > ENTRY_CAP) failures.push(`${label}: unbounded (${rows.length})`);
      else if (rows.some((r) => typeof r.title !== 'string' || typeof r.content !== 'string')) failures.push(`${label}: bad field types`);
      if (ms > BUDGET_MS) failures.push(`${label}: ${ms.toFixed(0)}ms`);
    } catch (err) { failures.push(`${label}: ${err?.message || err}`); }
  }
  check('hostile JSON never throws and stays bounded', failures.length === 0, failures.slice(0, 3).join(' | '));
  check('JSON fuzz cannot pollute Object.prototype', ({}).pwned === undefined);
}

// ------------------------------------------------------------ 4. CSV fuzz ---
{
  const csv = [
    '"unclosed,quote',
    'a,b\n"x,y\nz',
    Array.from({ length: 5000 }, (_, i) => `t${i},c${i}`).join('\n'),
    'title,content,kind\n"quoted""escape",value,character\n,,,\n',
    '\u0000,\u0001\n\r\n,\n',
    ';'.repeat(10_000),
    'name;kind\nA;lore\nB;banana\n'
  ];
  const failures = [];
  for (const raw of csv) {
    const t0 = performance.now();
    try {
      const rows = parseCsvRows(raw);
      const ms = performance.now() - t0;
      if (!Array.isArray(rows)) failures.push('not an array');
      else if (rows.length > ENTRY_CAP) failures.push('unbounded rows');
      if (ms > BUDGET_MS) failures.push('slow: ' + ms.toFixed(0) + 'ms');
    } catch (err) { failures.push(String(err?.message || err).slice(0, 60)); }
  }
  check('hostile CSV never throws and stays bounded', failures.length === 0, failures.slice(0, 3).join(' | '));
}

// ------------------------------------------------------- 5. Markdown fuzz ---
{
  const docs = [
    '# '.repeat(5000),
    '#'.repeat(5000) + ' heading',
    '```\n# not a heading\n' + 'x'.repeat(100_000),
    '\u202E# reversed\n\u202C',
    Array.from({ length: 3000 }, (_, i) => `# Entry ${i}\nbody ${i}`).join('\n\n'),
    '   \n\n\t\n'
  ];
  const failures = [];
  for (const raw of docs) {
    const t0 = performance.now();
    try {
      const sections = parseMarkdownSections(raw, 'Notes');
      const ms = performance.now() - t0;
      if (!Array.isArray(sections)) failures.push('not an array');
      else if (sections.some((s) => typeof s.title !== 'string' || typeof s.content !== 'string')) failures.push('bad section types');
      if (ms > BUDGET_MS) failures.push('slow: ' + ms.toFixed(0) + 'ms');
    } catch (err) { failures.push(String(err?.message || err).slice(0, 60)); }
  }
  check('hostile markdown never throws', failures.length === 0, failures.slice(0, 3).join(' | '));
}

// ------------------------------------------------ 6. batch + normalisation ---
{
  const batch = Array.from({ length: 60 }, (_, i) => ({
    name: pick(['a.md', 'b.json', 'c.csv', 'd.txt', '', 'x'.repeat(200)]),
    content: pick(NASTY)
  }));
  const t0 = performance.now();
  let ok = true;
  try {
    const res = parseStoryFiles(batch, 'lore');
    ok = !!res && Array.isArray(res.entries) && res.entries.every((e) => KINDS.has(e.kind));
  } catch { ok = false; }
  check('60-file batch stays valid', ok, `${(performance.now() - t0).toFixed(0)}ms`);

  const junk = ['', ' ', '__proto__', 'constructor', 'CHARACTERS', 'Lokasi', 'banana', null, 42];
  const clean = junk.every((k) => { const v = normalizeKind(k); return v === null || KINDS.has(v); });
  check('normalizeKind only ever returns a real kind or null', clean);
  check('normalizeKind cannot be used for prototype access', normalizeKind('__proto__') === null);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL FUZZ CHECKS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
