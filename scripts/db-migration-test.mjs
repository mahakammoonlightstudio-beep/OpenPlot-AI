/**
 * Versioned-schema migration tests (v1.2.3).
 *
 * Builds real sql.js fixtures with old/partial shapes and drives the compiled
 * `dist-electron/db.js` through initDb, exactly like the app does:
 *   - fresh database              -> schema stamped, no backup
 *   - v0 legacy database          -> migrated, backup written once, data kept
 *   - v3 partially-migrated DB    -> only v4 applied, `.v3.bak` written
 *   - database newer than the app -> refused, file byte-identical
 *   - reopen after migration      -> no second backup, no extra work
 *   - builtin skill backfill      -> builtin flags set, custom skills untouched
 *   - attachment cascade          -> message/chat delete removes message_files
 *
 * Run: node scripts/db-migration-test.mjs   (requires `npm run build:electron`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const {
  initDb, closeDb, handleDb, getSchemaVersion, SCHEMA_VERSION,
  DEFAULT_AGENT_MD, DEFAULT_AGENT_MD_V1, AGENT_MD_VERSION
} = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const SQL = await initSqlJs({ locateFile: (f) => path.join('node_modules', 'sql.js', 'dist', f) });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-migrate-'));
const dirFor = (name) => {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const OLD_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  context TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, title TEXT DEFAULT 'New chat', folder_id TEXT DEFAULT NULL,
  project_id TEXT DEFAULT NULL, model TEXT DEFAULT NULL,
  system_prompt TEXT DEFAULT NULL, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT DEFAULT '', thinking TEXT DEFAULT NULL,
  model TEXT DEFAULT NULL, created_at INTEGER
);
CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, content TEXT, enabled INTEGER DEFAULT 1);
CREATE TABLE story (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT DEFAULT '', tags TEXT DEFAULT '[]',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  api_key TEXT DEFAULT '', enabled INTEGER DEFAULT 1, models TEXT DEFAULT '[]', created_at INTEGER
);
CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT, trigger TEXT, action TEXT, enabled INTEGER DEFAULT 1);
`;

const V3_UPGRADE = `
ALTER TABLE projects ADD COLUMN format TEXT DEFAULT 'novel';
ALTER TABLE projects ADD COLUMN rating TEXT DEFAULT 'teen';
ALTER TABLE providers ADD COLUMN kind TEXT DEFAULT 'auto';
ALTER TABLE story ADD COLUMN links TEXT DEFAULT '[]';
ALTER TABLE automations ADD COLUMN param TEXT DEFAULT '';
ALTER TABLE chats ADD COLUMN pinned INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN tokens_in INTEGER;
ALTER TABLE messages ADD COLUMN tokens_out INTEGER;
CREATE TABLE prompt_styles (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, builtin INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
CREATE TABLE story_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, story_id TEXT, name TEXT NOT NULL, content TEXT DEFAULT '', bytes INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE story_plans (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, brief TEXT DEFAULT '{}', plan TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER);
CREATE TABLE message_files (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT DEFAULT 'file', bytes INTEGER DEFAULT 0, content TEXT DEFAULT '', created_at INTEGER);
`;

/**
 * Write a fixture database to disk. `upgraded` adds the v2/v3 shape; `files`
 * inserts two attachment rows (used to prove cascade deletes).
 */
function writeFixture(file, { upgraded = false, version = 0, files = false, agentMd = null } = {}) {
  const raw = new SQL.Database();
  raw.exec(OLD_SCHEMA);
  if (upgraded) raw.exec(V3_UPGRADE);
  if (agentMd !== null) raw.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['agentMd', JSON.stringify(agentMd)]);
  if (files && !upgraded) {
    raw.exec("CREATE TABLE message_files (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT DEFAULT 'file', bytes INTEGER DEFAULT 0, content TEXT DEFAULT '', created_at INTEGER)");
  }
  const now = 1_700_000_000_000;
  raw.run('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?,?,?,?)', ['chat-1', 'Legacy chat', now, now]);
  raw.run('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?,?,?,?)', ['chat-2', 'Second chat', now, now]);
  raw.run('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?,?,?,?,?)', ['msg-1', 'chat-1', 'user', 'hello from 1.0', now]);
  raw.run('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?,?,?,?,?)', ['msg-2', 'chat-2', 'user', 'second chat message', now]);
  raw.run('INSERT INTO skills (id, name, content, enabled) VALUES (?,?,?,1)', ['skill-continuity', 'Continuity Guardian', 'Check canon.']);
  raw.run('INSERT INTO skills (id, name, content, enabled) VALUES (?,?,?,1)', ['custom-skill', 'My skill', 'Mine.']);
  if (upgraded) {
    raw.run("INSERT INTO projects (id, name, description, context, format, rating, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", ['p-1', 'Legacy project', '', '', 'novel', 'teen', now, now]);
    raw.run("INSERT INTO story (id, project_id, kind, title, content, tags, links, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ['s-1', 'p-1', 'character', 'Kael', 'Duelist', '[]', '[]', now, now]);
  } else {
    raw.run('INSERT INTO projects (id, name, description, context, created_at, updated_at) VALUES (?,?,?,?,?,?)', ['p-1', 'Legacy project', '', '', now, now]);
    raw.run('INSERT INTO story (id, project_id, kind, title, content, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', ['s-1', 'p-1', 'character', 'Kael', 'Duelist', '[]', now, now]);
  }
  if (files) {
    raw.run('INSERT INTO message_files (id, chat_id, message_id, name, kind, bytes, content, created_at) VALUES (?,?,?,?,?,?,?,?)', ['f-1', 'chat-1', 'msg-1', 'notes.md', 'file', 5, 'hello', now]);
    raw.run('INSERT INTO message_files (id, chat_id, message_id, name, kind, bytes, content, created_at) VALUES (?,?,?,?,?,?,?,?)', ['f-2', 'chat-2', 'msg-2', 'lore.txt', 'file', 4, 'lore', now]);
  }
  raw.exec(`PRAGMA user_version = ${version}`);
  fs.writeFileSync(file, Buffer.from(raw.export()));
  raw.close();
}

/** Read a database file without the app: tables, columns, user_version. */
function inspect(file) {
  const raw = new SQL.Database(fs.readFileSync(file));
  const q = (sql) => {
    const stmt = raw.prepare(sql);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };
  const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  // Materialize every table's columns BEFORE closing: returning accessor
  // functions that read a closed database throws SQLITE_NOMEM ("out of memory")
  // and hides the real assertion failure.
  const columns = Object.fromEntries(tables.map((t) => [t, q(`PRAGMA table_info(${t})`).map((r) => r.name)]));
  const version = Number(q('PRAGMA user_version')[0]?.user_version ?? 0);
  raw.close();
  return { tables, columns, version };
}

const db = (op, payload = {}) => handleDb(op, payload);
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));

// ---------------------------------------------------------------- fresh -----
{
  const dir = dirFor('fresh');
  const file = path.join(dir, 'fresh.db');
  await initDb(dir, 'fresh.db');
  check('fresh: schema version stamped', getSchemaVersion() === SCHEMA_VERSION && SCHEMA_VERSION === 4, `got ${getSchemaVersion()}`);
  check('fresh: no backup is created', !fs.existsSync(`${file}.v0.bak`));
  check('fresh: chat file table and stats exist', db('dbStats').chatFiles === 0 && db('dbStats').chatFileBytes === 0);
  closeDb();
  const shape = inspect(file);
  check('fresh: v4 columns present', shape.columns.skills?.includes('description')
    && shape.columns.chats?.includes('skills_off')
    && shape.columns.messages?.includes('tokens_cached'));
  check('fresh: message_files table + indexes exist', shape.tables.includes('message_files'));
}

{
  const dir = dirFor('fresh-agent');
  await initDb(dir, 'agent-fresh.db');
  const settings = db('getAllSettings');
  check('fresh: agent.md starts on v2', JSON.parse(settings.agentMd) === DEFAULT_AGENT_MD
    && JSON.parse(settings.agentMdVersion) === AGENT_MD_VERSION);
  check('fresh: default agent.md mentions priority + tools', /Instruction priority/.test(DEFAULT_AGENT_MD)
    && /Read before you write/.test(DEFAULT_AGENT_MD));
  check('fresh: no upgrade note on a new install', db('takeAgentMdUpgrade') === false);
  closeDb();
}

// --------------------------------------------------------------- legacy -----
{
  const dir = dirFor('legacy');
  const file = path.join(dir, 'legacy.db');
  writeFixture(file, { upgraded: false, version: 0, files: true });
  const before = fs.readFileSync(file);

  await initDb(dir, 'legacy.db');
  check('legacy v0: migrated to current schema', getSchemaVersion() === SCHEMA_VERSION);
  check('legacy v0: old message survives', db('getMessages', { chatId: 'chat-1' })[0]?.content === 'hello from 1.0');
  check('legacy v0: old project survives', db('listProjects')[0]?.name === 'Legacy project');
  check('legacy v0: story row survives', db('listStory')[0]?.title === 'Kael');

  const skills = db('listSkills');
  check('legacy v0: builtin skill is flagged', skills.find((s) => s.id === 'skill-continuity')?.builtin === 1);
  check('legacy v0: user skill is not flagged', skills.find((s) => s.id === 'custom-skill')?.builtin === 0);

  // The new message column must be writable and readable end-to-end.
  const saved = db('addMessage', { chatId: 'chat-1', role: 'assistant', content: 'new', tokens_cached: 42 });
  check('legacy v0: tokens_cached round-trips through addMessage', saved.tokens_cached === 42);
  const updated = db('updateMessage', { id: saved.id, tokens_cached: 7 });
  check('legacy v0: tokens_cached round-trips through updateMessage', updated.tokens_cached === 7);

  // Cascade: deleting a message removes its attachments.
  db('deleteMessage', { id: 'msg-1', chatId: 'chat-1' });
  check('legacy v0: deleting a message removes its files', db('dbStats').chatFiles === 1);
  db('deleteChat', { id: 'chat-2' });
  check('legacy v0: deleting a chat removes its files', db('dbStats').chatFiles === 0);

  check('legacy v0: exactly one backup, byte-identical', backups(dir).length === 1
    && fs.readFileSync(`${file}.v0.bak`).equals(before), backups(dir).join(','));

  closeDb();
  await initDb(dir, 'legacy.db');
  check('legacy v0: reopen stays on current schema', getSchemaVersion() === SCHEMA_VERSION);
  check('legacy v0: reopen does not write a second backup', backups(dir).length === 1, backups(dir).join(','));
  check('legacy v0: migrated shape inspected on disk', inspect(file).columns.messages?.includes('tokens_cached'));
  closeDb();
}

// ------------------------------------------------------------ partial v3 ----
{
  const dir = dirFor('partial');
  const file = path.join(dir, 'partial.db');
  writeFixture(file, { upgraded: true, version: 3, files: true });

  await initDb(dir, 'partial.db');
  check('partial v3: upgraded to current schema', getSchemaVersion() === SCHEMA_VERSION);
  check('partial v3: data survives', db('getMessages', { chatId: 'chat-2' })[0]?.content === 'second chat message');
  check('partial v3: builtin backfill still runs', db('listSkills').find((s) => s.id === 'skill-continuity')?.builtin === 1);
  check('partial v3: backup is named for the source version', backups(dir).includes('partial.db.v3.bak'), backups(dir).join(','));
  closeDb();
}

// --------------------------------------------------------- newer than app ---
{
  const dir = dirFor('newer');
  const file = path.join(dir, 'newer.db');
  writeFixture(file, { upgraded: true, version: SCHEMA_VERSION + 1 });
  const before = fs.readFileSync(file);

  let error = '';
  try {
    await initDb(dir, 'newer.db');
  } catch (err) {
    error = String(err?.message || err);
  }
  check('newer db: refused with a readable message', /newer version/i.test(error), error);
  check('newer db: file is byte-identical', fs.readFileSync(file).equals(before));
  check('newer db: no backup or extra file was written', backups(dir).length === 0 && fs.readdirSync(dir).length === 1);
  closeDb();
}

// ------------------------------------------------------- agent.md v2 ---------
// Three cases matter: untouched 1.2.2 default upgrades once, user text is never
// touched, and a fresh install starts on v2 with no upgrade note.
{
  const dir = dirFor('agent-v1');
  writeFixture(path.join(dir, 'agent.db'), { upgraded: true, version: 3, agentMd: DEFAULT_AGENT_MD_V1 });

  await initDb(dir, 'agent.db');
  const settings = db('getAllSettings');
  check('agent.md v1: upgraded to the v2 default', JSON.parse(settings.agentMd) === DEFAULT_AGENT_MD
    && DEFAULT_AGENT_MD !== DEFAULT_AGENT_MD_V1);
  check('agent.md v1: version stamped', JSON.parse(settings.agentMdVersion) === AGENT_MD_VERSION);
  check('agent.md v1: upgrade note is pending once', db('takeAgentMdUpgrade') === true);
  check('agent.md v1: note never repeats', db('takeAgentMdUpgrade') === false);
  closeDb();

  await initDb(dir, 'agent.db');
  check('agent.md v1: reopen does not re-toast', db('takeAgentMdUpgrade') === false);
  check('agent.md v1: reopen keeps v2 text', JSON.parse(db('getAllSettings').agentMd) === DEFAULT_AGENT_MD);
  closeDb();
}

{
  const dir = dirFor('agent-custom');
  const custom = '# My rules\n- Only answer in Indonesian.\n- Never kill a character without asking.\n';
  writeFixture(path.join(dir, 'agent.db'), { upgraded: true, version: 3, agentMd: custom });

  await initDb(dir, 'agent.db');
  check('agent.md custom: text is byte-identical after init', JSON.parse(db('getAllSettings').agentMd) === custom);
  check('agent.md custom: no upgrade note', db('takeAgentMdUpgrade') === false);
  check('agent.md custom: shipped default is still reachable', db('agentMdDefault').content === DEFAULT_AGENT_MD
    && db('agentMdDefault').version === AGENT_MD_VERSION);
  closeDb();
}

// -------------------------------------------------------------- cleanup -----
closeDb();
fs.rmSync(tmpRoot, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL MIGRATION TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
