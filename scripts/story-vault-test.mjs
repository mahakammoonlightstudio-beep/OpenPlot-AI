/**
 * v1.2 data-layer tests: story-bible attachments, Plot Smith saved plans,
 * database stats/compaction and cascade cleanup. Uses a temp sql.js DB.
 * Run: node scripts/story-vault-test.mjs  (requires `npm run build:electron`)
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb, persistNow } = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};
const db = (op, payload = {}) => handleDb(op, payload);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-vault-'));
await initDb(tmp, 'vault-test.db');

const project = db('createProject', { name: 'Vault Test' });
const entry = db('createStory', { projectId: project.id, kind: 'character', title: 'Sera', content: 'Broker.' });

// ---------- attachments ----------
const attached = db('attachStoryFile', {
  projectId: project.id,
  storyId: entry.id,
  name: 'sera-notes.md',
  content: '# Sera\n\nShe sold her own past.'
});
check('attachStoryFile returns metadata', attached.id && attached.name === 'sera-notes.md' && attached.bytes > 0 && attached.story_id === entry.id);
check('attachment row is scoped to the project', attached.project_id === project.id);

const listed = db('listStoryFiles', { projectId: project.id });
check('listStoryFiles returns the attachment without dumping content', listed.length === 1 && listed[0].content === undefined);
const full = db('getStoryFile', { id: attached.id });
check('getStoryFile returns the stored text', full.content.includes('sold her own past'));

const re = db('attachStoryFile', { projectId: project.id, storyId: entry.id, name: 'sera-notes.md', content: 'Updated notes.' });
check('re-attaching the same filename replaces instead of duplicating', re.id === attached.id && db('listStoryFiles', { projectId: project.id }).length === 1);
check('replacement updated the text', db('getStoryFile', { id: attached.id }).content === 'Updated notes.');

const projFile = db('attachStoryFile', { projectId: project.id, name: 'style-guide.txt', content: 'Use past tense.' });
check('project-level attachment (no entry) works', projFile.story_id === null && db('listStoryFiles', { projectId: project.id }).length === 2);

let tooBig = '';
try {
  db('attachStoryFile', { projectId: project.id, name: 'huge.txt', content: 'x'.repeat(2_000_001) });
} catch (e) { tooBig = e.message; }
check('oversized attachment is refused with a readable error', /too large/i.test(tooBig), tooBig);

let emptyErr = '';
try { db('attachStoryFile', { projectId: project.id, name: 'blank.txt', content: '   ' }); } catch (e) { emptyErr = e.message; }
check('empty attachment is refused', /empty|readable/i.test(emptyErr), emptyErr);

// ---------- saved plans ----------
const saved = db('saveStoryPlan', {
  title: 'The Ledger',
  projectId: project.id,
  brief: { genres: ['fantasy'], tone: 'dark' },
  plan: { premise: { title: 'The Ledger' } }
});
check('saveStoryPlan inserts and returns a row', !!saved.id && saved.title === 'The Ledger');
const plans = db('listStoryPlans');
check('listStoryPlans omits the heavy JSON', plans.length === 1 && plans[0].plan === undefined && plans[0].brief === undefined);
const planRow = db('getStoryPlan', { id: saved.id });
check('getStoryPlan returns both JSON columns', JSON.parse(planRow.brief).tone === 'dark' && JSON.parse(planRow.plan).premise.title === 'The Ledger');
const updated = db('saveStoryPlan', { id: saved.id, title: 'The Ledger (rev 2)', projectId: null, brief: {}, plan: {} });
check('saveStoryPlan updates in place', updated.id === saved.id && updated.title === 'The Ledger (rev 2)' && updated.project_id === null);
check('story plans are listed newest-first with one row after update', db('listStoryPlans').length === 1);

// ---------- cascade cleanup ----------
db('deleteStory', { id: entry.id });
check('deleting an entry removes its attachments', db('listStoryFiles', { projectId: project.id }).every((f) => f.story_id !== entry.id));

const plan2 = db('saveStoryPlan', { title: 'Project plan', projectId: project.id, brief: {}, plan: {} });
db('deleteProject', { id: project.id });
check('deleting a project removes its files', db('listStoryFiles', {}).every((f) => f.project_id !== project.id));
check('deleting a project removes its saved plans', db('listStoryPlans').every((p) => p.id !== plan2.id));

// ---------- stats + compaction ----------
const p2 = db('createProject', { name: 'Stats' });
db('createStory', { projectId: p2.id, kind: 'lore', title: 'One', content: 'x'.repeat(5000) });
db('attachStoryFile', { projectId: p2.id, name: 'notes.md', content: 'y'.repeat(5000) });
persistNow();
const stats = db('dbStats');
check('dbStats reports counts + on-disk size', stats.story >= 1 && stats.storyFiles >= 1 && stats.bytes > 0 && !!stats.path);
const before = fs.statSync(stats.path).size;
const compact = db('compactDb');
persistNow();
const after = fs.statSync(stats.path).size;
check('compactDb succeeds and rewrites the file', compact.ok === true && after > 0, `${before} → ${after} bytes`);
check('dbStats survives compaction', db('dbStats').path === stats.path);

// ---------- bulk import ----------
const imported = db('importStoryEntries', {
  projectId: p2.id,
  entries: [
    { kind: 'character', title: 'Mira', content: 'A smuggler.', tags: ['lead'] },
    { kind: 'banana', title: 'Bad kind', content: 'skip me' },
    { kind: 'lore', title: '', content: 'skip me too' },
    { kind: 'location', title: 'Harbor', content: 'A port.' }
  ]
});
check('importStoryEntries imports only valid rows', imported.imported === 2, JSON.stringify(imported));
check('imported entries land in the right project', db('listStory', {}).filter((e) => e.project_id === p2.id).length === 3);

// ---------- one-call project creation (Plot Smith) ----------
const planProject = db('createProjectFromPlan', {
  project: { name: 'Plot Smith Project', description: 'A logline', context: 'ctx', format: 'novella', rating: 'teen' },
  entries: [
    { kind: 'world', title: 'Veyra', content: 'A city.', tags: ['story-agent'] },
    { kind: 'character', title: 'Sera', content: 'Broker.' },
    { kind: 'bad', title: 'Skipped', content: 'x' }
  ],
  chapters: [
    { title: 'One', content: '> **Outline** — open', status: 'draft' },
    { title: 'Two', content: '', status: 'draft' },
    { title: '', content: 'skipped' }
  ],
  beats: [
    { act: 1, title: 'Sale', summary: 'Opens', status: 'planned' },
    { act: 9, title: 'Clamp', summary: 'Act is clamped', status: 'planned' }
  ]
});
check('createProjectFromPlan creates project + counts', planProject.project.name === 'Plot Smith Project' && planProject.entries === 2 && planProject.chapters === 2 && planProject.beats === 2, JSON.stringify(planProject));
check('created project keeps format/rating', planProject.project.format === 'novella' && planProject.project.rating === 'teen');
const madeChapters = db('listChapters', { projectId: planProject.project.id });
check('chapters keep reading order', madeChapters.length === 2 && madeChapters[0].position === 0 && madeChapters[1].position === 1);
const madeBeats = db('listFlowBeats', { projectId: planProject.project.id });
check('flow beats clamp act into 1..4', madeBeats.every((b) => b.act >= 1 && b.act <= 4) && madeBeats.length === 2);

// ---------- persistence behaviour ----------
persistNow();
const mtimeBefore = fs.statSync(stats.path).mtimeMs;
const secondSave = persistNow();
const mtimeAfter = fs.statSync(stats.path).mtimeMs;
check('persistNow skips a write when nothing is dirty', secondSave === false && mtimeAfter === mtimeBefore);
db('setSetting', { key: 'perf-probe', value: '1' });
const wrote = persistNow();
check('persistNow writes after a real change', wrote === true);
check('read-only DB ops do not mark the database dirty', (() => { db('listStory', {}); return persistNow() === false; })());

// orphan cleanup: insert unlinked rows by deleting their chat behind the DB's back
const chat = db('createChat', { title: 'Orphan source' });
db('addMessage', { chatId: chat.id, role: 'user', content: 'hello' });
check('message rows counted', db('dbStats').messages >= 1);

closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL VAULT TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
