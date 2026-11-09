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
// The web-tool fixtures run a mock server on 127.0.0.1, which the SSRF guard
// refuses by design. This flag is the documented test-only opt-in; it is read
// once when webtools loads, so the app itself can never enable it.
process.env.OPENPLOT_WEB_ALLOW_LOCAL = '1';
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
const searchRes = parse(executeTool({ name: 'search_story', input: { query: 'crown' } }));
const hits = searchRes.entries || [];
check('search_story finds renamed entry', hits.some((h) => h.title === 'Sunken Crown'), JSON.stringify(hits.map((h) => h.title)));
const kindHits = parse(executeTool({ name: 'search_story', input: { query: 'storm', kind: 'character' } }));
check('search_story kind filter returns none for mismatch', (kindHits.entries || []).length === 0);

// unknown tool → error JSON, never throws
check('unknown tool returns error JSON', !!parse(executeTool({ name: 'nope', input: {} })).error);

// ---------- 4b. attached reference files are visible to the agent ----------
const sera = dbCall('listStory', {}).find((e) => e.title === 'Kael');
dbCall('attachStoryFile', { projectId: projA.id, storyId: sera.id, name: 'kael-notes.md', content: 'Kael was born during the Storm.' });
dbCall('attachStoryFile', { projectId: projA.id, name: 'style-guide.txt', content: 'Past tense, close third.' });
const bible = parse(executeTool({ name: 'read_story_bible', input: { projectId: projA.id } }));
const kaelEntry = bible.entries.find((e) => e.title === 'Kael');
check('read_story_bible lists attachment names', kaelEntry.attachments.includes('kael-notes.md'), JSON.stringify(kaelEntry));
check('read_story_bible lists project-level files', bible.projectFiles.includes('style-guide.txt'));
const fileBody = parse(executeTool({ name: 'read_story_file', input: { name: 'kael-notes.md' } }));
check('read_story_file returns full text by name', /born during the Storm/.test(fileBody.content), JSON.stringify(fileBody).slice(0, 80));
const fileById = parse(executeTool({ name: 'read_story_file', input: { id: fileBody.id } }));
check('read_story_file works by id', fileById.name === 'kael-notes.md');
const searchFile = parse(executeTool({ name: 'search_story', input: { query: 'style-guide' } }));
check('search_story finds a file by name', searchFile.files.some((f) => f.name === 'style-guide.txt'));
const searchFileBody = parse(executeTool({ name: 'search_story', input: { query: 'close third' } }));
check('search_story searches inside attachment text', searchFileBody.files.some((f) => f.name === 'style-guide.txt' && f.matchedIn === 'content'), JSON.stringify(searchFileBody.files));
dbCall('attachStoryFile', { projectId: projA.id, name: 'long.txt', content: 'z'.repeat(61_000) });
const longFile = parse(executeTool({ name: 'read_story_file', input: { name: 'long.txt' } }));
check('read_story_file truncates huge attachments for the context window', longFile.truncated === true && longFile.content.length === 60000, JSON.stringify({ truncated: longFile.truncated, len: longFile.content?.length }));
const projectRead = parse(executeTool({ name: 'read_project', input: { projectId: projA.id } }));
check('read_project lists files', projectRead.files.some((f) => f.name === 'kael-notes.md') && projectRead.files.some((f) => f.name === 'style-guide.txt'));

// ---------- 4c. agent builds a whole project on its own ----------
const madeProj = parse(executeTool({ name: 'create_project', input: { name: 'Agent Novel', format: 'novel', rating: 'teen' } }));
check('create_project returns a usable id', madeProj.ok === true && !!madeProj.id && madeProj.name === 'Agent Novel', JSON.stringify(madeProj));
const madeEntry = parse(executeTool({ name: 'create_story_entry', input: { kind: 'character', title: 'Mira', content: 'the lead', projectId: madeProj.id } }));
const madeChapter = parse(executeTool({ name: 'create_chapter', input: { title: 'Opening', content: 'It began.', projectId: madeProj.id } }));
const madeRow = dbCall('listStory', {}).find((e) => e.id === madeEntry.id);
const madeChapters = dbCall('listChapters', { projectId: madeProj.id });
check('entries and chapters created with the new id land in that project',
  madeRow?.project_id === madeProj.id && madeChapters.length === 1 && madeChapters[0].title === 'Opening',
  JSON.stringify({ project: madeRow?.project_id, chapters: madeChapters.length }));

// ---------- 5. truly empty workspace → friendly error, not a crash ----------
for (const p of dbCall('listProjects', {})) dbCall('deleteProject', { id: p.id });
const noProj = parse(executeTool({ name: 'create_chapter', input: { title: 'Orphan' } }));
check('create_chapter with zero projects returns error JSON', !!noProj.error, JSON.stringify(noProj));
check('the zero-project error tells the model to call create_project', /create_project/.test(noProj.error), noProj.error);
const reboot = parse(executeTool({ name: 'create_project', input: { name: 'Fresh' } }));
const afterCreate = parse(executeTool({ name: 'create_chapter', input: { title: 'Ch 1', projectId: reboot.id } }));
check('a project created mid-run unblocks chapter writes', afterCreate.ok === true, JSON.stringify(afterCreate));

// ---------- 4d. web tools: fetch a real page, search a real endpoint ----------
const { executeToolCall } = require('../dist-electron/tools.js');
const http = await import('node:http');
const webServer = http.createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Field Notes</title><style>.x{color:red}</style></head><body><h1>Kaer</h1><p>Born during the &amp; Storm.</p><script>bad()</script></body></html>');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Kaer wiki', url: 'https://example.com/kaer', text: 'Kaer is the lead.' }] }));
  });
});
await new Promise((r) => webServer.listen(0, '127.0.0.1', r));
const webPort = webServer.address().port;

const noKey = parse(await executeToolCall({ name: 'web_search', input: { query: 'kaer' } }));
check('web_search without a key explains where to add one',
  /Settings/.test(noKey.error || '') && /web_fetch/.test(noKey.error || ''), JSON.stringify(noKey));

dbCall('setSetting', { key: 'webSearchProvider', value: JSON.stringify('exa') });
dbCall('setSetting', { key: 'webSearchApiKey', value: JSON.stringify('test-key') });
dbCall('setSetting', { key: 'webSearchBaseUrl', value: JSON.stringify('http://127.0.0.1:' + webPort + '/search') });

const fetched = parse(await executeToolCall({ name: 'web_fetch', input: { url: 'http://127.0.0.1:' + webPort + '/page' } }));
check('web_fetch returns readable text without scripts or styles',
  /Born during the & Storm/.test(fetched.text || '') && !/bad\(\)|color:red/.test(fetched.text || ''),
  JSON.stringify(fetched).slice(0, 140));
check('web_fetch reports the page title', fetched.title === 'Field Notes', fetched.title);
const badScheme = parse(await executeToolCall({ name: 'web_fetch', input: { url: 'file:///etc/passwd' } }));
check('web_fetch refuses non-http URLs', /http/.test(badScheme.error || ''), JSON.stringify(badScheme));

const found = parse(await executeToolCall({ name: 'web_search', input: { query: 'kaer' } }));
check('web_search maps provider results to title/url/snippet',
  found.results?.[0]?.url === 'https://example.com/kaer' && /lead/.test(found.results[0].snippet || ''),
  JSON.stringify(found).slice(0, 160));
check('web_search passes the query and limit to the provider',
  found.query === 'kaer' && found.results.length === 1, JSON.stringify(found).slice(0, 120));

webServer.close();

// cleanup
closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? 'ALL TOOL TESTS PASSED (' + results.length + ')' : failed + ' CHECK(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
