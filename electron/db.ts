import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  context TEXT DEFAULT '', format TEXT DEFAULT 'novel', rating TEXT DEFAULT 'teen',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT DEFAULT NULL,
  expanded INTEGER DEFAULT 1, position INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT DEFAULT 'New chat', folder_id TEXT DEFAULT NULL,
  project_id TEXT DEFAULT NULL, model TEXT DEFAULT NULL,
  system_prompt TEXT DEFAULT NULL, pinned INTEGER DEFAULT 0,
  skills_off TEXT DEFAULT '[]',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT DEFAULT '', thinking TEXT DEFAULT NULL,
  model TEXT DEFAULT NULL, tokens_in INTEGER, tokens_out INTEGER,
  tokens_cached INTEGER, created_at INTEGER
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
  source TEXT DEFAULT 'user', updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT, trigger TEXT, action TEXT, param TEXT DEFAULT '', enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT, command TEXT, args TEXT, enabled INTEGER DEFAULT 1);
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
CREATE INDEX IF NOT EXISTS idx_story_project ON story(project_id);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_flow_project ON flow_beats(project_id);
CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id);
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
export const SCHEMA_VERSION = 4;

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
      run('INSERT INTO skills (id, name, description, content, enabled, builtin) VALUES (?,?,?,?,1,1)', [s.id, s.name, s.description, s.content]);
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
export const DEFAULT_SKILLS: Array<{ id: string; name: string; description: string; content: string }> = [
  {
    id: 'skill-continuity',
    name: 'Continuity Guardian',
    description: 'Checks new facts against canon before writing them down.',
    content: 'Before adding any story fact (name, place, date, ability, relationship), search the story bible and read the relevant chapter. If the new fact conflicts with established canon, say so and propose the smallest change that preserves both.'
  },
  {
    id: 'skill-prose',
    name: 'Prose Polisher',
    description: 'Tightens prose and explains every change.',
    content: 'When asked to improve prose: cut filler words, vary sentence length, replace weak verbs + adverbs with strong verbs, and prefer concrete sensory detail. Show the revised passage first, then a short bullet list of what changed and why.'
  },
  {
    id: 'skill-dialogue',
    name: 'Dialogue Coach',
    description: 'Gives every character a distinct, testable voice.',
    content: 'Give each character a distinct voice: vocabulary, rhythm, and what they leave unsaid. When writing dialogue, read it back per character; if two voices could swap lines unnoticed, differentiate them. Use subtext — characters rarely state feelings directly.'
  },
  {
    id: 'skill-pacing',
    name: 'Pacing Analyst',
    description: 'Finds scenes that run long without a turn.',
    content: 'When reviewing chapters, track scene-level pacing: goal, conflict, disaster/turn per scene. Flag scenes that run long without a turn, summarize slow middle stretches, and suggest where to cut or add a beat. Reference the story flow board when it exists.'
  },
  {
    id: 'skill-beta-reader',
    name: 'Beta Reader',
    description: 'Reads a draft the way a first-time reader would.',
    content: 'Read the passage once as a first-time reader, then report: where you got confused, where you got bored, where you got hooked, and the one thing you would change first. Quote the exact lines you reacted to, and separate "this is broken" from "this is not to my taste".'
  },
  {
    id: 'skill-architect',
    name: 'Worldbuilding Architect',
    description: 'Builds settings from consequences, not decoration.',
    content: 'When inventing a place, culture or system, start from one constraint (geography, scarcity, magic cost, power structure) and derive the consequences people would actually live with: work, food, etiquette, taboos, slang. Store durable facts as story bible entries; keep flavour text out of canon.'
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
  const now = Date.now();
  switch (op) {
    // settings
    case 'getAllSettings':
      return Object.fromEntries(all('SELECT key, value FROM settings').map((r: any) => [r.key, r.value]));
    case 'setSetting': {
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [payload.key, payload.value]);
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
      run('INSERT INTO folders (id, name, project_id, expanded, position, created_at) VALUES (?,?,?,1,?,?)', [id, payload.name, payload.project_id ?? null, payload.position || 0, now]);
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
      run('INSERT INTO chats (id, title, folder_id, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?)', [id, payload.title || 'New chat', payload.folder_id ?? null, payload.project_id ?? null, now, now]);
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
        // Booleans are normalized to 0/1 so SQLite keeps them comparable.
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
      for (const r of rows) r.files = byMessage.get(r.id) || [];
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
          ? 'SELECT *, rowid AS _row FROM messages WHERE chat_id=? AND (created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?'
          : before != null
            ? 'SELECT *, rowid AS _row FROM messages WHERE chat_id=? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
            : 'SELECT *, rowid AS _row FROM messages WHERE chat_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        before != null && beforeRow != null
          ? [payload.chatId, before, before, beforeRow, limit + 1]
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
      for (const r of page) r.files = byMessage.get(r.id) || [];
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
        run('INSERT INTO messages (id, chat_id, role, content, thinking, model, tokens_in, tokens_out, tokens_cached, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [id, payload.chatId, payload.role, payload.content, payload.thinking ?? null, payload.model ?? null, payload.tokens_in ?? null, payload.tokens_out ?? null, payload.tokens_cached ?? null, now]);
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
      if (payload.content !== undefined) { sets.push('content=?'); vals.push(payload.content); }
      if (payload.thinking !== undefined) { sets.push('thinking=?'); vals.push(payload.thinking); }
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
      run('UPDATE chapters SET title=COALESCE(?,title), content=COALESCE(?,content), status=COALESCE(?,status), updated_at=? WHERE id=?', [payload.title ?? null, payload.content ?? null, payload.status ?? null, now, payload.id]);
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
      // api_key is decrypted for the app; only the DB file itself holds ciphertext
      return all('SELECT * FROM providers ORDER BY created_at').map((r: any) => ({ ...r, api_key: unprotectKey(r.api_key) }));
    case 'createProvider': {
      const id = uid();
      run('INSERT INTO providers (id, name, base_url, api_key, enabled, models, kind, created_at) VALUES (?,?,?,?,?,?,?,?)', [id, payload.name, payload.baseUrl, protectKey(payload.apiKey || ''), payload.enabled === false ? 0 : 1, JSON.stringify(payload.models || []), payload.kind || 'auto', now]);
      return get('SELECT * FROM providers WHERE id = ?', [id]);
    }
    case 'updateProvider': {
      // Partial-payload safe: undefined fields keep their stored value (the
      // old direct-SET version threw on undefined bindings or silently reset
      // name/baseUrl when a caller sent only the changed field).
      const encKey = payload.apiKey === undefined ? null : protectKey(String(payload.apiKey));
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
      return get('SELECT * FROM providers WHERE id = ?', [payload.id]);
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
      const existing = get('SELECT id, builtin FROM skills WHERE id=?', [id]);
      // A brand-new skill starts DISABLED unless the caller explicitly enables
      // it. An added skill silently changing every reply is the bug this
      // release exists to kill.
      const enabled = payload.enabled === undefined
        ? 0
        : (payload.enabled === true || payload.enabled === 1 ? 1 : 0);
      const description = String(payload.description ?? '').slice(0, 500);
      if (existing) {
        run('UPDATE skills SET name=?, description=?, content=?, enabled=? WHERE id=?', [
          payload.name, description, payload.content, enabled, id
        ]);
      } else {
        run('INSERT INTO skills (id, name, description, content, enabled, builtin) VALUES (?,?,?,?,?,0)', [
          id, payload.name, description, payload.content, enabled
        ]);
      }
      return get('SELECT * FROM skills WHERE id=?', [id]);
    }
    case 'resetSkill': {
      const shipped = DEFAULT_SKILLS.find((s) => s.id === payload.id);
      if (!shipped) throw new Error('Only builtin skills can be reset');
      run('UPDATE skills SET name=?, description=?, content=?, builtin=1 WHERE id=?', [
        shipped.name, shipped.description, shipped.content, shipped.id
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
      run('INSERT INTO mcp_servers (id, name, command, args, enabled) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, command=excluded.command, args=excluded.args, enabled=excluded.enabled', [payload.id || uid(), payload.name, payload.command, payload.args || '[]', payload.enabled === false ? 0 : 1]);
      return true;
    }
    case 'deleteMcpServer':
      run('DELETE FROM mcp_servers WHERE id=?', [payload.id]);
      return true;
    case 'resetAll':
      if (db) {
        db.exec('DELETE FROM settings; DELETE FROM projects; DELETE FROM folders; DELETE FROM chats; DELETE FROM messages; DELETE FROM message_files; DELETE FROM memories; DELETE FROM story; DELETE FROM chapters; DELETE FROM providers; DELETE FROM plugins; DELETE FROM skills; DELETE FROM automations; DELETE FROM mcp_servers; DELETE FROM scenes; DELETE FROM flow_beats; DELETE FROM prompts; DELETE FROM chapter_versions; DELETE FROM prompt_styles; DELETE FROM story_files; DELETE FROM story_plans;');
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
          run('INSERT INTO skills (id, name, description, content, enabled, builtin) VALUES (?,?,?,?,1,1)', [s.id, s.name, s.description, s.content]);
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
      try { db?.exec('VACUUM'); } catch (e) { console.warn('VACUUM skipped:', e); }
      dirty = true;
      persistNow(true);
      return { ok: true };
    }
    default:
      throw new Error('Unknown db op: ' + op);
  }
}

export function closeDb(): void {
  if (saveTimer) clearTimeout(saveTimer);
  persistNow(true);
  if (db) db.close();
  db = null;
  dirty = false;
}
