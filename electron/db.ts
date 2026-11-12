import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { writeSnapshotFile } from './snapshots';

let db: Database | null = null;
let sqlStatic: SqlJsStatic | null = null;
let dbFile = '';
let saveTimer: NodeJS.Timeout | null = null;
// PERF: only rewrite the whole database file when a write actually happened.
// sql.js exports the ENTIRE DB as a new buffer, so a persist with no changes
// burns CPU + RAM for nothing (the old timer could fire after read-only ops
// and after the save that already ran).
let dirty = false;

// ---- secret-at-rest crypto hooks (wired by main.ts) ----
// API keys are stored encrypted with Electron safeStorage (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). Encrypted values are prefixed so
// plaintext keys written by older versions keep working (they are encrypted
// transparently on the next save). When safeStorage is unavailable (older
// Electron, some Linux setups without a keyring), keys stay plaintext.
let encryptSecret: ((plain: string) => string) | null = null;
let decryptSecret: ((stored: string) => string) | null = null;

export function setSecretCrypto(
  encrypt: (plain: string) => string,
  decrypt: (stored: string) => string
): void {
  encryptSecret = encrypt;
  decryptSecret = decrypt;
}

const ENC_PREFIX = 'enc:v1:';

// Per-chapter snapshot cap — oldest rows are pruned on every insert.
const CHAPTER_VERSIONS_MAX = 30;
/** Text Dump retention: newest rows win, so the trash cannot grow forever. */
const TEXT_DUMP_MAX = 500;
/**
 * A row cap alone is not a memory bound: 500 whole-chapter snapshots at the
 * 500k-character field cap would be hundreds of megabytes, and sql.js keeps
 * the entire database in RAM. Oldest recovery rows are evicted once the dump
 * exceeds this character budget (roughly 24 MB of JS text).
 */
const TEXT_DUMP_CHARS_MAX = 12_000_000;
// Story-bible attachments are stored as text inside the DB; keep a sane cap so
// a stray binary or a 40 MB ebook can never bloat the local database.
const STORY_FILE_MAX_BYTES = 2_000_000;

/**
 * Story rows keep `tags` and `links` in TEXT columns as JSON arrays. The tool
 * schema asks models for an array, but tool arguments are not validated: a
 * model that sends `"tags": "fantasy, politics"` used to be stored as the
 * JSON string `"fantasy, politics"`, which parsed back to a plain string and
 * crashed the Story Bible view with `e.map is not a function` (white screen).
 * Normalise on write AND on read so neither a model nor an older/other writer
 * can leave a row that takes the renderer down.
 */
export function storyJsonArray(value: unknown): string {
  // Only the SHAPE is repaired — real arrays keep their values, order and
  // length exactly as the user/import wrote them.
  const clean = (items: unknown[]): string => JSON.stringify(
    items
      .filter((item) => item !== null && item !== undefined && typeof item !== 'object')
      .map((item) => String(item))
  );
  const fromText = (text: string): string => clean(text.split(',').map((s) => s.trim()).filter(Boolean));
  if (Array.isArray(value)) return clean(value);
  if (typeof value !== 'string') return '[]';
  const raw = value.trim();
  if (!raw) return '[]';
  if (raw.startsWith('[') || raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return clean(parsed);
      if (typeof parsed === 'string') return fromText(parsed);
    } catch { /* legacy plain text — split below */ }
  }
  // A JSON object is not a tag list; never render it as one literal chip.
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return '[]';
    } catch { /* plain text */ }
  }
  return fromText(raw);
}

/**
 * A provider row as the renderer may see it: identity and whether a key exists,
 * never the key. The only reader of the secret is `providerSecret` below, which
 * is imported by the main process and deliberately not an IPC op.
 */
function publicProviderRow(row: any): any {
  if (!row) return row;
  return { ...row, api_key: '', has_key: String(row.api_key || '') ? 1 : 0 };
}

/** Every story row leaving the DB has array-shaped tags/links and text fields. */
function normalizeStoryRow(row: any): any {
  if (!row) return row;
  return {
    ...row,
    title: row.title == null ? '' : String(row.title),
    content: row.content == null ? '' : String(row.content),
    tags: storyJsonArray(row.tags),
    links: storyJsonArray(row.links)
  };
}

function protectKey(plain: string): string {
  const s = String(plain || '');
  if (!s || !encryptSecret) return s;
  try {
    return ENC_PREFIX + encryptSecret(s);
  } catch {
    return s; // encryption failed — store plaintext rather than lose the key
  }
}

function unprotectKey(stored: string): string {
  const s = String(stored || '');
  if (!s.startsWith(ENC_PREFIX) || !decryptSecret) return s;
  try {
    return decryptSecret(s.slice(ENC_PREFIX.length));
  } catch {
    return ''; // undecryptable (e.g. DB moved to another machine/user)
  }
}

/**
 * Read a secret stored in the settings table for main-process use only.
 * The value is JSON-encoded like every other setting, so decrypt first and
 * parse second. Legacy plaintext rows still work and are re-sealed on boot.
 */
export function settingSecret(key: string): string {
  let raw = '';
  try {
    const row = get('SELECT value FROM settings WHERE key=?', [String(key)]);
    raw = row?.value == null ? '' : String(row.value);
  } catch {
    return '';
  }
  raw = unprotectKey(raw);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return raw;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  context TEXT DEFAULT '', format TEXT DEFAULT 'novel', rating TEXT DEFAULT 'teen',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT DEFAULT NULL,
  expanded INTEGER DEFAULT 1, position INTEGER DEFAULT 0, created_at INTEGER,
  workspace TEXT DEFAULT 'chat'
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT DEFAULT 'New chat', folder_id TEXT DEFAULT NULL,
  project_id TEXT DEFAULT NULL, model TEXT DEFAULT NULL,
  system_prompt TEXT DEFAULT NULL, pinned INTEGER DEFAULT 0,
  skills_off TEXT DEFAULT '[]', skills_on TEXT DEFAULT '[]',
  agent_mode INTEGER DEFAULT 0, chat_mode TEXT DEFAULT 'write', workspace TEXT DEFAULT 'chat',
  think_level TEXT DEFAULT 'auto',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT DEFAULT '', thinking TEXT DEFAULT NULL,
  model TEXT DEFAULT NULL, tokens_in INTEGER, tokens_out INTEGER,
  tokens_cached INTEGER, parent_id TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT DEFAULT 'manual',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS story (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT DEFAULT '', tags TEXT DEFAULT '[]',
  links TEXT DEFAULT '[]',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT DEFAULT '', status TEXT DEFAULT 'draft', position INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  api_key TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
  models TEXT DEFAULT '[]', kind TEXT DEFAULT 'auto', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, name TEXT, code TEXT, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT, content TEXT, enabled INTEGER DEFAULT 1,
  description TEXT DEFAULT '', builtin INTEGER DEFAULT 0,
  source TEXT DEFAULT 'user', updated_at INTEGER,
  category TEXT DEFAULT 'writing'
);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT, trigger TEXT, action TEXT, param TEXT DEFAULT '', enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT, command TEXT, args TEXT, env TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, title TEXT DEFAULT 'New scene',
  summary TEXT DEFAULT '', position INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS flow_beats (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, act INTEGER DEFAULT 1,
  title TEXT NOT NULL, summary TEXT DEFAULT '', status TEXT DEFAULT 'planned',
  chapter_id TEXT, position INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY, category TEXT DEFAULT 'chat', title TEXT NOT NULL,
  template TEXT NOT NULL, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chapter_versions (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, title TEXT DEFAULT '',
  content TEXT DEFAULT '', word_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS text_dump (
  id TEXT PRIMARY KEY, project_id TEXT, chapter_id TEXT,
  chapter_title TEXT DEFAULT '', source TEXT DEFAULT 'writing',
  action TEXT DEFAULT 'edit', scope TEXT DEFAULT 'passage',
  original TEXT NOT NULL, replacement TEXT DEFAULT '',
  start_offset INTEGER, end_offset INTEGER,
  restored_at INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS prompt_styles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
  builtin INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS story_files (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, story_id TEXT,
  name TEXT NOT NULL, content TEXT DEFAULT '', bytes INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS message_files (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT DEFAULT 'file', bytes INTEGER DEFAULT 0,
  content TEXT DEFAULT '', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS story_plans (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL,
  brief TEXT DEFAULT '{}', plan TEXT DEFAULT '{}',
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_story_project ON story(project_id);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_flow_project ON flow_beats(project_id);
CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id);
CREATE INDEX IF NOT EXISTS idx_text_dump_created ON text_dump(created_at);
CREATE INDEX IF NOT EXISTS idx_text_dump_project ON text_dump(project_id);
CREATE INDEX IF NOT EXISTS idx_story_files_project ON story_files(project_id);
CREATE INDEX IF NOT EXISTS idx_story_files_entry ON story_files(story_id);
CREATE INDEX IF NOT EXISTS idx_message_files_message ON message_files(message_id);
CREATE INDEX IF NOT EXISTS idx_message_files_chat ON message_files(chat_id);
`;

/**
 * Schema versioning (v1.2.3).
 *
 * Older builds patched the schema with a pile of `try { ALTER TABLE … }`
 * statements executed on every boot. That is unobservable (nothing records how
 * far a database got), unrecoverable (a half-applied patch has no backup) and
 * makes future changes guesswork. This runner:
 *   1. reads `PRAGMA user_version` before touching anything,
 *   2. refuses a database written by a newer app version,
 *   3. copies the file once to `<db>.v<from>.bak` before the first change,
 *   4. applies ordered, idempotent steps inside BEGIN/COMMIT, restoring an
 *      in-memory snapshot if one fails,
 *   5. stamps the new version.
 * A column/table that already exists is skipped, so partially-migrated and
 * pre-1.2 databases (user_version = 0 with a modern shape) both upgrade safely.
 */
export const SCHEMA_VERSION = 14;

function readUserVersion(): number {
  try {
    const row = get('PRAGMA user_version');
    return Number(row?.user_version ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function getSchemaVersion(): number {
  return readUserVersion();
}

/** The file this process actually has open (not just what library.json says). */
export function getDbFilePath(): string {
  return dbFile;
}

/**
 * Read `PRAGMA user_version` from a database file without opening sql.js.
 * SQLite stores it as a big-endian uint32 at byte 60 of the 100-byte header,
 * so listing libraries stays cheap even when there are many large files.
 * Returns null for a missing/empty/unreadable file; 0 is a valid legacy DB.
 */
export function readSchemaVersionFile(file: string): number | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 100) return null;
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(100);
    fs.readSync(fd, header, 0, 100, 0);
    if (header.toString('utf8', 0, 15) !== 'SQLite format 3') return null;
    return header.readUInt32BE(60);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function hasTable(name: string): boolean {
  try {
    return all("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
  } catch {
    return false;
  }
}

function hasColumn(table: string, column: string): boolean {
  try {
    return all(`PRAGMA table_info(${table})`).some((row: any) => row.name === column);
  } catch {
    return false;
  }
}

/** Add a column only when missing (SQLite has no `ADD COLUMN IF NOT EXISTS`). */
function addColumn(table: string, column: string, ddl: string): void {
  if (hasColumn(table, column)) return;
  if (!db) throw new Error('DB not ready');
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Tool detail is stored next to the reply so a reopened chat can still explain
 * what the run did. Bounded on every axis: a runaway agent loop must not turn a
 * message row into megabytes.
 */
const TOOL_STEPS_MAX = 40;
const TOOL_DETAIL_MAX = 200;

function sanitizeToolSteps(input: unknown): string | null {
  if (!Array.isArray(input) || !input.length) return null;
  const rows = input.slice(0, TOOL_STEPS_MAX).map((s: any) => ({
    name: String(s?.name ?? '').slice(0, 80),
    kind: String(s?.kind ?? 'other').slice(0, 20),
    detail: String(s?.detail ?? '').slice(0, TOOL_DETAIL_MAX),
    ok: s?.ok !== false
  }));
  return JSON.stringify(rows);
}

/**
 * Text that is safe to store. A NUL byte cannot be read back through the SQLite
 * string API (the row comes back truncated), so it is removed on the way in
 * instead of silently corrupting the message.
 */
function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Never call a caller-supplied `toString`: an object whose method is missing
  // or throws would crash the write instead of storing something sensible.
  try { return JSON.stringify(value).replace(/\u0000/g, ''); } catch { return ''; }
}

/** Stored JSON → rows the chat panels render. Never throws on bad data. */
function toolStepsOf(row: any): any[] {
  if (!row?.tools_json) return [];
  try {
    const parsed = JSON.parse(String(row.tools_json));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function execRaw(sql: string): void {
  if (!db) throw new Error('DB not ready');
  db.exec(sql);
}

/** Ordered migrations. Append only: `version` is the state the step produces. */
const MIGRATIONS: { version: number; run: () => void }[] = [
  {
    version: 2,
    run() {
      addColumn('story', 'links', "TEXT DEFAULT '[]'");
      addColumn('providers', 'kind', "TEXT DEFAULT 'auto'");
      addColumn('automations', 'param', "TEXT DEFAULT ''");
      addColumn('projects', 'format', "TEXT DEFAULT 'novel'");
      addColumn('projects', 'rating', "TEXT DEFAULT 'teen'");
    }
  },
  {
    version: 3,
    run() {
      addColumn('chats', 'pinned', 'INTEGER DEFAULT 0');
      addColumn('messages', 'tokens_in', 'INTEGER');
      addColumn('messages', 'tokens_out', 'INTEGER');
      if (!hasTable('prompt_styles')) {
        execRaw("CREATE TABLE prompt_styles (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, builtin INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)");
      }
      if (!hasTable('story_files')) {
        execRaw("CREATE TABLE story_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, story_id TEXT, name TEXT NOT NULL, content TEXT DEFAULT '', bytes INTEGER DEFAULT 0, created_at INTEGER)");
      }
      if (!hasTable('story_plans')) {
        execRaw("CREATE TABLE story_plans (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, brief TEXT DEFAULT '{}', plan TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)");
      }
      execRaw('CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_story_project ON story(project_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_flow_project ON flow_beats(project_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_story_files_project ON story_files(project_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_story_files_entry ON story_files(story_id)');
    }
  },
  {
    version: 4,
    run() {
      // Chat attachments (v1.2.3): files belong to a sent message, not just to
      // the composer, so they can be reopened from the transcript.
      if (!hasTable('message_files')) {
        execRaw("CREATE TABLE message_files (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT DEFAULT 'file', bytes INTEGER DEFAULT 0, content TEXT DEFAULT '', created_at INTEGER)");
      }
      execRaw('CREATE INDEX IF NOT EXISTS idx_message_files_message ON message_files(message_id)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_message_files_chat ON message_files(chat_id)');
      // Skills v2 metadata (enable-gated skills ship in the same release).
      addColumn('skills', 'description', "TEXT DEFAULT ''");
      addColumn('skills', 'builtin', 'INTEGER DEFAULT 0');
      addColumn('skills', 'source', "TEXT DEFAULT 'user'");
      addColumn('skills', 'updated_at', 'INTEGER');
      addColumn('chats', 'skills_off', "TEXT DEFAULT '[]'");
      // Prompt-cache accounting.
      addColumn('messages', 'tokens_cached', 'INTEGER');
      // Rows seeded by older builds are builtins; user skills keep builtin = 0.
      execRaw("UPDATE skills SET builtin = 1, source = 'builtin' WHERE id IN ('skill-continuity','skill-prose','skill-dialogue','skill-pacing') AND builtin = 0");
    }
  },
  {
    version: 5,
    run() {
      // MCP server environment variables (Task 13). Most real servers need at
      // least one (an API key, a root folder), and storing them per server is
      // what makes the bridge usable without shell wrappers.
      addColumn('mcp_servers', 'env', "TEXT DEFAULT '{}'");
    }
  },
  {
    version: 6,
    run() {
      // Reply variants. Resending or regenerating used to DELETE the
      // previous answer, so there was nothing to compare or go back to. An
      // assistant row now points at the user turn it answers; rows sharing that
      // parent are the variants the transcript can flip through.
      addColumn('messages', 'parent_id', 'TEXT');
      // Backfill existing transcripts: pair every assistant reply with the
      // user turn just before it in the same chat, so old chats get the arrow
      // navigation too (one variant = no arrows).
      const rows = all('SELECT id, chat_id, role FROM messages ORDER BY chat_id, created_at, rowid');
      let chatId = '';
      let lastUser: string | null = null;
      for (const row of rows) {
        if (row.chat_id !== chatId) { chatId = row.chat_id; lastUser = null; }
        if (row.role === 'user') lastUser = row.id;
        else if (row.role === 'assistant' && lastUser) run('UPDATE messages SET parent_id=? WHERE id=?', [lastUser, row.id]);
      }
      execRaw('CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)');
    }
  },
  {
    version: 7,
    run() {
      // Chat modes + on-demand skills. Agent mode and the three chat
      // modes belong to the chat, and a skill is activated per chat with
      // /skill/<name> instead of being globally on.
      addColumn('chats', 'skills_on', "TEXT DEFAULT '[]'");
      addColumn('chats', 'agent_mode', 'INTEGER DEFAULT 0');
      addColumn('chats', 'chat_mode', "TEXT DEFAULT 'write'");
      // Skills now ship off: the composer's /skill command is the way in.
      // Scoped to builtins so a custom skill the user enabled stays enabled.
      execRaw('UPDATE skills SET enabled = 0 WHERE builtin = 1');
    }
  },
  {
    version: 8,
    run() {
      // Thinking level is a per-chat choice (auto/off/low/medium/high/max), so
      // it survives a restart instead of resetting with the session.
      addColumn('chats', 'think_level', "TEXT DEFAULT 'auto'");
    }
  },
  {
    version: 9,
    run() {
      // Tool calls used to be reconstructed from memory only, so a reloaded
      // chat showed "Tools used · 3" with no detail. The rows keep the readable
      // step (what it created, whether it worked) next to the reply.
      addColumn('messages', 'tools_json', 'TEXT');
    }
  },
  {
    version: 10,
    run() {
      // Workspaces (v1.3.0). Every chat belongs to exactly one Advance section:
      // 'chat' (conversation/brainstorm) or 'agent' (the tool loop). Existing
      // chats become Chat sessions; chats that were already running with agent
      // mode on move to the Agent workspace, so no session disappears on
      // upgrade. The Writing workspace keeps chapters, not chats.
      addColumn('chats', 'workspace', "TEXT DEFAULT 'chat'");
      execRaw("UPDATE chats SET workspace = 'agent' WHERE agent_mode = 1");
    }
  },
  {
    version: 11,
    run() {
      // Folders belong to one workspace too (v1.3.0): a Chat folder must not
      // show up in Agent and vice versa. Existing folders stay in Chat.
      addColumn('folders', 'workspace', "TEXT DEFAULT 'chat'");
    }
  },
  {
    version: 12,
    run() {
      // Text Dump (v1.4.0): every AI/manual replacement keeps the text it
      // displaced, so a bad rewrite can be recovered without rolling the whole
      // chapter back. `scope` decides whether restore replaces the chapter or
      // splices the old passage back into its original slot.
      if (!hasTable('text_dump')) {
        execRaw("CREATE TABLE text_dump (id TEXT PRIMARY KEY, project_id TEXT, chapter_id TEXT, chapter_title TEXT DEFAULT '', source TEXT DEFAULT 'writing', action TEXT DEFAULT 'edit', scope TEXT DEFAULT 'passage', original TEXT NOT NULL, replacement TEXT DEFAULT '', start_offset INTEGER, end_offset INTEGER, restored_at INTEGER, created_at INTEGER)");
      }
      execRaw('CREATE INDEX IF NOT EXISTS idx_text_dump_created ON text_dump(created_at)');
      execRaw('CREATE INDEX IF NOT EXISTS idx_text_dump_project ON text_dump(project_id)');
    }
  },
  {
    version: 13,
    run() {
      // Paging reads `WHERE chat_id=? ORDER BY created_at DESC, rowid DESC`.
      // The old chat-only index left SQLite with a sort of the whole chat for
      // every page. This one serves both the filter and the order, so a page
      // on a 5,000-message chat stops scaling with transcript length.
      execRaw('CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)');
    }
  },
  {
    version: 14,
    run() {
      // Skill categories (v1.3.0): the same library is shared by Chat, Agent
      // and Writing, but the picker groups instructions by the desk they fit.
      addColumn('skills', 'category', "TEXT DEFAULT 'writing'");
      const shipped: Record<string, string> = {
        'skill-continuity': 'agent',
        'skill-prose': 'writing',
        'skill-dialogue': 'writing',
        'skill-pacing': 'writing',
        'skill-beta-reader': 'chat',
        'skill-architect': 'agent',
        'skill-voice': 'writing',
        'skill-hook': 'writing',
        'skill-line-editor': 'writing'
      };
      for (const [id, category] of Object.entries(shipped)) {
        run('UPDATE skills SET category=? WHERE id=?', [category, id]);
      }
    }
  }
];

/** Apply every migration newer than `from`; returns the versions applied. */
function applyMigrations(from: number): number[] {
  const applied: number[] = [];
  for (const step of MIGRATIONS) {
    if (step.version <= from || step.version > SCHEMA_VERSION) continue;
    step.run();
    applied.push(step.version);
  }
  return applied;
}

export function uid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function initDb(dir: string, fileName = 'openplot.db'): Promise<string> {
  const SQL: SqlJsStatic = await initSqlJs({
    locateFile: (f: string) => {
      const candidates = [
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
        path.join(process.resourcesPath || '', 'sql', f)
      ];
      for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
      }
      return candidates[0];
    }
  });
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dbFile = path.join(dir, fileName);
  sqlStatic = SQL;
  const existed = fs.existsSync(dbFile);
  db = existed ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();

  // Version check happens BEFORE any write: a database from a newer build must
  // be left untouched instead of silently "migrated" (which corrupts columns).
  const from = existed ? readUserVersion() : 0;
  if (from > SCHEMA_VERSION) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
    throw new Error(
      `This database was created by a newer version of OpenPlot AI (schema ${from} > ${SCHEMA_VERSION}). ` +
      'Update the app, or restore a backup of the database file.'
    );
  }
  if (!db) throw new Error('Database could not be opened.');

  // Pre-migration backup: one pristine copy per source version, never
  // overwritten. If it cannot be written, refuse to migrate — the whole point
  // of the backup is that a failed upgrade is recoverable.
  if (existed && from < SCHEMA_VERSION) {
    const bak = `${dbFile}.v${from}.bak`;
    try {
      if (!fs.existsSync(bak)) fs.copyFileSync(dbFile, bak);
    } catch (err: any) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
      throw new Error(`Could not create a pre-upgrade backup (${bak}): ${err?.message || err}. Migration cancelled.`);
    }
  }

  const snapshot = existed ? db.export() : null;
  // Time Machine copy before the in-memory DB is touched. The `.vN.bak` above
  // is the technical fallback; this one is discoverable in Settings → Data.
  // A snapshot failure must not block a migration whose .bak already exists.
  if (snapshot && existed && from < SCHEMA_VERSION) {
    try {
      writeSnapshotFile(dir, fileName, snapshot, `pre-migration-v${from}`);
    } catch (e) {
      console.error('pre-migration snapshot failed:', e);
    }
  }
  const applied: number[] = [];
  try {
    db.exec('BEGIN');
    db.exec(SCHEMA);
    applied.push(...applyMigrations(from));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    if (snapshot && sqlStatic && db) {
      // Keep this instance usable and the on-disk file untouched: swap the
      // half-migrated in-memory database for the pre-migration snapshot.
      try { db.close(); } catch { /* already closed */ }
      db = new sqlStatic.Database(snapshot);
    }
    throw new Error(
      `Database migration failed (schema ${from} → ${SCHEMA_VERSION}); the file on disk was not changed. ` +
      `${err?.message || err}`
    );
  }
  if (applied.length) console.log(`DB migrated v${from} → v${SCHEMA_VERSION} (steps: ${applied.join(', ')})`);
  seedDefaults();
  protectLegacySettingSecrets();
  dirty = true;
  persistNow();
  return dbFile;
}

// First-run seeding: ships a sensible default agent persona and two starter
// automations so the automation engine is discoverable out of the box.
function readSettingsValue(key: string): string | null {
  const row = get('SELECT value FROM settings WHERE key=?', [key]);
  if (!row || row.value == null) return null;
  try {
    const parsed = JSON.parse(String(row.value));
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    // A hand-edited row that is not JSON is still the user's text — compare it
    // raw rather than treating it as "no value" (which would overwrite it).
    return String(row.value);
  }
}

/**
 * Older builds wrote the web-search key as a plaintext JSON setting. Re-seal it
 * once at boot, before the renderer can ask for settings. A failed encryption
 * leaves the row untouched rather than destroying the user's key.
 */
function protectLegacySettingSecrets(): void {
  if (!encryptSecret) return;
  try {
    const row = get("SELECT value FROM settings WHERE key='webSearchApiKey'");
    const raw = row?.value == null ? '' : String(row.value);
    if (!raw || raw.startsWith(ENC_PREFIX)) return;
    const sealed = protectKey(raw);
    if (sealed !== raw) run("UPDATE settings SET value=? WHERE key='webSearchApiKey'", [sealed]);
  } catch { /* settings table not ready yet */ }
}

function seedDefaults(): void {
  if (!db) return;
  try {
    const hasAgent = all("SELECT value FROM settings WHERE key='agentMd'");
    let upgradedAgent = false;
    if (!hasAgent.length) {
      const stmt = db.prepare("INSERT INTO settings (key, value) VALUES ('agentMd', ?)");
      stmt.bind([JSON.stringify(DEFAULT_AGENT_MD)]);
      stmt.step();
      stmt.free();
      run("INSERT INTO settings (key, value) VALUES ('agentMdVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(AGENT_MD_VERSION)]);
    } else if (readSettingsValue('agentMd') === DEFAULT_AGENT_MD_V1) {
      // Untouched shipped default from 1.2.2 → upgrade it. Anything the user
      // typed, however small, is left exactly as-is; the version stamp below
      // stops the upgrade from running again.
      run("UPDATE settings SET value = ? WHERE key = 'agentMd'", [JSON.stringify(DEFAULT_AGENT_MD)]);
      run("INSERT INTO settings (key, value) VALUES ('agentMdVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(AGENT_MD_VERSION)]);
      upgradedAgent = true;
    }
    if (upgradedAgent) {
      // One-shot flag the renderer reads once to toast "agent.md was updated".
      run("INSERT INTO settings (key, value) VALUES ('agentMdUpgraded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(Date.now())]);
    }
    const autoCount = get('SELECT COUNT(*) AS n FROM automations');
    if (!autoCount?.n) {
      const seeds: Array<[string, string, string]> = [
        ['Welcome flash', 'app:ready', 'toast'],
        ['Log new messages', 'message:new', 'log']
      ];
      for (const [name, trigger, action] of seeds) {
        const stmt = db.prepare('INSERT INTO automations (id, name, trigger, action, enabled) VALUES (?,?,?,?,1)');
        stmt.bind([uid(), name, trigger, action]);
        stmt.step();
        stmt.free();
      }
    }
    // Builtin reply styles (Claude-style) — seeded once, flagged builtin so
    // they can be edited (updated in place) but never deleted from the UI.
    const styleCount = get('SELECT COUNT(*) AS n FROM prompt_styles WHERE builtin=1');
    if (!styleCount?.n) {
      for (const s of DEFAULT_STYLES) {
        const stmt = db.prepare('INSERT INTO prompt_styles (id, name, content, builtin, created_at, updated_at) VALUES (?,?,?,1,?,?)');
        stmt.bind([s.id, s.name, s.content, Date.now(), Date.now()]);
        stmt.step();
        stmt.free();
      }
    }
    // Builtin skills (agent abilities). Seeding is IDEMPOTENT BY ID: an upgrade
    // that ships a new builtin adds just that one, and a skill the user edited
    // is never overwritten (INSERT OR IGNORE). Deleting a builtin from the UI is
    // refused; Reset restores its shipped text instead.
    for (const s of DEFAULT_SKILLS) {
      const exists = get('SELECT id FROM skills WHERE id=?', [s.id]);
      if (exists) {
        // Rows created before builtins were flagged get the flag, once.
        if (!get('SELECT builtin FROM skills WHERE id=?', [s.id])?.builtin) {
          run('UPDATE skills SET builtin=1 WHERE id=?', [s.id]);
        }
        continue;
      }
      // Skills ship OFF: they are switched on per chat with /skill, so a
      // fresh install never injects instruction blocks nobody asked for.
      run('INSERT INTO skills (id, name, description, content, enabled, builtin, category) VALUES (?,?,?,?,0,1,?)', [s.id, s.name, s.description, s.content, s.category]);
    }
  } catch (e) {
    console.error('seedDefaults failed:', e);
  }
}

/** Shipped agent.md version. Bumped when the default text changes. */
export const AGENT_MD_VERSION = 2;

/**
 * The 1.2.2 default, kept verbatim for comparison only. An `agentMd` row that
 * still equals this string was never edited, so upgrading it is safe; every
 * other value belongs to the user and is never touched.
 */
export const DEFAULT_AGENT_MD_V1 = `You are OpenPlot, a focused AI writing and chat assistant living inside a local-first story studio.

## Style
- Match the user's language (English or Indonesian) and their tone.
- Prose first: concrete detail, active voice, no filler.
- When writing fiction, keep continuity with the story bible; use your story tools to check facts before inventing them.

## Behavior
- Use save_memory for durable user preferences, create/update_story_entry for worldbuilding, and chapter tools for drafts.
- Ask at most one clarifying question when a request is ambiguous; otherwise make a reasonable creative choice and say so.
- Keep chat replies tight; put long-form output in chapters when asked.`;

/**
 * agent.md v2 (1.2.3). Model-facing, English, ~70 lines.
 *
 * Rewritten because v1 taught tools but not priorities, and a model that does
 * not know what outranks what will happily let a reply style override a canon
 * fact. Every rule here maps to something the app actually enforces, so the
 * text stays honest when features change.
 */
export const DEFAULT_AGENT_MD = `You are OpenPlot, a focused AI writing and chat assistant inside a local-first story studio. The user owns this machine and this file: their edits to agent.md always win over this shipped text.

## Who you are
- A working collaborator, not a chatbot: help the user write, plan, edit and keep their world consistent.
- Local-first and private. Never claim to have sent anything anywhere; nothing leaves this machine except the model request itself.

## Instruction priority
When instructions conflict, the higher item wins — silently, unless the conflict is worth one sentence:
1. The system prompt and the provider's own safety rules.
2. This agent.md.
3. Project context (format, rating, description, project files).
4. Active skills.
5. The reply style.
6. Long-term memory.
7. The current message.
If a user instruction contradicts canon or a higher rule, say what you are keeping and why in one line, then continue with the closest useful version.

## Tool protocol
- Read before you write. Use search_story / read_story_bible before creating or changing canon; use read_chapter before appending to a chapter.
- Never invent a tool result. If a tool fails or is unavailable, say so plainly and offer the answer without it.
- Prefer the specific tool over prose: worldbuilding facts go to story entries, drafts go to chapters, durable preferences go to memory.
- After a write, summarize what changed in one or two lines (name and kind of each row).
- Ask before anything destructive or wide-reaching: deleting entries, rewriting a whole chapter, mass edits. Small additive edits do not need permission.
- Do not call the same tool twice with identical arguments to "check".

## Memory policy
- Save only durable, reusable preferences about how the user wants to work (tone, language, formatting, pet peeves).
- Never save story facts, character traits or plot points as memory — they belong in the story bible, where the user can see and edit them.
- Do not save secrets, keys or personal data even if asked in passing; ask the user to store them in Settings instead.

## Writing standards
- Keep point of view and tense consistent with the project and the previous chapter; if the user switches, follow the switch.
- Every scene needs a goal, an obstacle and a turn. Cut scenes that have none.
- Concrete detail beats adjectives. Prefer verbs. No purple prose, no throat-clearing, no repeated summary of what was just said.
- Dialogue carries character: subtext over exposition, distinct voices, no two characters explaining the plot to each other.
- Match the user's language (English or Indonesian) unless the story itself is written in another language.

## Response format
- Lead with the answer or the prose. No preamble, no restating the question, no "Here is".
- Chat replies stay tight; long-form output belongs in a chapter when the user is drafting.
- Use Markdown for structure: short paragraphs, headings only when the reply is genuinely long, lists only when items are parallel.
- When you propose an edit, show the changed lines rather than the whole document.

## Ratings and safety
- Respect the project rating: family / teen / mature. It bounds language, violence and sexual content; a mature rating still means non-explicit sex.
- If a request pushes past the rating, offer the closest version that fits instead of refusing flatly.

## Honesty
- If you are unsure about canon, say so and check with a tool before asserting.
- Never claim work you did not do, and never describe a file, chapter or entry that does not exist.
- If a tool is unavailable, say so instead of pretending.`;

// Builtin reply styles — seeded into prompt_styles on first run. `content`
// is a system-prompt fragment injected verbatim under "# Reply style".
export const DEFAULT_STYLES: Array<{ id: string; name: string; content: string }> = [
  {
    id: 'style-default',
    name: 'Default',
    content: 'Match the tone of the conversation. Clear, direct, concrete. Use markdown for structure when the reply is long.'
  },
  {
    id: 'style-concise',
    name: 'Concise',
    content: 'Answer in as few words as possible. No preamble, no restating the question, no summaries of what you are about to say. Lead with the answer. Skip filler like "Great question" or "Certainly". When a list works, use it; when prose is shorter, use prose.'
  },
  {
    id: 'style-explanatory',
    name: 'Explanatory',
    content: 'Explain as you answer: give the reasoning behind choices, one short example where it helps, and note trade-offs. Keep the teaching tone friendly, never condescending, and still lead with the answer before the explanation.'
  },
  {
    id: 'style-editorial',
    name: 'Editorial',
    content: 'Write with a strong editorial voice: confident, opinionated where justified, vivid but not purple. Vary sentence rhythm; prefer verbs over adverbs. When critiquing writing, name specifically what works and what does not, and always say why.'
  },
  {
    id: 'style-empathetic',
    name: 'Empathetic',
    content: 'Be warm and supportive. Acknowledge the user\'s effort and feelings before advice. Keep encouragement specific (praise the craft, not generic positivity). Never let warmth blur accuracy — if something needs fixing, say so kindly and clearly.'
  },
  {
    id: 'style-formal',
    name: 'Formal',
    content: 'Use a formal, professional register: complete sentences, precise vocabulary, no slang, no contractions. Structure longer replies with headings or numbered points. Suitable for queries, outlines, and correspondence within the story.'
  }
];

// Starter skills — shown in Settings → Skills; the user can edit or delete
// them like any other skill. They ride along in the system prompt.
export const DEFAULT_SKILLS: Array<{ id: string; name: string; description: string; content: string; category: string }> = [
  {
    id: 'skill-continuity',
    category: 'agent',
    name: 'Continuity Guardian',
    description: 'Checks new facts against canon before writing them down.',
    content: 'Before adding any story fact (name, place, date, ability, relationship), search the story bible and read the relevant chapter. If the new fact conflicts with established canon, say so and propose the smallest change that preserves both.'
  },
  {
    id: 'skill-prose',
    category: 'writing',
    name: 'Prose Polisher',
    description: 'Tightens prose and explains every change.',
    content: 'When asked to improve prose: cut filler words, vary sentence length, replace weak verbs + adverbs with strong verbs, and prefer concrete sensory detail. Show the revised passage first, then a short bullet list of what changed and why.'
  },
  {
    id: 'skill-dialogue',
    category: 'writing',
    name: 'Dialogue Coach',
    description: 'Gives every character a distinct, testable voice.',
    content: 'Give each character a distinct voice: vocabulary, rhythm, and what they leave unsaid. When writing dialogue, read it back per character; if two voices could swap lines unnoticed, differentiate them. Use subtext — characters rarely state feelings directly.'
  },
  {
    id: 'skill-pacing',
    category: 'writing',
    name: 'Pacing Analyst',
    description: 'Finds scenes that run long without a turn.',
    content: 'When reviewing chapters, track scene-level pacing: goal, conflict, disaster/turn per scene. Flag scenes that run long without a turn, summarize slow middle stretches, and suggest where to cut or add a beat. Reference the story flow board when it exists.'
  },
  {
    id: 'skill-beta-reader',
    category: 'chat',
    name: 'Beta Reader',
    description: 'Reads a draft the way a first-time reader would.',
    content: 'Read the passage once as a first-time reader, then report: where you got confused, where you got bored, where you got hooked, and the one thing you would change first. Quote the exact lines you reacted to, and separate "this is broken" from "this is not to my taste".'
  },
  {
    id: 'skill-architect',
    category: 'agent',
    name: 'Worldbuilding Architect',
    description: 'Builds settings from consequences, not decoration.',
    content: 'When inventing a place, culture or system, start from one constraint (geography, scarcity, magic cost, power structure) and derive the consequences people would actually live with: work, food, etiquette, taboos, slang. Store durable facts as story bible entries; keep flavour text out of canon.'
  },
  {
    id: 'skill-voice',
    category: 'writing',
    name: 'Voice Keeper',
    description: 'Keeps every POV voice consistent across chapters.',
    content: 'Track the current point of view, tense and register. Before writing, sample one paragraph of that POV\'s existing prose and match its sentence rhythm, vocabulary and level of interiority. If a new passage drifts into another character\'s diction or the wrong tense, fix it before returning the text, and say in one line what you corrected.'
  },
  {
    id: 'skill-hook',
    category: 'writing',
    name: 'Hook Doctor',
    description: 'Sharpens openings and chapter endings.',
    content: 'For an opening: state in one line what the reader wants to know by the end of the first paragraph, then rewrite so a concrete image or a live problem creates that question immediately — no weather, no waking up, no summary. For a chapter ending: end on a decision, a reversal or an unanswered cost, never on a tidy resolution. Offer two alternatives and name which one you would keep.'
  },
  {
    id: 'skill-line-editor',
    category: 'writing',
    name: 'Line Editor',
    description: 'Copyedits without flattening the author\u2019s voice.',
    content: 'Do a line edit, not a rewrite: fix grammar, punctuation, repeated words, filter verbs (saw, felt, noticed), dangling modifiers and unintentional echoes. Preserve the author\u2019s diction, dialect and deliberate fragments. Return the corrected passage, then list only the categories of change with one example each.'
  }
];

/**
 * Write the in-memory database to disk. Always atomic: the new bytes go to a
 * temp file first and then rename over the real one, so a crash or a full disk
 * during a write can never leave a half-written (unopenable) database behind.
 * Returns true when bytes were written.
 */
export function persistNow(force = false): boolean {
  if (!db || !dbFile) return false;
  if (!dirty && !force) return false;
  try {
    // fs accepts a Uint8Array directly — no Buffer.from copy (sql.js export is
    // already a full copy, a second one only doubles peak memory on big DBs).
    const data = db.export();
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, dbFile);
    } catch {
      // Windows can refuse the replace while another handle is open — fall
      // back to a direct write rather than losing this save.
      fs.writeFileSync(dbFile, data);
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
    dirty = false;
    return true;
  } catch (e) {
    console.error('DB persist failed:', e);
    return false;
  }
}

/**
 * A copy of the open library safe to carry to another machine (v1.3.0).
 *
 * Everything the studio owns lives in the database — chats, chapters, story
 * files, prompts, skills, settings — so one file is the whole library. Two
 * things must not travel: provider API keys (safeStorage ties them to this OS
 * account; elsewhere they would be undecryptable noise) and stored plugin/MCP
 * execution approvals (a security decision made on this machine). Rows are
 * removed from the copy only; the live database is untouched.
 */
export function portableDatabaseBuffer(): Buffer | null {
  if (!db || !sqlStatic) return null;
  const copy = new sqlStatic.Database(db.export());
  try {
    copy.run("UPDATE providers SET api_key = ''");
    copy.run("DELETE FROM settings WHERE key IN ('trustedExec', 'webSearchApiKey')");
    // MCP environment variables often carry tokens. A portable copy is a
    // data handoff, not a credential handoff, so server definitions travel but
    // their environment is emptied and must be re-entered on the new machine.
    copy.run("UPDATE mcp_servers SET env = '{}'");
    return Buffer.from(copy.export());
  } finally {
    try { copy.close(); } catch { /* already closed */ }
  }
}

function schedulePersist(): void {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  // PERF: persist rewrites the WHOLE db file (sql.js export). 400ms during
  // streaming meant a full-file write every few tokens; 1200ms keeps the
  // durability window tight while cutting write frequency by 3x.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 1200);
}

/**
 * Keep the recovery bin bounded by BOTH row count and stored text size. The
 * size pass only runs after an insert, and deletes whole rows oldest-first so
 * a single huge chapter snapshot cannot evict every other recovery entry in
 * one go unnecessarily early.
 */
function pruneTextDump(): void {
  run('DELETE FROM text_dump WHERE id IN (SELECT id FROM text_dump ORDER BY created_at DESC LIMIT -1 OFFSET ?)', [TEXT_DUMP_MAX]);
  const total = Number(get('SELECT SUM(length(original) + length(replacement)) AS n FROM text_dump')?.n || 0);
  let excess = total - TEXT_DUMP_CHARS_MAX;
  if (excess <= 0) return;
  const rows = all('SELECT id, length(original) + length(replacement) AS n FROM text_dump ORDER BY created_at ASC, rowid ASC');
  const drop: string[] = [];
  for (const row of rows) {
    drop.push(row.id);
    excess -= Number(row.n) || 0;
    if (excess <= 0) break;
  }
  if (drop.length) run(`DELETE FROM text_dump WHERE id IN (${drop.map(() => '?').join(',')})`, drop);
}

function run(sql: string, params: any[] = []): void {
  if (!db) throw new Error('DB not ready');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  schedulePersist();
}

function all(sql: string, params: any[] = []): any[] {
  if (!db) throw new Error('DB not ready');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql: string, params: any[] = []): any | undefined {
  return all(sql, params)[0];
}

// ---------- chat attachment guards ----------
// Keep in sync with src/lib/chatFiles.ts (renderer shows the same numbers).
// Enforced here as well because the renderer is not a trust boundary: a
// plugin, the palette or a future MCP bridge can call dbCall directly.
export const MAX_CHAT_FILES = 8;
export const MAX_CHAT_FILE_BYTES = 256 * 1024;
export const MAX_CHAT_TOTAL_BYTES = 1024 * 1024;

interface ChatFileRow {
  id: string;
  name: string;
  kind: string;
  bytes: number;
  content: string;
}

// Round up: a 256 KB + 1 byte file must not claim to be 256 KB.
const kbLabel = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/**
 * Validate the files that ride along with a sent message. Returns normalized
 * rows ready to insert, or throws one readable error naming the offending
 * file. Runs BEFORE the message row is written, so a rejected attachment never
 * leaves a half-saved turn behind.
 */
function validateChatFiles(files: any[]): ChatFileRow[] {
  if (files.length > MAX_CHAT_FILES) {
    throw new Error(`A message can carry at most ${MAX_CHAT_FILES} files (got ${files.length}).`);
  }
  const out: ChatFileRow[] = [];
  let total = 0;
  for (const f of files) {
    const name = String(f?.name ?? '').trim() || 'Untitled file';
    const kindRaw = String(f?.kind ?? 'file');
    const kind = kindRaw === 'story' || kindRaw === 'chapter' ? kindRaw : 'file';
    if (typeof f?.content !== 'string') {
      throw new Error(`“${name}” has no readable text content — only text files can be attached.`);
    }
    const content = f.content;
    if (content.includes('\u0000')) {
      throw new Error(`“${name}” looks like a binary file — chat attachments must be plain text.`);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_CHAT_FILE_BYTES) {
      throw new Error(`“${name}” is ${kbLabel(bytes)}; the per-file limit is ${kbLabel(MAX_CHAT_FILE_BYTES)}.`);
    }
    total += bytes;
    out.push({ id: uid(), name, kind, bytes, content });
  }
  if (total > MAX_CHAT_TOTAL_BYTES) {
    throw new Error(`Attachments total ${kbLabel(total)}; the limit is ${kbLabel(MAX_CHAT_TOTAL_BYTES)} per message.`);
  }
  return out;
}

const fileMeta = (row: any) => ({ id: row.id, name: row.name, kind: row.kind, bytes: row.bytes });

// ---------- generic handlers ----------

export function handleDb(op: string, payload: any): any {
  // IPC can deliver null/undefined (a cancelled call, a renderer bug). Every op
  // reads fields off `payload`, so a single guard here replaces a crash per op.
  if (payload === null || payload === undefined || typeof payload !== 'object') payload = {};
  const now = Date.now();
  switch (op) {
    // settings
    case 'getAllSettings':
      return Object.fromEntries(all('SELECT key, value FROM settings').map((r: any) => [r.key, r.value]));
    case 'setSetting': {
      const key = String(payload?.key || '');
      let value = payload?.value;
      // The web-search key is a credential, not ordinary UI state. Encrypt the
      // JSON wrapper so the database never contains it in plaintext; the
      // renderer only receives an empty string plus a has-key flag.
      if (key === 'webSearchApiKey') {
        const rawValue = String(value ?? '');
        let plain = rawValue;
        try {
          const parsed = JSON.parse(rawValue);
          if (typeof parsed === 'string') plain = parsed;
        } catch { /* legacy raw string */ }
        value = plain.trim() ? protectKey(rawValue) : '';
      }
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
      return true;
    }
    // The shipped agent.md text, so "Restore default" restores exactly what
    // this build ships instead of a copy that drifts in the renderer.
    case 'agentMdDefault':
      return { version: AGENT_MD_VERSION, content: DEFAULT_AGENT_MD };
    // Consume the one-shot "your agent.md was upgraded" note.
    case 'takeAgentMdUpgrade': {
      const row = get("SELECT value FROM settings WHERE key='agentMdUpgraded'");
      if (!row) return false;
      run("DELETE FROM settings WHERE key='agentMdUpgraded'");
      return true;
    }
    // projects
    case 'listProjects':
      return all('SELECT * FROM projects ORDER BY updated_at DESC');
    case 'createProject': {
      const id = uid();
      run('INSERT INTO projects (id, name, description, context, format, rating, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, payload.name, payload.description || '', payload.context || '', payload.format || 'novel', payload.rating || 'teen', now, now]);
      return get('SELECT * FROM projects WHERE id = ?', [id]);
    }
    case 'updateProject': {
      // Dynamic SET — only touch columns present in the payload (an empty
      // context string must still be able to CLEAR the field).
      const colMap: Record<string, string> = { name: 'name', description: 'description', context: 'context', format: 'format', rating: 'rating' };
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [k, col] of Object.entries(colMap)) {
        if (payload[k] !== undefined) { sets.push(`${col}=?`); vals.push(payload[k]); }
      }
      if (sets.length) {
        sets.push('updated_at=?');
        vals.push(now, payload.id);
        run(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`, vals);
      }
      return get('SELECT * FROM projects WHERE id = ?', [payload.id]);
    }
    case 'deleteProject':
      run('DELETE FROM projects WHERE id=?', [payload.id]);
      run('DELETE FROM story_files WHERE project_id=?', [payload.id]);
      run('DELETE FROM story_plans WHERE project_id=?', [payload.id]);
      // Messages live on the deleted chats — remove them first or they stay
      // orphaned in the DB forever (they were never cleaned up before).
      run('DELETE FROM message_files WHERE chat_id IN (SELECT id FROM chats WHERE project_id=?)', [payload.id]);
      run('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE project_id=?)', [payload.id]);
      run('DELETE FROM chats WHERE project_id=?', [payload.id]);
      run('DELETE FROM story WHERE project_id=?', [payload.id]);
      run('DELETE FROM chapters WHERE project_id=?', [payload.id]);
      run('DELETE FROM flow_beats WHERE project_id=?', [payload.id]);
      // Global chats (project_id NULL) can sit in folders owned by this
      // project — detach them or they'd reference folders deleted below
      // (same cleanup deleteFolder does per-folder).
      run('UPDATE chats SET folder_id=NULL WHERE folder_id IN (SELECT id FROM folders WHERE project_id=?)', [payload.id]);
      run('DELETE FROM folders WHERE project_id=?', [payload.id]);
      // remove scenes/versions orphaned by the deleted chapters
      run('DELETE FROM scenes WHERE chapter_id NOT IN (SELECT id FROM chapters)');
      run('DELETE FROM chapter_versions WHERE chapter_id NOT IN (SELECT id FROM chapters)');
      return true;
    // folders
    case 'listFolders':
      return all('SELECT * FROM folders ORDER BY position, created_at');
    case 'createFolder': {
      const id = uid();
      run('INSERT INTO folders (id, name, project_id, expanded, position, created_at, workspace) VALUES (?,?,?,1,?,?,?)', [id, payload.name, payload.project_id ?? null, payload.position || 0, now, payload.workspace === 'agent' ? 'agent' : 'chat']);
      return get('SELECT * FROM folders WHERE id = ?', [id]);
    }
    case 'updateFolder': {
      run('UPDATE folders SET name=COALESCE(?,name), expanded=COALESCE(?,expanded) WHERE id=?', [payload.name ?? null, payload.expanded ?? null, payload.id]);
      return get('SELECT * FROM folders WHERE id = ?', [payload.id]);
    }
    case 'deleteFolder':
      run('UPDATE chats SET folder_id=NULL WHERE folder_id=?', [payload.id]);
      run('DELETE FROM folders WHERE id=?', [payload.id]);
      return true;
    // chats
    case 'listChats':
      // Pinned chats first, then recency — matches how the sidebar renders.
      return all('SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC, created_at DESC');
    case 'createChat': {
      const id = uid();
      const workspace = payload.workspace === 'agent' ? 'agent' : 'chat';
      run('INSERT INTO chats (id, title, folder_id, project_id, workspace, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [id, payload.title || 'New chat', payload.folder_id ?? null, payload.project_id ?? null, workspace, now, now]);
      (globalThis as any).__pluginHook?.('chat:new', { chatId: id, title: payload.title || 'New chat' });
      return get('SELECT * FROM chats WHERE id = ?', [id]);
    }
    case 'updateChat': {
      // Tri-state semantics: undefined = keep existing, null = clear, value = set.
      // (The old all-COALESCE version made it impossible to unlink folder/project.)
      const sets: string[] = [];
      const params: any[] = [];
      const fields: [string, any][] = [
        ['title', payload.title],
        ['folder_id', payload.folder_id],
        ['project_id', payload.project_id],
        ['model', payload.model],
        ['system_prompt', payload.system_prompt],
        // Per-chat skill opt-outs, stored as a JSON array of skill ids.
        ['skills_off', payload.skills_off === undefined
          ? undefined
          : JSON.stringify(Array.isArray(payload.skills_off) ? payload.skills_off : [])],
        // Skills switched on for this chat (the /skill command writes here).
        ['skills_on', payload.skills_on === undefined
          ? undefined
          : JSON.stringify(Array.isArray(payload.skills_on) ? payload.skills_on : [])],
        ['chat_mode', payload.chat_mode],
        // Workspace: only the two chat-based sections can own a chat row.
        ['workspace', payload.workspace === undefined ? undefined : (payload.workspace === 'agent' ? 'agent' : 'chat')],
        // Persisted thinking level; anything unknown falls back to 'auto'.
        ['think_level', payload.think_level === undefined
          ? undefined
          : (['auto', 'off', 'low', 'medium', 'high', 'max'].includes(String(payload.think_level))
            ? String(payload.think_level) : 'auto')],
        // Booleans are normalized to 0/1 so SQLite keeps them comparable.
        ['agent_mode', payload.agent_mode === undefined ? undefined : (payload.agent_mode ? 1 : 0)],
        ['pinned', payload.pinned === undefined ? undefined : (payload.pinned ? 1 : 0)]
      ];
      for (const [col, val] of fields) {
        if (val === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(val);
      }
      if (!sets.length) return get('SELECT * FROM chats WHERE id = ?', [payload.id]);
      sets.push('updated_at = ?');
      params.push(now, payload.id);
      run(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`, params);
      return get('SELECT * FROM chats WHERE id = ?', [payload.id]);
    }
    case 'deleteChat':
      run('DELETE FROM message_files WHERE chat_id=?', [payload.id]);
      run('DELETE FROM messages WHERE chat_id=?', [payload.id]);
      run('DELETE FROM chats WHERE id=?', [payload.id]);
      return true;
    // messages
    case 'getMessages': {
      const rows = all('SELECT * FROM messages WHERE chat_id=? ORDER BY created_at', [payload.chatId]);
      // Metadata only — the file bodies can be megabytes and are read lazily
      // by `readMessageFile` when a card is opened. One query per chat keeps
      // long transcripts cheap.
      const byMessage = new Map<string, any[]>();
      for (const f of all('SELECT id, message_id, name, kind, bytes FROM message_files WHERE chat_id=? ORDER BY created_at', [payload.chatId])) {
        const list = byMessage.get(f.message_id) || [];
        list.push(fileMeta(f));
        byMessage.set(f.message_id, list);
      }
      for (const r of rows) {
        r.files = byMessage.get(r.id) || [];
        r.toolSteps = toolStepsOf(r);
      }
      return rows;
    }
    // Paged transcript (v1.2.3 Task 11). `getMessages` still loads a whole chat
    // for export and tests, but the view only ever needs the newest slice: a
    // 5,000-message chat used to put every row in the renderer's memory.
    case 'getMessagePage': {
      const limit = Math.max(1, Math.min(Number(payload.limit) || 80, 500));
      const before = payload.before != null ? Number(payload.before) : null;
      // `rowid` breaks ties: two messages can share a millisecond (a fast paste
      // of a batch, an import), and paging on created_at alone would then skip
      // or repeat rows. rowid is insertion order, which is what "older" means.
      const beforeRow = payload.beforeRow != null ? Number(payload.beforeRow) : null;
      // One extra row tells us whether an older page exists without a COUNT
      // over the whole chat.
      const rows = all(
        before != null && beforeRow != null
          // Row-value comparison is exactly the old OR, but SQLite can turn it
          // into a range seek on (chat_id, created_at) instead of scanning
          // every newer row in the chat before finding the page.
          ? 'SELECT *, rowid AS _row FROM messages WHERE chat_id=? AND (created_at, rowid) < (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT ?'
          : before != null
            ? 'SELECT *, rowid AS _row FROM messages WHERE chat_id=? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
            : 'SELECT *, rowid AS _row FROM messages WHERE chat_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        before != null && beforeRow != null
          ? [payload.chatId, before, beforeRow, limit + 1]
          : before != null
            ? [payload.chatId, before, limit + 1]
            : [payload.chatId, limit + 1]
      );
      const hasMore = rows.length > limit;
      const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
      const byMessage = new Map<string, any[]>();
      const ids = page.map((r: any) => r.id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        for (const f of all(`SELECT id, message_id, name, kind, bytes FROM message_files WHERE message_id IN (${placeholders}) ORDER BY created_at`, ids)) {
          const list = byMessage.get(f.message_id) || [];
          list.push(fileMeta(f));
          byMessage.set(f.message_id, list);
        }
      }
      for (const r of page) {
        r.files = byMessage.get(r.id) || [];
        r.toolSteps = toolStepsOf(r);
      }
      return { rows: page, hasMore };
    }
    case 'listMessageFiles':
      return all('SELECT id, message_id, name, kind, bytes, created_at FROM message_files WHERE message_id=? ORDER BY created_at', [payload.messageId]);
    case 'readMessageFile': {
      const row = get('SELECT id, chat_id, message_id, name, kind, bytes, content, created_at FROM message_files WHERE id=?', [payload.id]);
      if (!row) throw new Error('That file is no longer available — the message it belonged to was deleted.');
      return row;
    }
    case 'clearChatFiles': {
      const before = Number(get('SELECT COUNT(*) AS n FROM message_files')?.n || 0);
      run('DELETE FROM message_files');
      return { removed: before };
    }
    case 'addMessage': {
      // Attachments are validated first: a rejected file must not create an
      // empty user turn that the composer can no longer see.
      const files = Array.isArray(payload.files) ? validateChatFiles(payload.files) : [];
      const id = uid();
      db!.exec('BEGIN');
      try {
        // tokens_in/out ride along when provided (assistant rows from a real
        // generation). NULL for older rows — Usage views treat NULL as unknown.
        run('INSERT INTO messages (id, chat_id, role, content, thinking, model, tokens_in, tokens_out, tokens_cached, parent_id, tools_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, payload.chatId, payload.role, cleanText(payload.content), payload.thinking == null ? null : cleanText(payload.thinking), payload.model ?? null, payload.tokens_in ?? null, payload.tokens_out ?? null, payload.tokens_cached ?? null, payload.parentId ?? null, sanitizeToolSteps(payload.toolSteps), now]);
        for (const f of files) {
          run('INSERT INTO message_files (id, chat_id, message_id, name, kind, bytes, content, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [f.id, payload.chatId, id, f.name, f.kind, f.bytes, f.content, now]);
        }
        run('UPDATE chats SET updated_at=? WHERE id=?', [now, payload.chatId]);
        db!.exec('COMMIT');
      } catch (err) {
        try { db!.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        throw err;
      }
      (globalThis as any).__pluginHook?.('message:new', { chatId: payload.chatId, messageId: id, role: payload.role });
      const row = get('SELECT * FROM messages WHERE id = ?', [id]);
      if (row) row.files = files.map((f) => fileMeta(f));
      return row;
    }
    case 'updateMessage': {
      // Tri-state: undefined keeps the column, null clears it (COALESCE made
      // clearing impossible — e.g. erasing a bad thinking trace).
      const sets: string[] = [];
      const vals: any[] = [];
      if (payload.content !== undefined) { sets.push('content=?'); vals.push(cleanText(payload.content)); }
      if (payload.thinking !== undefined) { sets.push('thinking=?'); vals.push(cleanText(payload.thinking)); }
      if (payload.tokens_in !== undefined) { sets.push('tokens_in=?'); vals.push(payload.tokens_in); }
      if (payload.tokens_out !== undefined) { sets.push('tokens_out=?'); vals.push(payload.tokens_out); }
      if (payload.tokens_cached !== undefined) { sets.push('tokens_cached=?'); vals.push(payload.tokens_cached); }
      if (!sets.length) return get('SELECT * FROM messages WHERE id = ?', [payload.id]);
      vals.push(payload.id);
      run(`UPDATE messages SET ${sets.join(', ')} WHERE id=?`, vals);
      return get('SELECT * FROM messages WHERE id = ?', [payload.id]);
    }
    case 'deleteMessage':
      // Guarded: deleting the message that a live generation is about to
      // append next to would strand the reply (it is saved with the OLD
      // timestamp but a new row id — appearing out of order forever).
      if ((globalThis as any).__busyChats?.has(payload.chatId)) {
        throw new Error('A reply is being generated in this chat — stop it first.');
      }
      run('DELETE FROM message_files WHERE message_id=?', [payload.id]);
      run('DELETE FROM messages WHERE id=?', [payload.id]);
      return true;
    case 'searchMessages': {
      // Full-text-ish search across ALL chats (LIKE is fine at local scale).
      // Returns the latest matching message per row plus per-chat match count.
      const needle = String(payload.q || '').trim();
      if (!needle) return [];
      // Escape LIKE wildcards so searching "100%" or "who?" matches literally
      // instead of silently matching every message. The per-chat match-count
      // subquery used to run WITHOUT its own ESCAPE clause, so wildcards in
      // the needle leaked through and the counts were wrong for those queries.
      const escaped = needle.replace(/[\\%_]/g, (ch) => '\\' + ch);
      const like = `%${escaped}%`;
      return all(
        `SELECT m.id, m.chat_id, m.role, m.content, m.created_at, c.title AS chat_title,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.chat_id = m.chat_id AND m2.content LIKE ? ESCAPE '\\') AS matches
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.content LIKE ? ESCAPE '\\'
          ORDER BY m.created_at DESC LIMIT 20`,
        [like, like]
      );
    }
    // memories
    case 'listMemories':
      return all('SELECT * FROM memories ORDER BY created_at DESC');
    case 'addMemory': {
      const id = uid();
      run('INSERT INTO memories (id, content, source, created_at) VALUES (?,?,?,?)', [id, payload.content, payload.source || 'manual', now]);
      return get('SELECT * FROM memories WHERE id = ?', [id]);
    }
    case 'deleteMemory':
      run('DELETE FROM memories WHERE id=?', [payload.id]);
      return true;
    // story entities
    case 'listStory':
      return all('SELECT * FROM story ORDER BY kind, title').map(normalizeStoryRow);
    case 'createStory': {
      const id = uid();
      run('INSERT INTO story (id, project_id, kind, title, content, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, payload.projectId, payload.kind, payload.title, payload.content || '', storyJsonArray(payload.tags), now, now]);
      return normalizeStoryRow(get('SELECT * FROM story WHERE id = ?', [id]));
    }
    case 'updateStory': {
      run('UPDATE story SET title=?, content=?, tags=?, links=?, updated_at=? WHERE id=?', [payload.title, payload.content, storyJsonArray(payload.tags), storyJsonArray(payload.links), now, payload.id]);
      return normalizeStoryRow(get('SELECT * FROM story WHERE id = ?', [payload.id]));
    }
    case 'deleteStory':
      // Attached reference files die with their entry (no orphan rows).
      run('DELETE FROM story_files WHERE story_id=?', [payload.id]);
      run('DELETE FROM story WHERE id=?', [payload.id]);
      return true;
    // ---- files attached to story-bible entries (v1.2) ----
    // The renderer reads the file text (through the preload bridge) and sends
    // it here; the text is stored locally so the agent can read it with the
    // story tools and the user never has to copy-paste reference material.
    case 'listStoryFiles':
      if (!payload?.projectId) return all('SELECT id, project_id, story_id, name, bytes, created_at FROM story_files ORDER BY created_at DESC');
      return all('SELECT id, project_id, story_id, name, bytes, created_at FROM story_files WHERE project_id=? ORDER BY created_at DESC', [payload.projectId]);
    case 'getStoryFile': {
      const row = get('SELECT * FROM story_files WHERE id=?', [payload.id]);
      if (!row) throw new Error('Attachment not found.');
      return row;
    }
    case 'attachStoryFile': {
      const name = String(payload.name || '').trim().slice(0, 200);
      const content = String(payload.content ?? '');
      if (!name) throw new Error('The file has no name.');
      if (!content.trim()) throw new Error('The file is empty or not readable as text.');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > STORY_FILE_MAX_BYTES) {
        throw new Error(`File is too large (${(bytes / 1024 / 1024).toFixed(1)} MB). The limit is 2 MB per attachment.`);
      }
      let projectId = payload.projectId || null;
      if (!projectId && payload.storyId) {
        const entry = get('SELECT project_id FROM story WHERE id=?', [payload.storyId]);
        projectId = entry?.project_id || null;
      }
      if (!projectId) throw new Error('No project is attached to this entry.');
      const storyId = payload.storyId || null;
      // Re-attaching the same filename refreshes it instead of stacking
      // duplicates (drop the same notes file twice → one chip, new content).
      const existing = storyId
        ? get('SELECT id FROM story_files WHERE story_id=? AND name=?', [storyId, name])
        : get('SELECT id FROM story_files WHERE project_id=? AND story_id IS NULL AND name=?', [projectId, name]);
      if (existing) {
        run('UPDATE story_files SET content=?, bytes=?, created_at=? WHERE id=?', [content, bytes, now, existing.id]);
        return get('SELECT id, project_id, story_id, name, bytes, created_at FROM story_files WHERE id=?', [existing.id]);
      }
      const id = uid();
      run('INSERT INTO story_files (id, project_id, story_id, name, content, bytes, created_at) VALUES (?,?,?,?,?,?,?)',
        [id, projectId, storyId, name, content, bytes, now]);
      return get('SELECT id, project_id, story_id, name, bytes, created_at FROM story_files WHERE id=?', [id]);
    }
    case 'deleteStoryFile':
      run('DELETE FROM story_files WHERE id=?', [payload.id]);
      return true;
    // Search attachment names + text without shipping every file body to the
    // renderer. LIKE wildcards are escaped so "100%" stays literal.
    case 'searchStoryFiles': {
      const needle = String(payload.q || '').trim();
      if (!needle) return [];
      const escaped = needle.replace(/[\\%_]/g, (ch) => '\\' + ch);
      const like = `%${escaped}%`;
      return all(
        `SELECT id, project_id, story_id, name,
                CASE WHEN name LIKE ? ESCAPE '\\' THEN 'name' ELSE 'content' END AS matched_in
           FROM story_files
          WHERE name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
          ORDER BY created_at DESC LIMIT 30`,
        [like, like, like]
      );
    }
    // Bulk import in ONE IPC round-trip (a 300-entry Markdown import used to
    // mean 300 renderer↔main calls). Rows are validated and capped here.
    case 'importStoryEntries': {
      const projectId = String(payload.projectId || '');
      if (!projectId) throw new Error('Choose a project before importing.');
      const rows = Array.isArray(payload.entries) ? payload.entries.slice(0, 500) : [];
      const allowed = new Set(['world', 'location', 'character', 'item', 'lore']);
      let imported = 0;
      for (const e of rows) {
        const kind = String(e?.kind || '');
        const title = String(e?.title || '').trim().slice(0, 200);
        const content = String(e?.content || '');
        if (!allowed.has(kind) || !title || !content.trim()) continue;
        if (Buffer.byteLength(content, 'utf8') > STORY_FILE_MAX_BYTES) continue;
        run('INSERT INTO story (id, project_id, kind, title, content, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [uid(), projectId, kind, title, content, storyJsonArray(e.tags), now, now]);
        imported++;
      }
      return { imported };
    }
    // ---- Story Agent saved plans (v1.2) ----
    case 'listStoryPlans':
      // List view never needs the (potentially large) plan JSON.
      return all('SELECT id, project_id, title, created_at, updated_at FROM story_plans ORDER BY updated_at DESC');
    case 'getStoryPlan': {
      const row = get('SELECT * FROM story_plans WHERE id=?', [payload.id]);
      if (!row) throw new Error('Plan not found.');
      return row;
    }
    case 'saveStoryPlan': {
      const id = payload.id || uid();
      const title = String(payload.title || 'Untitled story plan').slice(0, 200);
      const brief = JSON.stringify(payload.brief ?? {});
      const plan = JSON.stringify(payload.plan ?? {});
      if (plan.length > STORY_FILE_MAX_BYTES * 4) throw new Error('Plan is too large to save.');
      const existing = get('SELECT id FROM story_plans WHERE id=?', [id]);
      if (existing) {
        run('UPDATE story_plans SET project_id=?, title=?, brief=?, plan=?, updated_at=? WHERE id=?',
          [payload.projectId ?? null, title, brief, plan, now, id]);
      } else {
        run('INSERT INTO story_plans (id, project_id, title, brief, plan, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          [id, payload.projectId ?? null, title, brief, plan, now, now]);
      }
      return get('SELECT id, project_id, title, created_at, updated_at FROM story_plans WHERE id=?', [id]);
    }
    case 'deleteStoryPlan':
      run('DELETE FROM story_plans WHERE id=?', [payload.id]);
      return true;
    // Create a whole Plot Smith project (metadata + bible + chapters + flow
    // beats) in ONE IPC call and one persistence pass. The UI used to fire 40+
    // separate dbCall round-trips for a single “Create project” click.
    case 'createProjectFromPlan': {
      const p = payload.project || {};
      const name = String(p.name || '').trim().slice(0, 200);
      if (!name) throw new Error('The project needs a name.');
      const pid = uid();
      run('INSERT INTO projects (id, name, description, context, format, rating, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [pid, name, String(p.description || '').slice(0, 2000), String(p.context || ''), String(p.format || 'novel'), String(p.rating || 'teen'), now, now]);
      const allowedKind = new Set(['world', 'location', 'character', 'item', 'lore']);
      let entryCount = 0;
      for (const e of (Array.isArray(payload.entries) ? payload.entries.slice(0, 200) : [])) {
        const kind = String(e?.kind || '');
        const title = String(e?.title || '').trim().slice(0, 200);
        const content = String(e?.content || '');
        if (!allowedKind.has(kind) || !title || !content.trim()) continue;
        run('INSERT INTO story (id, project_id, kind, title, content, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [uid(), pid, kind, title, content, storyJsonArray(e.tags), now, now]);
        entryCount++;
      }
      let chapterCount = 0;
      for (const c of (Array.isArray(payload.chapters) ? payload.chapters.slice(0, 100) : [])) {
        const title = String(c?.title || '').trim().slice(0, 200);
        if (!title) continue;
        const status = ['draft', 'revising', 'done'].includes(c?.status) ? c.status : 'draft';
        run('INSERT INTO chapters (id, project_id, title, content, status, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [uid(), pid, title, String(c?.content || ''), status, chapterCount, now, now]);
        chapterCount++;
      }
      let beatCount = 0;
      for (const b of (Array.isArray(payload.beats) ? payload.beats.slice(0, 200) : [])) {
        const title = String(b?.title || '').trim().slice(0, 200);
        if (!title) continue;
        const act = Math.min(4, Math.max(1, Number(b?.act) || 1));
        const status = ['planned', 'drafting', 'written'].includes(b?.status) ? b.status : 'planned';
        const maxPos = get('SELECT MAX(position) AS m FROM flow_beats WHERE project_id=? AND act=?', [pid, act]);
        run('INSERT INTO flow_beats (id, project_id, act, title, summary, status, chapter_id, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [uid(), pid, act, title, String(b?.summary || ''), status, null, (maxPos?.m ?? -1) + 1, now, now]);
        beatCount++;
      }
      if (payload.planId) {
        run('UPDATE story_plans SET project_id=?, updated_at=? WHERE id=?', [pid, now, payload.planId]);
      }
      return { project: get('SELECT * FROM projects WHERE id=?', [pid]), entries: entryCount, chapters: chapterCount, beats: beatCount };
    }
    // scenes (chapter beats)
    case 'listScenes':
      return all('SELECT * FROM scenes WHERE chapter_id=? ORDER BY position', [payload.chapterId]);
    case 'createScene': {
      const id = uid();
      const maxPos = get('SELECT MAX(position) AS m FROM scenes WHERE chapter_id=?', [payload.chapterId]);
      run('INSERT INTO scenes (id, chapter_id, title, summary, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [id, payload.chapterId, payload.title || 'New scene', payload.summary || '', (maxPos?.m ?? -1) + 1, now, now]);
      return get('SELECT * FROM scenes WHERE id = ?', [id]);
    }
    case 'updateScene': {
      run('UPDATE scenes SET title=COALESCE(?,title), summary=COALESCE(?,summary), updated_at=? WHERE id=?', [payload.title ?? null, payload.summary ?? null, now, payload.id]);
      return get('SELECT * FROM scenes WHERE id = ?', [payload.id]);
    }
    case 'deleteScene':
      run('DELETE FROM scenes WHERE id=?', [payload.id]);
      return true;

    // ---- story flow beats (outline board) ----
    // Empty projectId lists ALL beats (used by the store on boot); the UI
    // filters by active project client-side.
    case 'listFlowBeats':
      if (!payload?.projectId) return all('SELECT * FROM flow_beats ORDER BY project_id, act, position');
      return all('SELECT * FROM flow_beats WHERE project_id=? ORDER BY act, position', [payload.projectId]);
    case 'createFlowBeat': {
      const id = uid();
      const maxPos = get('SELECT MAX(position) AS m FROM flow_beats WHERE project_id=? AND act=?', [payload.projectId, payload.act || 1]);
      run('INSERT INTO flow_beats (id, project_id, act, title, summary, status, chapter_id, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, payload.projectId, payload.act || 1, payload.title || 'New beat', payload.summary || '', payload.status || 'planned', payload.chapterId || null, (maxPos?.m ?? -1) + 1, now, now]);
      return get('SELECT * FROM flow_beats WHERE id = ?', [id]);
    }
    case 'updateFlowBeat': {
      // Dynamic SET — COALESCE made it impossible to unlink a chapter
      // (chapterId:null was silently ignored) or clear a summary.
      const colMap: Record<string, string> = { act: 'act', title: 'title', summary: 'summary', status: 'status', chapterId: 'chapter_id', position: 'position' };
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [k, col] of Object.entries(colMap)) {
        if (payload[k] !== undefined) { sets.push(`${col}=?`); vals.push(payload[k]); }
      }
      if (!sets.length) return get('SELECT * FROM flow_beats WHERE id = ?', [payload.id]);
      sets.push('updated_at=?');
      vals.push(now, payload.id);
      run(`UPDATE flow_beats SET ${sets.join(', ')} WHERE id=?`, vals);
      return get('SELECT * FROM flow_beats WHERE id = ?', [payload.id]);
    }
    case 'deleteFlowBeat':
      run('DELETE FROM flow_beats WHERE id=?', [payload.id]);
      return true;
    // Reorder within one act: payload.order = [beatId, beatId, …] in new order.
    case 'reorderFlowBeats': {
      const order: string[] = payload.order || [];
      for (let i = 0; i < order.length; i++) {
        run('UPDATE flow_beats SET position=?, updated_at=? WHERE id=?', [i, now, order[i]]);
      }
      return true;
    }
    // Reorder chapters of one project: payload.order = [chapterId, …] in the
    // new reading order (positions are rewritten 0..n-1).
    case 'reorderChapters': {
      const order: string[] = payload.order || [];
      for (let i = 0; i < order.length; i++) {
        run('UPDATE chapters SET position=?, updated_at=? WHERE id=?', [i, now, order[i]]);
      }
      return true;
    }
    // ---- chapter versioning (per-chapter snapshot history) ----
    // 'source' tells where a snapshot came from: 'manual' (History button),
    // 'ai-append' (before a chat reply was appended), 'restore' (before a
    // rollback). The snapshot is taken BEFORE the change so restore can undo
    // any of them.
    case 'listChapterVersions':
      return all('SELECT * FROM chapter_versions WHERE chapter_id=? ORDER BY created_at DESC', [payload.chapterId]);
    case 'countChapterVersions': {
      const r = get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id=?', [payload.chapterId]);
      return r?.n || 0;
    }
    case 'createChapterVersion': {
      const vid = uid();
      const wc = String(payload.content || '').trim() ? String(payload.content).trim().split(/\s+/).length : 0;
      run('INSERT INTO chapter_versions (id, chapter_id, title, content, word_count, source, created_at) VALUES (?,?,?,?,?,?,?)',
        [vid, payload.chapterId, payload.title || '', payload.content || '', wc, payload.source || 'manual', now]);
      // Cap per chapter (cheap storage insurance): keep the newest MAX.
      run('DELETE FROM chapter_versions WHERE chapter_id=? AND id NOT IN (SELECT id FROM chapter_versions WHERE chapter_id=? ORDER BY created_at DESC LIMIT ?)',
        [payload.chapterId, payload.chapterId, CHAPTER_VERSIONS_MAX]);
      return get('SELECT * FROM chapter_versions WHERE id = ?', [vid]);
    }
    case 'deleteChapterVersion':
      run('DELETE FROM chapter_versions WHERE id=?', [payload.id]);
      return true;
    case 'deleteAllChapterVersions':
      run('DELETE FROM chapter_versions WHERE chapter_id=?', [payload.chapterId]);
      return true;

    // ---- Revision Timeline (v1.3.0) ----
    // One timeline over the two histories the manuscript already keeps: full
    // chapter snapshots (chapter_versions) and displaced text (text_dump).
    // Listing returns metadata + a short preview only; the prose is fetched per
    // entry via getRevisionEntry, so opening the timeline never pushes dozens of
    // whole chapters through IPC.
    case 'listRevisionTimeline': {
      const projectId = payload.projectId ? String(payload.projectId) : '';
      const chapterId = payload.chapterId ? String(payload.chapterId) : '';
      const limit = Math.max(1, Math.min(600, Number(payload.limit) || 300));

      const vWhere: string[] = [];
      const vArgs: any[] = [];
      if (projectId) { vWhere.push('c.project_id=?'); vArgs.push(projectId); }
      if (chapterId) { vWhere.push('v.chapter_id=?'); vArgs.push(chapterId); }
      const versionRows = all(`SELECT v.id, v.chapter_id, v.word_count, v.source, v.created_at, v.rowid AS rowid,
          c.title AS chapter_title, substr(v.content, 1, 240) AS preview, length(v.content) AS chars
        FROM chapter_versions v JOIN chapters c ON c.id = v.chapter_id
        ${vWhere.length ? 'WHERE ' + vWhere.join(' AND ') : ''}
        ORDER BY v.chapter_id, v.created_at ASC, v.rowid ASC`, vArgs);

      // Word count AFTER each snapshot: the next snapshot of the same chapter,
      // or the chapter's current text for the newest one. Stored word_count
      // makes this cheap — no content has to leave the main process.
      const chapterRows = all(`SELECT id, title, content FROM chapters
        ${chapterId ? 'WHERE id=?' : projectId ? 'WHERE project_id=?' : ''}`,
        chapterId ? [chapterId] : projectId ? [projectId] : []);
      const currentWords = new Map<string, number>();
      const chapterTitles = new Map<string, string>();
      for (const c of chapterRows) {
        const text = String(c.content || '').trim();
        currentWords.set(c.id, text ? text.split(/\s+/).length : 0);
        chapterTitles.set(c.id, String(c.title || ''));
      }
      const nextWords = new Map<string, number>();
      const byChapter = new Map<string, any[]>();
      for (const row of versionRows) {
        const list = byChapter.get(row.chapter_id);
        if (list) list.push(row); else byChapter.set(row.chapter_id, [row]);
      }
      for (const rows of byChapter.values()) {
        for (let i = 0; i < rows.length; i++) {
          nextWords.set(rows[i].id, i + 1 < rows.length
            ? Number(rows[i + 1].word_count) || 0
            : currentWords.get(rows[i].chapter_id) || 0);
        }
      }

      const dWhere: string[] = [];
      const dArgs: any[] = [];
      if (projectId) { dWhere.push('project_id=?'); dArgs.push(projectId); }
      if (chapterId) { dWhere.push('chapter_id=?'); dArgs.push(chapterId); }
      const dumpRows = all(`SELECT id, chapter_id, chapter_title, source, action, scope, restored_at, created_at,
          substr(original, 1, 240) AS preview, length(original) AS chars
        FROM text_dump ${dWhere.length ? 'WHERE ' + dWhere.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT ?`, [...dArgs, limit]);

      const snippet = (text: any) => String(text || '').replace(/\s+/g, ' ').trim();
      const entries = [
        ...versionRows.map((v: any) => ({
          id: 'v:' + v.id,
          kind: 'version',
          rowId: v.id,
          chapterId: v.chapter_id,
          chapterTitle: String(v.chapter_title || chapterTitles.get(v.chapter_id) || ''),
          at: Number(v.created_at) || 0,
          source: String(v.source || 'manual'),
          action: null,
          scope: 'chapter',
          words: Number(v.word_count) || 0,
          afterWords: nextWords.get(v.id) ?? null,
          chars: Number(v.chars) || 0,
          preview: snippet(v.preview),
          restoredAt: null
        })),
        ...dumpRows.map((d: any) => ({
          id: 'd:' + d.id,
          kind: 'edit',
          rowId: d.id,
          chapterId: d.chapter_id || null,
          chapterTitle: String(d.chapter_title || chapterTitles.get(d.chapter_id) || ''),
          at: Number(d.created_at) || 0,
          source: String(d.source || 'manual'),
          action: String(d.action || 'edit'),
          scope: d.scope === 'chapter' ? 'chapter' : 'passage',
          words: null,
          afterWords: null,
          chars: Number(d.chars) || 0,
          preview: snippet(d.preview),
          restoredAt: d.restored_at == null ? null : Number(d.restored_at)
        }))
      ];
      entries.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
      return entries.slice(0, limit);
    }
    case 'getRevisionEntry': {
      const kind = payload.kind === 'edit' ? 'edit' : 'version';
      if (kind === 'edit') {
        const row = get('SELECT * FROM text_dump WHERE id=?', [payload.id]);
        if (!row) return { ok: false, error: 'missing' };
        const chapter = row.chapter_id ? get('SELECT id, title FROM chapters WHERE id=?', [row.chapter_id]) : undefined;
        return {
          ok: true,
          id: row.id,
          kind,
          chapterId: row.chapter_id || null,
          chapterTitle: String(chapter?.title || row.chapter_title || ''),
          at: Number(row.created_at) || 0,
          source: String(row.source || 'manual'),
          action: String(row.action || 'edit'),
          scope: row.scope === 'chapter' ? 'chapter' : 'passage',
          before: String(row.original || ''),
          after: String(row.replacement || ''),
          startOffset: row.start_offset == null ? null : Number(row.start_offset),
          endOffset: row.end_offset == null ? null : Number(row.end_offset),
          restoredAt: row.restored_at == null ? null : Number(row.restored_at)
        };
      }
      const row = get(`SELECT v.*, v.rowid AS rowid, c.title AS chapter_title, c.content AS current_content
        FROM chapter_versions v LEFT JOIN chapters c ON c.id = v.chapter_id
        WHERE v.id=?`, [payload.id]);
      if (!row) return { ok: false, error: 'missing' };
      const next = get(`SELECT content FROM chapter_versions
        WHERE chapter_id=? AND (created_at > ? OR (created_at = ? AND rowid > ?))
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        [row.chapter_id, row.created_at, row.created_at, row.rowid]);
      return {
        ok: true,
        id: row.id,
        kind,
        chapterId: row.chapter_id,
        chapterTitle: String(row.chapter_title || row.title || ''),
        at: Number(row.created_at) || 0,
        source: String(row.source || 'manual'),
        action: null,
        scope: 'chapter',
        title: String(row.title || ''),
        before: String(row.content || ''),
        after: String(next ? next.content : (row.current_content || '')),
        startOffset: null,
        endOffset: null,
        restoredAt: null
      };
    }
    // Restoring a snapshot is one main-process transaction: snapshot the text
    // being replaced, then write the chosen text. Leaving that to the renderer
    // would risk a half-restore if the second call failed.
    case 'restoreChapterVersion': {
      const v = get('SELECT * FROM chapter_versions WHERE id=?', [payload.id]);
      if (!v) return { ok: false, error: 'missing' };
      const chapter = get('SELECT * FROM chapters WHERE id=?', [v.chapter_id]);
      if (!chapter) return { ok: false, error: 'missing-chapter' };
      const current = String(chapter.content || '');
      const next = String(v.content || '');
      if (current === next) return { ok: true, chapterId: chapter.id, title: chapter.title, content: next };
      const wc = current.trim() ? current.trim().split(/\s+/).length : 0;
      run('INSERT INTO chapter_versions (id, chapter_id, title, content, word_count, source, created_at) VALUES (?,?,?,?,?,?,?)',
        [uid(), chapter.id, chapter.title || '', current, wc, 'restore', now]);
      run('DELETE FROM chapter_versions WHERE chapter_id=? AND id NOT IN (SELECT id FROM chapter_versions WHERE chapter_id=? ORDER BY created_at DESC LIMIT ?)',
        [chapter.id, chapter.id, CHAPTER_VERSIONS_MAX]);
      run('UPDATE chapters SET content=?, updated_at=? WHERE id=?', [next, now, chapter.id]);
      return { ok: true, chapterId: chapter.id, title: chapter.title, content: next };
    }

    // ---- Text Dump: text displaced by an AI edit or a manual save ----
    // The dump stores the OLD text (and, for a replacement, what took its
    // place). Restore is deliberately conservative: if the chapter moved on,
    // it reports a conflict instead of overwriting newer prose.
    case 'listTextDump': {
      if (payload.projectId) {
        return all('SELECT * FROM text_dump WHERE project_id=? ORDER BY created_at DESC LIMIT ?', [payload.projectId, TEXT_DUMP_MAX]);
      }
      return all('SELECT * FROM text_dump ORDER BY created_at DESC LIMIT ?', [TEXT_DUMP_MAX]);
    }
    case 'countTextDumps': {
      const row = get('SELECT COUNT(*) AS n FROM text_dump');
      return row?.n || 0;
    }
    case 'addTextDump': {
      const original = cleanText(payload.original);
      if (!original.trim()) return null; // nothing was displaced
      const chapterId = payload.chapterId ? String(payload.chapterId) : null;
      const replacement = cleanText(payload.replacement);
      // Autosave and a repeated Ctrl+S can produce the same entry twice in a
      // row; one row is enough to recover it.
      const last = get('SELECT * FROM text_dump ORDER BY created_at DESC LIMIT 1');
      if (last && last.chapter_id === chapterId && last.original === original && last.replacement === replacement) {
        return last;
      }
      const allowedActions = ['delete', 'replace', 'edit', 'rephrase', 'expand', 'shrink'];
      const action = allowedActions.includes(String(payload.action)) ? String(payload.action) : 'edit';
      const scope = payload.scope === 'chapter' ? 'chapter' : 'passage';
      const id = uid();
      run('INSERT INTO text_dump (id, project_id, chapter_id, chapter_title, source, action, scope, original, replacement, start_offset, end_offset, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, payload.projectId || null, chapterId, cleanText(payload.chapterTitle).slice(0, 300),
          ['writing', 'agent', 'manual', 'chat'].includes(String(payload.source)) ? String(payload.source) : 'writing',
          action, scope, original.slice(0, 500_000), replacement.slice(0, 500_000),
          Number.isFinite(Number(payload.startOffset)) ? Number(payload.startOffset) : null,
          Number.isFinite(Number(payload.endOffset)) ? Number(payload.endOffset) : null, now]);
      pruneTextDump();
      return get('SELECT * FROM text_dump WHERE id=?', [id]);
    }
    case 'deleteTextDumps': {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((x: any) => typeof x === 'string') : [];
      if (!ids.length) return 0;
      run(`DELETE FROM text_dump WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      return ids.length;
    }
    case 'deleteAllTextDumps': {
      const before = get('SELECT COUNT(*) AS n FROM text_dump')?.n || 0;
      if (payload.projectId) run('DELETE FROM text_dump WHERE project_id=?', [payload.projectId]);
      else run('DELETE FROM text_dump', []);
      return before;
    }
    case 'restoreTextDump': {
      const row = get('SELECT * FROM text_dump WHERE id=?', [payload.id]);
      if (!row) return { ok: false, error: 'missing' };
      const chapter = row.chapter_id ? get('SELECT * FROM chapters WHERE id=?', [row.chapter_id]) : null;
      if (!chapter) return { ok: false, error: 'missing-chapter', row };
      const current = String(chapter.content || '');
      const original = String(row.original || '');
      const replacement = String(row.replacement || '');
      const start = Number(row.start_offset);
      const canSplice = row.scope === 'passage' && Number.isInteger(start) && start >= 0
        && current.slice(start, start + replacement.length) === replacement;
      const canReplace = row.scope === 'chapter' && current === replacement;
      if (!payload.force && !canSplice && !canReplace) {
        // Newer prose sits where the old text used to be. Let the caller decide
        // whether to force a restore rather than silently discarding it.
        return { ok: false, error: 'conflict', row, current };
      }
      let next: string;
      if (canSplice && !payload.force) {
        next = current.slice(0, start) + original + current.slice(start + replacement.length);
      } else if (row.scope === 'chapter' || !canSplice) {
        next = original;
      } else {
        next = current.slice(0, start) + original + current.slice(start + replacement.length);
      }
      // Snapshot what the chapter held immediately before the restore, so the
      // restore itself can be undone from chapter history.
      const wc = current.trim() ? current.trim().split(/\s+/).length : 0;
      run('INSERT INTO chapter_versions (id, chapter_id, title, content, word_count, source, created_at) VALUES (?,?,?,?,?,?,?)',
        [uid(), chapter.id, chapter.title || '', current, wc, 'restore', now]);
      run('UPDATE chapters SET content=?, updated_at=? WHERE id=?', [next, now, chapter.id]);
      run('UPDATE text_dump SET restored_at=? WHERE id=?', [now, row.id]);
      return { ok: true, chapterId: chapter.id, title: chapter.title, content: next };
    }

    // ---- user-defined prompt library ----
    case 'listPrompts':
      return all('SELECT * FROM prompts ORDER BY created_at DESC');
    case 'createPrompt': {
      const id = uid();
      run('INSERT INTO prompts (id, category, title, template, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        [id, payload.category || 'chat', payload.title || 'Untitled prompt', payload.template || '', now, now]);
      return get('SELECT * FROM prompts WHERE id = ?', [id]);
    }
    case 'updatePrompt': {
      run('UPDATE prompts SET category=COALESCE(?,category), title=COALESCE(?,title), template=COALESCE(?,template), updated_at=? WHERE id=?',
        [payload.category ?? null, payload.title ?? null, payload.template ?? null, now, payload.id]);
      return get('SELECT * FROM prompts WHERE id = ?', [payload.id]);
    }
    case 'deletePrompt':
      run('DELETE FROM prompts WHERE id=?', [payload.id]);
      return true;
    // ---- token usage summary (Usage section in Settings) ----
    case 'usageSummary': {
      // Only rows with actual token data are counted; old messages (NULL)
      // are simply absent rather than guessed twice.
      const byModel = all(`SELECT model, COUNT(*) AS messages, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_cached) AS cached
        FROM messages WHERE model IS NOT NULL AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)
        GROUP BY model ORDER BY tout DESC`);
      const byChat = all(`SELECT c.id, c.title, COUNT(*) AS messages, SUM(m.tokens_in) AS tin, SUM(m.tokens_out) AS tout, SUM(m.tokens_cached) AS cached
        FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.model IS NOT NULL AND (m.tokens_in IS NOT NULL OR m.tokens_out IS NOT NULL)
        GROUP BY c.id ORDER BY tout DESC LIMIT 10`);
      const total = get(`SELECT COUNT(*) AS messages, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_cached) AS cached
        FROM messages WHERE tokens_in IS NOT NULL OR tokens_out IS NOT NULL`);
      return { byModel, byChat, total };
    }
    // ---- reply styles (Claude-style persona for the assistant) ----
    case 'listStyles':
      return all('SELECT * FROM prompt_styles ORDER BY builtin DESC, created_at');
    case 'saveStyle': {
      // Upsert. Builtin rows are updated IN PLACE (builtin flag preserved) so
      // re-seeding on upgrade can never duplicate them; only name/content.
      const existing = payload.id ? get('SELECT id, builtin FROM prompt_styles WHERE id=?', [payload.id]) : undefined;
      if (existing) {
        run('UPDATE prompt_styles SET name=?, content=?, updated_at=? WHERE id=?', [payload.name, payload.content, now, payload.id]);
        return get('SELECT * FROM prompt_styles WHERE id=?', [payload.id]);
      }
      const id = uid();
      run('INSERT INTO prompt_styles (id, name, content, builtin, created_at, updated_at) VALUES (?,?,?,0,?,?)', [id, payload.name, payload.content, now, now]);
      return get('SELECT * FROM prompt_styles WHERE id=?', [id]);
    }
    case 'deleteStyle': {
      // Builtin styles are permanent — delete is refused rather than silently
      // ignored so the UI can say why.
      const row = get('SELECT builtin FROM prompt_styles WHERE id=?', [payload.id]);
      if (!row) return true;
      if (row.builtin) throw new Error('Built-in styles cannot be deleted — edit them instead.');
      run('DELETE FROM prompt_styles WHERE id=?', [payload.id]);
      return true;
    }
    // chapters
    case 'listAllChapters':
      return all('SELECT * FROM chapters ORDER BY position');
    case 'listChapters':
      return all('SELECT * FROM chapters WHERE project_id=? ORDER BY position', [payload.projectId]);
    case 'createChapter': {
      const id = uid();
      const maxPos = get('SELECT MAX(position) AS m FROM chapters WHERE project_id=?', [payload.projectId]);
      run('INSERT INTO chapters (id, project_id, title, content, status, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, payload.projectId, payload.title, payload.content || '', payload.status || 'draft', (maxPos?.m ?? -1) + 1, now, now]);
      return get('SELECT * FROM chapters WHERE id = ?', [id]);
    }
    case 'updateChapter': {
      // Normalised before binding: a non-string title/content (a renderer bug,
      // or an object whose toString throws) used to break the whole write.
      const chTitle = payload.title == null ? null : cleanText(payload.title);
      const chContent = payload.content == null ? null : cleanText(payload.content);
      const chStatus = payload.status == null ? null : String(payload.status);
      run('UPDATE chapters SET title=COALESCE(?,title), content=COALESCE(?,content), status=COALESCE(?,status), updated_at=? WHERE id=?', [chTitle, chContent, chStatus, now, payload.id]);
      return get('SELECT * FROM chapters WHERE id = ?', [payload.id]);
    }
    case 'deleteChapter':
      run('DELETE FROM scenes WHERE chapter_id=?', [payload.id]);
      // Flow beats keep a dangling chapter_id here — the Flow board then
      // rendered a dead link (and the beat could never be relinked cleanly).
      run('UPDATE flow_beats SET chapter_id=NULL WHERE chapter_id=?', [payload.id]);
      // Snapshots die with their chapter — no orphans, no unbounded growth.
      run('DELETE FROM chapter_versions WHERE chapter_id=?', [payload.id]);
      run('DELETE FROM chapters WHERE id=?', [payload.id]);
      return true;
    // providers
    case 'listProviders':
      // The key never leaves the main process: the renderer gets identity plus
      // a has_key flag. Generation and discovery resolve the secret by id.
      return all('SELECT * FROM providers ORDER BY created_at').map(publicProviderRow);
    case 'createProvider': {
      const id = uid();
      run('INSERT INTO providers (id, name, base_url, api_key, enabled, models, kind, created_at) VALUES (?,?,?,?,?,?,?,?)', [id, payload.name, payload.baseUrl, protectKey(payload.apiKey || ''), payload.enabled === false ? 0 : 1, JSON.stringify(payload.models || []), payload.kind || 'auto', now]);
      return publicProviderRow(get('SELECT * FROM providers WHERE id = ?', [id]));
    }
    case 'updateProvider': {
      // Partial-payload safe: undefined fields keep their stored value (the
      // old direct-SET version threw on undefined bindings or silently reset
      // name/baseUrl when a caller sent only the changed field).
      // undefined and null both mean "keep the stored key" — the UI sends null
      // when the user has not typed a replacement.
      const encKey = payload.apiKey === undefined || payload.apiKey === null
        ? null
        : protectKey(String(payload.apiKey));
      run(
        'UPDATE providers SET name=COALESCE(?,name), base_url=COALESCE(?,base_url), '
        + 'api_key=CASE WHEN ? IS NOT NULL THEN ? ELSE api_key END, '
        + 'enabled=COALESCE(?,enabled), models=COALESCE(?,models), kind=COALESCE(?,kind) WHERE id=?',
        [
          payload.name ?? null,
          payload.baseUrl ?? null,
          encKey, encKey,
          payload.enabled === undefined ? null : (payload.enabled === false ? 0 : 1),
          payload.models === undefined ? null : JSON.stringify(Array.isArray(payload.models) ? payload.models : []),
          payload.kind ?? null,
          payload.id
        ]
      );
      return publicProviderRow(get('SELECT * FROM providers WHERE id = ?', [payload.id]));
    }
    case 'deleteProvider':
      run('DELETE FROM providers WHERE id=?', [payload.id]);
      return true;
    // plugins / skills / automations / mcp
    case 'listPlugins':
      return all('SELECT * FROM plugins');
    case 'savePlugin': {
      run('INSERT INTO plugins (id, name, code, enabled) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, enabled=excluded.enabled', [payload.id || uid(), payload.name, payload.code, payload.enabled === false ? 0 : 1]);
      return true;
    }
    case 'deletePlugin':
      run('DELETE FROM plugins WHERE id=?', [payload.id]);
      return true;
    case 'listSkills':
      return all('SELECT * FROM skills ORDER BY builtin DESC, name');
    case 'saveSkill': {
      const id = payload.id || uid();
      const existing = get('SELECT id, builtin, category FROM skills WHERE id=?', [id]);
      // A brand-new skill starts DISABLED unless the caller explicitly enables
      // it. An added skill silently changing every reply is the bug this
      // release exists to kill.
      const enabled = payload.enabled === undefined
        ? 0
        : (payload.enabled === true || payload.enabled === 1 ? 1 : 0);
      const description = String(payload.description ?? '').slice(0, 500);
      const requestedCategory = String(payload.category ?? '');
      const category = ['chat', 'agent', 'writing'].includes(requestedCategory)
        ? requestedCategory
        : String(existing?.category || 'writing');
      if (existing) {
        run('UPDATE skills SET name=?, description=?, content=?, enabled=?, category=? WHERE id=?', [
          payload.name, description, payload.content, enabled, category, id
        ]);
      } else {
        run('INSERT INTO skills (id, name, description, content, enabled, builtin, category) VALUES (?,?,?,?,?,0,?)', [
          id, payload.name, description, payload.content, enabled, category
        ]);
      }
      return get('SELECT * FROM skills WHERE id=?', [id]);
    }
    case 'resetSkill': {
      const shipped = DEFAULT_SKILLS.find((s) => s.id === payload.id);
      if (!shipped) throw new Error('Only builtin skills can be reset');
      run('UPDATE skills SET name=?, description=?, content=?, builtin=1, category=? WHERE id=?', [
        shipped.name, shipped.description, shipped.content, shipped.category, shipped.id
      ]);
      return get('SELECT * FROM skills WHERE id=?', [shipped.id]);
    }
    case 'deleteSkill': {
      const row = get('SELECT builtin FROM skills WHERE id=?', [payload.id]);
      if (row?.builtin) throw new Error('Builtin skills cannot be deleted — use Reset instead');
      run('DELETE FROM skills WHERE id=?', [payload.id]);
      return true;
    }
    case 'listAutomations':
      return all('SELECT * FROM automations');
    case 'saveAutomation': {
      run('INSERT INTO automations (id, name, trigger, action, param, enabled) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, trigger=excluded.trigger, action=excluded.action, param=excluded.param, enabled=excluded.enabled', [payload.id || uid(), payload.name, payload.trigger, payload.action, payload.param || '', payload.enabled === false ? 0 : 1]);
      return true;
    }
    case 'deleteAutomation':
      run('DELETE FROM automations WHERE id=?', [payload.id]);
      return true;
    case 'clearMemories':
      run('DELETE FROM memories');
      return true;
    case 'listMcpServers':
      return all('SELECT * FROM mcp_servers');
    case 'saveMcpServer': {
      // `env` stays as the caller sent it: invalid JSON is stored raw and the
      // bridge falls back to an empty map, rather than silently dropping it.
      const env = typeof payload.env === 'string' ? payload.env : JSON.stringify(payload.env || {});
      run('INSERT INTO mcp_servers (id, name, command, args, env, enabled) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, command=excluded.command, args=excluded.args, env=excluded.env, enabled=excluded.enabled', [payload.id || uid(), payload.name, payload.command, payload.args || '[]', env, payload.enabled === false ? 0 : 1]);
      return true;
    }
    case 'deleteMcpServer':
      run('DELETE FROM mcp_servers WHERE id=?', [payload.id]);
      return true;
    case 'resetAll':
      if (db) {
        // A reset is destructive and irreversible from inside the app. Keep a
        // discoverable Time Machine copy first; if it cannot be written, abort
        // instead of deleting the only copy of the user's work.
        writeSnapshotFile(path.dirname(dbFile), path.basename(dbFile), db.export(), 'pre-reset');
        db.exec('DELETE FROM settings; DELETE FROM projects; DELETE FROM folders; DELETE FROM chats; DELETE FROM messages; DELETE FROM message_files; DELETE FROM memories; DELETE FROM story; DELETE FROM chapters; DELETE FROM providers; DELETE FROM plugins; DELETE FROM skills; DELETE FROM automations; DELETE FROM mcp_servers; DELETE FROM scenes; DELETE FROM flow_beats; DELETE FROM prompts; DELETE FROM chapter_versions; DELETE FROM prompt_styles; DELETE FROM story_files; DELETE FROM story_plans; DELETE FROM text_dump;');
        // Builtin styles and skills are permanent furniture — re-seed
        // immediately so the user never sees an empty picker until the next
        // app start. Both stay DISABLED-free by shipping enabled for skills
        // (the shipped set is meant to be active) but a reset is a fresh start.
        for (const s of DEFAULT_STYLES) {
          const stmt = db.prepare('INSERT INTO prompt_styles (id, name, content, builtin, created_at, updated_at) VALUES (?,?,?,1,?,?)');
          stmt.bind([s.id, s.name, s.content, now, now]);
          stmt.step();
          stmt.free();
        }
        for (const s of DEFAULT_SKILLS) {
          run('INSERT INTO skills (id, name, description, content, enabled, builtin, category) VALUES (?,?,?,?,0,1,?)', [s.id, s.name, s.description, s.content, s.category]);
        }
        dirty = true;
        persistNow();
      }
      return true;
    // ---- maintenance (Settings → Data) ----
    case 'dbStats': {
      let bytes = 0;
      try { bytes = fs.statSync(dbFile).size; } catch { /* not written yet */ }
      const count = (t: string) => {
        try { return Number(get(`SELECT COUNT(*) AS n FROM ${t}`)?.n || 0); } catch { return 0; }
      };
      const byteSum = (t: string, col: string) => {
        try { return Number(get(`SELECT SUM(${col}) AS n FROM ${t}`)?.n || 0); } catch { return 0; }
      };
      return {
        bytes,
        path: dbFile,
        messages: count('messages'),
        chats: count('chats'),
        chapters: count('chapters'),
        story: count('story'),
        storyFiles: count('story_files'),
        chatFiles: count('message_files'),
        chatFileBytes: byteSum('message_files', 'bytes'),
        versions: count('chapter_versions')
      };
    }
    case 'compactDb': {
      // VACUUM rebuilds the file without free pages / orphan blobs. sql.js is
      // in-memory so it costs one temporary copy — persistence then rewrites
      // the file once. Also prune orphaned rows from older versions.
      run('DELETE FROM story_files WHERE project_id NOT IN (SELECT id FROM projects)');
      run('DELETE FROM story_files WHERE story_id IS NOT NULL AND story_id NOT IN (SELECT id FROM story)');
      run('DELETE FROM story_plans WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)');
      // Order matters: drop orphan messages first, then their attachments
      // (a file whose message was just removed must not survive the pass).
      run('DELETE FROM messages WHERE chat_id NOT IN (SELECT id FROM chats)');
      run('DELETE FROM message_files WHERE chat_id NOT IN (SELECT id FROM chats) OR message_id NOT IN (SELECT id FROM messages)');
      // Recovery rows for chapters/projects that no longer exist are dead
      // weight: they can never be restored, but sql.js still holds every byte
      // in RAM until they are pruned.
      run('DELETE FROM text_dump WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)');
      run('DELETE FROM text_dump WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT id FROM chapters)');
      run('DELETE FROM scenes WHERE chapter_id NOT IN (SELECT id FROM chapters)');
      try { db?.exec('VACUUM'); } catch (e) { console.warn('VACUUM skipped:', e); }
      dirty = true;
      persistNow(true);
      return { ok: true };
    }
    default:
      throw new Error('Unknown db op: ' + op);
  }
}

/**
 * The stored credentials for one provider. Main-process only: this is the one
 * place a decrypted API key is read, so the renderer never holds one.
 */
export function providerSecret(id: string): {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: string;
  models: string[];
  enabled: boolean;
} | null {
  if (!id) return null;
  let row: any;
  try {
    row = get('SELECT * FROM providers WHERE id = ?', [String(id)]);
  } catch {
    return null;
  }
  if (!row) return null;
  let models: string[] = [];
  try {
    const parsed = JSON.parse(String(row.models || '[]'));
    if (Array.isArray(parsed)) models = parsed.map((m) => String(m));
  } catch { /* legacy or hand-edited row */ }
  return {
    id: String(row.id),
    name: String(row.name || 'provider'),
    baseUrl: String(row.base_url || ''),
    apiKey: unprotectKey(String(row.api_key || '')),
    kind: String(row.kind || 'auto'),
    models,
    enabled: Number(row.enabled) === 1
  };
}

export function closeDb(): void {
  if (saveTimer) clearTimeout(saveTimer);
  persistNow(true);
  if (db) db.close();
  db = null;
  dirty = false;
}
