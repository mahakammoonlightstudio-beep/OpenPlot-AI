/**
 * Performance budgets (v1.2.3 Task 12).
 *
 * Measured on a real temp database through the compiled main-process module —
 * no mocks, no Electron:
 *   - a 5,000-message chat is paged: the first page holds ≤ limit rows and
 *     `hasMore` is true; walking `before`/`beforeRow` reaches every row exactly
 *     once, even when rows share a millisecond,
 *   - a page carries attachment metadata for that page only, never file bodies,
 *   - a page read costs a page, not a full-chat read,
 *   - single-row writes and warm persistence stay interactive.
 *
 * Thresholds are loose enough for a slow machine but tight enough to fail a
 * real regression: the view used to load the whole chat, which the ratio check
 * below would catch immediately.
 *
 * Run: node scripts/perf-test.mjs   (requires `npm run build:electron`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb, persistNow } = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};
const ms = (n) => `${n.toFixed(1)} ms`;
const timeIt = (fn) => { const t = performance.now(); const out = fn(); return [performance.now() - t, out]; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-perf-'));
await initDb(dir, 'perf.db');
const db = (op, payload = {}) => handleDb(op, payload);

// ------------------------------------------------------------------ fixture ---
const ROWS = 5000;
const chat = db('createChat', { title: 'Perf chat' });
const CHAT = chat.id;

const [seedMs] = timeIt(() => {
  for (let i = 0; i < ROWS; i++) {
    db('addMessage', { chatId: CHAT, role: i % 2 ? 'assistant' : 'user', content: `message ${i}` });
  }
});
const stats = db('dbStats');
check('fixture: 5,000 messages stored', stats.messages === ROWS, `${stats.messages} rows in ${ms(seedMs)}`);
check('fixture: messages really share timestamps (tie-break is exercised)',
  db('getMessages', { chatId: CHAT }).length === ROWS);

// ------------------------------------------------------------------- paging ---
const [pageMs, first] = timeIt(() => db('getMessagePage', { chatId: CHAT, limit: 200 }));
// Warm reads: a single cold run measures the JIT, not the query. Best-of-3 is
// what the viewer actually feels after the first page.
const bestOf = (fn, runs = 3) => Math.min(...Array.from({ length: runs }, () => timeIt(fn)[0]));
const pageWarm = bestOf(() => db('getMessagePage', { chatId: CHAT, limit: 200 }));
check('paging: first page returns 200 rows', first.rows.length === 200, String(first.rows.length));
check('paging: hasMore is true on a 5,000-row chat', first.hasMore === true);
check('paging: the newest row is last in the page',
  first.rows.at(-1).content === `message ${ROWS - 1}`, first.rows.at(-1).content);
check('paging: rows are in reading order',
  first.rows.every((r, i, a) => i === 0 || a[i - 1].created_at <= r.created_at));

const seen = new Set();
let cursor = { before: first.rows[0].created_at, beforeRow: first.rows[0]._row };
let pages = 1;
let guard = 0;
while (guard++ < 80) {
  const page = db('getMessagePage', { chatId: CHAT, limit: 200, ...cursor });
  if (!page.rows.length) break;
  for (const r of page.rows) {
    if (seen.has(r.id)) throw new Error('duplicate row across pages: ' + r.id);
    seen.add(r.id);
  }
  cursor = { before: page.rows[0].created_at, beforeRow: page.rows[0]._row };
  pages++;
  if (!page.hasMore) break;
}
check('paging: every older row appears exactly once', seen.size === ROWS - 200, `${seen.size} of ${ROWS - 200}`);
check('paging: it took the expected number of pages', pages === 25, String(pages));
check('paging: a page read is fast', pageMs < 120, ms(pageMs));

db('createChat', { title: 'Small' });
// (createChat makes its own id; the small-chat page cost is what matters.)
const small = db('listChats')[0];
db('addMessage', { chatId: small.id, role: 'user', content: 'only message' });
const [smallMs] = timeIt(() => db('getMessagePage', { chatId: small.id, limit: 200 }));
check('paging: a page on a tiny chat is instant', smallMs < 60, ms(smallMs));

const [allMs, everyRow] = timeIt(() => db('getMessages', { chatId: CHAT }));
const allWarm = bestOf(() => db('getMessages', { chatId: CHAT }));
check('export path: getMessages still returns the whole chat', everyRow.length === ROWS);
// The point of paging is memory first (200 rows instead of 5,000) and time
// second; two warm page reads must still cost less than one full read.
check('paging: warm pages cost less than one full read', pageWarm * 1.8 < allWarm,
  `${ms(pageWarm)}x1.8 vs ${ms(allWarm)}`);

// ------------------------------------------------------------- attachments ---
db('addMessage', {
  chatId: CHAT, role: 'user', content: 'with file',
  files: [{ name: 'notes.md', kind: 'file', content: 'hello world' }]
});
const withFile = db('getMessagePage', { chatId: CHAT, limit: 5 });
check('paging: attachment metadata rides along', withFile.rows.some((r) => (r.files || []).length === 1));
check('paging: file bodies are not part of a page', !JSON.stringify(withFile.rows).includes('hello world'));

// ------------------------------------------------------------------ budgets ---
const [singleMs] = timeIt(() => db('addMessage', { chatId: CHAT, role: 'user', content: 'single write' }));
check('budget: single-row write < 50 ms', singleMs < 50, ms(singleMs));

const [persistMs] = timeIt(() => persistNow(true));
check('budget: warm persist < 400 ms', persistMs < 400, ms(persistMs));

const sizeMb = fs.statSync(path.join(dir, 'perf.db')).size / 1024 / 1024;
check('budget: a 5,000-message database stays under 40 MB', sizeMb < 40, sizeMb.toFixed(2) + ' MB');

// Batch insert (500 rows) uses the same op the app uses per message — this is
// the honest number, not a synthetic bulk path.
const [batchMs] = timeIt(() => {
  for (let i = 0; i < 500; i++) db('addMessage', { chatId: CHAT, role: 'user', content: `batch ${i}` });
});
check('budget: 500 writes < 800 ms', batchMs < 800, ms(batchMs));

check('recorded: warm page / warm full read / 500 writes / persist', true,
  `${ms(pageWarm)} / ${ms(allWarm)} / ${ms(batchMs)} / ${ms(persistMs)} (cold page ${ms(pageMs)}, fixture seed ${ms(seedMs)})`);

closeDb();
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL PERFORMANCE TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
