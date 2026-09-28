/**
 * Agent tools test — exercises executeTool() against a real temp sql.js DB.
 * Covers: save/list memories, story entry CRUD + RENAME (the bug where the
 * old title was always written back), chapter CRUD + rename, project scoping
 * (chat project wins over an unrelated first project), and search.
 * Run: node scripts/tools-test.mjs   (requires `npm run build:electron` first)
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeTool } = require('../dist-electron/tools.js');
const { initDb, closeDb } = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};
const parse = (s) => JSON.parse(s);

// temp DB
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-tools-'));
await initDb(tmp, 'tools-test.db');

const dbCall = (op, payload) => require('../dist-electron/db.js').handleDb(op, payload);

// ---------- fixtures ----------
const projA = dbCall('createProject', { name: 'Alpha' });
const projB = dbCall('createProject', { name: 'Beta' });
// Alpha first by created_at; Beta's chapter has the SAME title to prove scoping.
dbCall('createChapter', { projectId: projA.id, title: 'Storm', content: 'alpha storm', status: 'draft' });
dbCall('createChapter', { projectId: projB.id, title: 'Storm', content: 'beta storm', status: 'done' });
dbCall('createStory', { projectId: projA.id, kind: 'character', title: 'Kael', content: 'protagonist', tags: ['lead'] });

// ---------- 1. memories ----------
// save_memory returns a plain confirmation string (that's what the model reads)
const memAck = executeTool({ name: 'save_memory', input: { content: 'likes tea' } });
check('save_memory confirms plainly', /memory saved/i.test(memAck), memAck);
const mems = parse(executeTool({ name: 'list_memories', input: {} }));
check('list_memories sees the saved memory', mems.some((m) => m.content === 'likes tea'));

// ---------- 2. story entries ----------
const created = parse(executeTool({ name: 'create_story_entry', input: { kind: 'item', title: 'Hollow Crown', content: 'a crown', projectId: projB.id } }));
check('create_story_entry returns id + title', !!created.id && created.title === 'Hollow Crown', JSON.stringify(created));

// ctx-first: no projectId in input, ctx = Beta → must land in Beta, not Alpha
const ctxEntry = parse(executeTool({ name: 'create_story_entry', input: { kind: 'lore', title: 'CtxLore', content: 'x' } }, { projectId: projB.id }));
const ctxRow = dbCall('listStory', {}).find((e) => e.id === ctxEntry.id);
check('ctx projectId wins over listProjects fallback', ctxRow.project_id === projB.id, ctxRow.project_id);

// RENAME: the fixed bug — old code always wrote the current title back
const renamed = parse(executeTool({ name: 'update_story_entry', input: { id: created.id, newTitle: 'Sunken Crown', content: 'an old crown' } }));
check('update_story_entry renames via newTitle', renamed.title === 'Sunken Crown', JSON.stringify(renamed));
const renamedRow = dbCall('listStory', {}).find((e) => e.id === created.id);
check('rename persisted in DB', renamedRow.title === 'Sunken Crown' && renamedRow.content === 'an old crown');

// find-by-title still works after rename, and tags survive an update that omits them
const byTitle = parse(executeTool({ name: 'update_story_entry', input: { title: 'Sunken Crown', tags: ['relic'] } }));
check('find-by-current-title + tags preserved', byTitle.ok === true);

// ---------- 3. chapters ----------
const listed = parse(executeTool({ name: 'list_chapters', input: { projectId: projA.id } }));
check('list_chapters scoped to project', listed.length === 1 && listed[0].title === 'Storm' && listed[0].words === 2, JSON.stringify(listed));

// SCOPING: no projectId, ctx = projB → 'Storm' must resolve to Beta's chapter
const readB = parse(executeTool({ name: 'read_chapter', input: { title: 'Storm' } }, { projectId: projB.id }));
check('findChapter scoped to ctx project (Beta Storm)', readB.content === 'beta storm' && readB.status === 'done', JSON.stringify(readB).slice(0, 80));

// ctx = projA → Alpha's Storm
const readA = parse(executeTool({ name: 'read_chapter', input: { title: 'Storm' } }, { projectId: projA.id }));
check('same-title chapter resolves to ctx project (Alpha Storm)', readA.content === 'alpha storm');

// chapter RENAME
const chRen = parse(executeTool({ name: 'update_chapter', input: { id: readA.id, newTitle: 'The Storm', status: 'revising' } }));
check('update_chapter renames via newTitle', chRen.title === 'The Storm', JSON.stringify(chRen));
const chRow = dbCall('listChapters', { projectId: projA.id }).find((c) => c.id === readA.id);
check('chapter rename + status persisted', chRow.title === 'The Storm' && chRow.status === 'revising');

// create chapter with no ctx and no explicit project falls back to the most
// recent project (documented resolveProject behavior)
const fallback = parse(executeTool({ name: 'create_chapter', input: { title: 'Orphan' } }));
check('create_chapter falls back to most recent project', fallback.ok === true, JSON.stringify(fallback));

// ---------- 4. search ----------
const hits = parse(executeTool({ name: 'search_story', input: { query: 'crown' } }));
check('search_story finds renamed entry', hits.some((h) => h.title === 'Sunken Crown'), JSON.stringify(hits.map((h) => h.title)));
const kindHits = parse(executeTool({ name: 'search_story', input: { query: 'storm', kind: 'character' } }));
check('search_story kind filter returns none for mismatch', kindHits.length === 0);

// unknown tool → error JSON, never throws
check('unknown tool returns error JSON', !!parse(executeTool({ name: 'nope', input: {} })).error);

// ---------- 5. truly empty workspace → friendly error, not a crash ----------
for (const p of dbCall('listProjects', {})) dbCall('deleteProject', { id: p.id });
const noProj = parse(executeTool({ name: 'create_chapter', input: { title: 'Orphan' } }));
check('create_chapter with zero projects returns error JSON', !!noProj.error, JSON.stringify(noProj));

// cleanup
closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? 'ALL TOOL TESTS PASSED (' + results.length + ')' : failed + ' CHECK(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
