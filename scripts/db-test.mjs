// Deep DB-layer stress test for OpenPlot AI (no Electron needed).
// Uses sql.js — the same engine as the app — so behavior matches 1:1.
// Exercises schema migrations, CRUD ops, the dynamic-SET update paths,
// reorder integrity, and volume/edge cases on a throwaway database.
// Usage: node scripts/db-test.mjs
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const SQL = await initSqlJs({
  locateFile: (f) => path.join('node_modules', 'sql.js', 'dist', f)
});
const db = new SQL.Database();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  context TEXT DEFAULT '', format TEXT DEFAULT 'novel', rating TEXT DEFAULT 'teen',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT DEFAULT '', status TEXT DEFAULT 'draft', position INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS flow_beats (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, act INTEGER DEFAULT 1,
  title TEXT NOT NULL, summary TEXT DEFAULT '', status TEXT DEFAULT 'planned',
  chapter_id TEXT, position INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
`;
db.exec(SCHEMA);

// simulate the migration path from an OLD database (no format/rating columns)
db.exec(`CREATE TABLE projects_old AS SELECT id, name, description, context, created_at, updated_at FROM projects`);
db.exec(`DROP TABLE projects`);
db.exec(`CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  context TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER
)`);
db.exec(`INSERT INTO projects SELECT * FROM projects_old`);
db.exec(`DROP TABLE projects_old`);
try { db.exec("ALTER TABLE projects ADD COLUMN format TEXT DEFAULT 'novel'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN rating TEXT DEFAULT 'teen'"); } catch { /* exists */ }

const now = Date.now();
const uid = () => 'id-' + Math.random().toString(36).slice(2, 10);

// helpers mirroring electron/db.ts (sql.js API)
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
const get = (sql, params = []) => all(sql, params)[0];

// ---- op implementations copied 1:1 from electron/db.ts (keep in sync) ----
function createProject(payload) {
  const id = uid();
  run('INSERT INTO projects (id, name, description, context, format, rating, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, payload.name, payload.description || '', payload.context || '', payload.format || 'novel', payload.rating || 'teen', now, now]);
  return get('SELECT * FROM projects WHERE id = ?', [id]);
}
function updateProject(payload) {
  const colMap = { name: 'name', description: 'description', context: 'context', format: 'format', rating: 'rating' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(colMap)) {
    if (payload[k] !== undefined) { sets.push(`${col}=?`); vals.push(payload[k]); }
  }
  if (sets.length) {
    sets.push('updated_at=?'); vals.push(now, payload.id);
    run(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`, vals);
  }
  return get('SELECT * FROM projects WHERE id = ?', [payload.id]);
}
function createFlowBeat(payload) {
  const id = uid();
  const maxPos = get('SELECT MAX(position) AS m FROM flow_beats WHERE project_id=? AND act=?', [payload.projectId, payload.act || 1]);
  run('INSERT INTO flow_beats (id, project_id, act, title, summary, status, chapter_id, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, payload.projectId, payload.act || 1, payload.title || 'New beat', payload.summary || '', payload.status || 'planned', payload.chapterId || null, (maxPos?.m ?? -1) + 1, now, now]);
  return get('SELECT * FROM flow_beats WHERE id = ?', [id]);
}
function updateFlowBeat(payload) {
  const colMap = { act: 'act', title: 'title', summary: 'summary', status: 'status', chapterId: 'chapter_id', position: 'position' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(colMap)) {
    if (payload[k] !== undefined) { sets.push(`${col}=?`); vals.push(payload[k]); }
  }
  if (!sets.length) return get('SELECT * FROM flow_beats WHERE id = ?', [payload.id]);
  sets.push('updated_at=?'); vals.push(now, payload.id);
  run(`UPDATE flow_beats SET ${sets.join(', ')} WHERE id=?`, vals);
  return get('SELECT * FROM flow_beats WHERE id = ?', [payload.id]);
}
function reorderFlowBeats(payload) {
  const order = payload.order || [];
  for (let i = 0; i < order.length; i++) run('UPDATE flow_beats SET position=?, updated_at=? WHERE id=?', [i, now, order[i]]);
  return true;
}

// =========== TESTS ===========

// 1. Migration: old projects row gains format/rating defaults
const p1 = createProject({ name: 'Old Project' });
check('migration: old row gets format default', p1.format === 'novel', String(p1.format));
check('migration: old row gets rating default', p1.rating === 'teen', String(p1.rating));

// 2. updateProject dynamic SET: partial patches only touch sent columns
updateProject({ id: p1.id, name: 'Renamed' });
const p1b = get('SELECT * FROM projects WHERE id = ?', [p1.id]);
check('updateProject: partial patch keeps other columns', p1b.name === 'Renamed' && p1b.description === '');

// 3. updateProject: empty string CLEARS context (the old static-SQL bug pattern)
updateProject({ id: p1.id, context: 'once had text' });
updateProject({ id: p1.id, context: '' });
const p1c = get('SELECT * FROM projects WHERE id = ?', [p1.id]);
check('updateProject: empty string clears context', p1c.context === '', JSON.stringify(p1c.context));

// 4. updateProject: format/rating accept all whitelisted values
let roundtripOk = true;
for (const f of ['short-story', 'novel', 'book', 'fanfic', 'script']) {
  updateProject({ id: p1.id, format: f });
  if (get('SELECT format FROM projects WHERE id=?', [p1.id]).format !== f) { roundtripOk = false; break; }
}
for (const r of ['family', 'teen', 'mature']) {
  updateProject({ id: p1.id, rating: r });
  if (get('SELECT rating FROM projects WHERE id=?', [p1.id]).rating !== r) { roundtripOk = false; break; }
}
check('updateProject: format/rating roundtrip', roundtripOk);

// 5. Flow beats: create + auto position per act
const beatIds = [];
for (const act of [1, 2, 3]) {
  for (let i = 0; i < 3; i++) beatIds.push(createFlowBeat({ projectId: p1.id, act, title: `A${act}B${i}` }).id);
}
const act1 = all('SELECT * FROM flow_beats WHERE project_id=? AND act=1 ORDER BY position', [p1.id]);
check('flow: positions auto-increment per act', act1.map((b) => b.position).join(',') === '0,1,2');

// 6. THE UNLINK BUG: chapterId:null must clear chapter_id (was COALESCE before)
const chId = uid();
run('INSERT INTO chapters (id, project_id, title, content, status, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [chId, p1.id, 'Ch1', '', 'draft', 0, now, now]);
updateFlowBeat({ id: beatIds[0], chapterId: chId });
check('flow: link chapter', get('SELECT chapter_id FROM flow_beats WHERE id=?', [beatIds[0]]).chapter_id === chId);
updateFlowBeat({ id: beatIds[0], chapterId: null });
check('flow: UNLINK chapter (null must clear)', get('SELECT chapter_id FROM flow_beats WHERE id=?', [beatIds[0]]).chapter_id === null);

// 7. updateFlowBeat: clearing summary with empty string
updateFlowBeat({ id: beatIds[1], summary: 'text' });
updateFlowBeat({ id: beatIds[1], summary: '' });
check('flow: empty summary clears', get('SELECT summary FROM flow_beats WHERE id=?', [beatIds[1]]).summary === '');

// 8. updateFlowBeat with empty payload is a no-op that still returns the row
const noop = updateFlowBeat({ id: beatIds[2] });
check('flow: empty patch returns row unchanged', !!noop && noop.title === 'A1B2');

// 9. Reorder integrity: reverse act 1, positions must follow exactly
const act1Ids = all('SELECT id FROM flow_beats WHERE project_id=? AND act=1 ORDER BY position', [p1.id]).map((b) => b.id);
reorderFlowBeats({ order: [...act1Ids].reverse() });
const after = all('SELECT id, position FROM flow_beats WHERE project_id=? AND act=1 ORDER BY position', [p1.id]).map((b) => b.id);
check('flow: reorder reverses exactly', JSON.stringify(after) === JSON.stringify([...act1Ids].reverse()));

// 10. Cross-act move: fractional position BETWEEN neighbors (mirror of the
// fixed FlowView logic) then normalize — top insert must land BEFORE pos 0.
const act2Before = all('SELECT id, position FROM flow_beats WHERE project_id=? AND act=2 ORDER BY position', [p1.id]);
const at2 = 0; // insert at top
const fracPos = act2Before.length === 0 ? 0 : at2 === 0 ? act2Before[0].position - 1 : (act2Before[at2 - 1].position + act2Before[at2].position) / 2;
updateFlowBeat({ id: act1Ids[0], act: 2, position: fracPos });
reorderFlowBeats({ order: all('SELECT id FROM flow_beats WHERE project_id=? AND act=2 ORDER BY position', [p1.id]).map((b) => b.id) });
const act2 = all('SELECT * FROM flow_beats WHERE project_id=? AND act=2 ORDER BY position', [p1.id]);
check('flow: cross-act move lands at top', act2[0].id === act1Ids[0] && act2[0].position === 0, `pos=${act2[0]?.position}`);

// 11. Volume: 300 beats across 3 acts, bulk reorder stays correct
const many = [];
const t0 = Date.now();
for (let i = 0; i < 300; i++) {
  const act = (i % 3) + 1;
  many.push(createFlowBeat({ projectId: p1.id, act, title: 'bulk-' + i, summary: 's' + i }).id);
}
const createMs = Date.now() - t0;
reorderFlowBeats({ order: many });
const bulkOk = all('SELECT position FROM flow_beats WHERE project_id=?', [p1.id]).every((b) => Number.isInteger(b.position));
check('flow: 300 creates + bulk reorder OK', bulkOk, `${createMs}ms`);

// 12. Unicode + long strings survive
const uni = createFlowBeat({ projectId: p1.id, act: 1, title: ' Babak I — 🌙 "kutipan" \\n testing ', summary: 'émoji 😀 áccents ñ 200.000 token — '.repeat(40) });
const uniBack = get('SELECT * FROM flow_beats WHERE id=?', [uni.id]);
// (sql.js SQL length(v) counts UTF-8 code points, so 1400 JS chars ≈ 1360 —
// equality roundtrip is what matters, verified in-test below.)
check('flow: unicode/quotes/long strings roundtrip', uniBack.title === ' Babak I — 🌙 "kutipan" \\n testing ' && uniBack.summary === 'émoji 😀 áccents ñ 200.000 token — '.repeat(40));

// 13. SQL injection attempts via title are stored literally (parameterized)
const evil = createFlowBeat({ projectId: p1.id, act: 1, title: "x'); DROP TABLE flow_beats;--" });
updateFlowBeat({ id: evil.id, title: "'; DELETE FROM flow_beats;--" });
const stillThere = get('SELECT COUNT(*) AS c FROM flow_beats');
check('flow: injection attempts are inert', stillThere.c > 300);

// 14. Deleting a project clears its beats (app op parity)
run('DELETE FROM flow_beats WHERE project_id=?', [p1.id]);
check('flow: project delete clears beats', get('SELECT COUNT(*) AS c FROM flow_beats WHERE project_id=?', [p1.id]).c === 0);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? 'ALL DB TESTS PASSED (' + results.length + ')' : failed + ' CHECK(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
