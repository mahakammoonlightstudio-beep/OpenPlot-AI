import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let db: Database | null = null;
let dbFile = '';
let saveTimer: NodeJS.Timeout | null = null;

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
  system_prompt TEXT DEFAULT NULL, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT DEFAULT '', thinking TEXT DEFAULT NULL,
  model TEXT DEFAULT NULL, created_at INTEGER
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
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT, content TEXT, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT, trigger TEXT, action TEXT, enabled INTEGER DEFAULT 1);
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
`;

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
  if (fs.existsSync(dbFile)) {
    db = new SQL.Database(fs.readFileSync(dbFile));
  } else {
    db = new SQL.Database();
  }
  db.exec(SCHEMA);
  // lightweight migrations for pre-existing DBs
  try { db.exec("ALTER TABLE story ADD COLUMN links TEXT DEFAULT '[]'"); } catch { /* column exists */ }
  try { db.exec("ALTER TABLE providers ADD COLUMN kind TEXT DEFAULT 'auto'"); } catch { /* column exists */ }
  try { db.exec("ALTER TABLE automations ADD COLUMN param TEXT DEFAULT ''"); } catch { /* column exists */ }
  try { db.exec("ALTER TABLE projects ADD COLUMN format TEXT DEFAULT 'novel'"); } catch { /* column exists */ }
  try { db.exec("ALTER TABLE projects ADD COLUMN rating TEXT DEFAULT 'teen'"); } catch { /* column exists */ }
  seedDefaults();
  persistNow();
  return dbFile;
}

// First-run seeding: ships a sensible default agent persona and two starter
// automations so the automation engine is discoverable out of the box.
function seedDefaults(): void {
  if (!db) return;
  try {
    const hasAgent = all("SELECT value FROM settings WHERE key='agentMd'");
    if (!hasAgent.length) {
      const stmt = db.prepare("INSERT INTO settings (key, value) VALUES ('agentMd', ?)");
      stmt.bind([JSON.stringify(DEFAULT_AGENT_MD)]);
      stmt.step();
      stmt.free();
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
  } catch (e) {
    console.error('seedDefaults failed:', e);
  }
}

export const DEFAULT_AGENT_MD = `You are OpenPlot, a focused AI writing and chat assistant living inside a local-first story studio.

## Style
- Match the user's language (English or Indonesian) and their tone.
- Prose first: concrete detail, active voice, no filler.
- When writing fiction, keep continuity with the story bible; use your story tools to check facts before inventing them.

## Behavior
- Use save_memory for durable user preferences, create/update_story_entry for worldbuilding, and chapter tools for drafts.
- Ask at most one clarifying question when a request is ambiguous; otherwise make a reasonable creative choice and say so.
- Keep chat replies tight; put long-form output in chapters when asked.`;

export function persistNow(): void {
  if (!db || !dbFile) return;
  try {
    const data = Buffer.from(db.export());
    fs.writeFileSync(dbFile, data);
  } catch (e) {
    console.error('DB persist failed:', e);
  }
}

function schedulePersist(): void {
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
      // Messages live on the deleted chats — remove them first or they stay
      // orphaned in the DB forever (they were never cleaned up before).
      run('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE project_id=?)', [payload.id]);
      run('DELETE FROM chats WHERE project_id=?', [payload.id]);
      run('DELETE FROM story WHERE project_id=?', [payload.id]);
      run('DELETE FROM chapters WHERE project_id=?', [payload.id]);
      run('DELETE FROM flow_beats WHERE project_id=?', [payload.id]);
      run('DELETE FROM folders WHERE project_id=?', [payload.id]);
      // remove scenes orphaned by the deleted chapters
      run('DELETE FROM scenes WHERE chapter_id NOT IN (SELECT id FROM chapters)');
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
      return all('SELECT * FROM chats ORDER BY updated_at DESC, created_at DESC');
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
        ['system_prompt', payload.system_prompt]
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
      run('DELETE FROM messages WHERE chat_id=?', [payload.id]);
      run('DELETE FROM chats WHERE id=?', [payload.id]);
      return true;
    // messages
    case 'getMessages':
      return all('SELECT * FROM messages WHERE chat_id=? ORDER BY created_at', [payload.chatId]);
    case 'addMessage': {
      const id = uid();
      run('INSERT INTO messages (id, chat_id, role, content, thinking, model, created_at) VALUES (?,?,?,?,?,?,?)', [id, payload.chatId, payload.role, payload.content, payload.thinking ?? null, payload.model ?? null, now]);
      run('UPDATE chats SET updated_at=? WHERE id=?', [now, payload.chatId]);
      (globalThis as any).__pluginHook?.('message:new', { chatId: payload.chatId, messageId: id, role: payload.role });
      return get('SELECT * FROM messages WHERE id = ?', [id]);
    }
    case 'updateMessage': {
      run('UPDATE messages SET content=COALESCE(?,content), thinking=COALESCE(?,thinking) WHERE id=?', [payload.content ?? null, payload.thinking ?? null, payload.id]);
      return get('SELECT * FROM messages WHERE id = ?', [payload.id]);
    }
    case 'deleteMessage':
      run('DELETE FROM messages WHERE id=?', [payload.id]);
      return true;
    case 'searchMessages': {
      // Full-text-ish search across ALL chats (LIKE is fine at local scale).
      // Returns the latest matching message per row plus per-chat match count.
      const needle = String(payload.q || '').trim();
      if (!needle) return [];
      // Escape LIKE wildcards so searching "100%" or "who?" matches literally
      // instead of silently matching every message.
      const escaped = needle.replace(/[\\%_]/g, (ch) => '\\' + ch);
      const like = `%${escaped}%`;
      return all(
        `SELECT m.id, m.chat_id, m.role, m.content, m.created_at, c.title AS chat_title,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.chat_id = m.chat_id AND m2.content LIKE ?) AS matches
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
      return all('SELECT * FROM story ORDER BY kind, title');
    case 'createStory': {
      const id = uid();
      run('INSERT INTO story (id, project_id, kind, title, content, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, payload.projectId, payload.kind, payload.title, payload.content || '', JSON.stringify(payload.tags || []), now, now]);
      return get('SELECT * FROM story WHERE id = ?', [id]);
    }
    case 'updateStory': {
      run('UPDATE story SET title=?, content=?, tags=?, links=?, updated_at=? WHERE id=?', [payload.title, payload.content, JSON.stringify(payload.tags || []), JSON.stringify(payload.links || []), now, payload.id]);
      return get('SELECT * FROM story WHERE id = ?', [payload.id]);
    }
    case 'deleteStory':
      run('DELETE FROM story WHERE id=?', [payload.id]);
      return true;
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
      run('UPDATE providers SET name=?, base_url=?, api_key=?, enabled=?, models=?, kind=? WHERE id=?', [payload.name, payload.baseUrl, protectKey(payload.apiKey || ''), payload.enabled === false ? 0 : 1, JSON.stringify(payload.models || []), payload.kind || 'auto', payload.id]);
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
      return all('SELECT * FROM skills');
    case 'saveSkill': {
      run('INSERT INTO skills (id, name, content, enabled) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, content=excluded.content, enabled=excluded.enabled', [payload.id || uid(), payload.name, payload.content, payload.enabled === false ? 0 : 1]);
      return true;
    }
    case 'deleteSkill':
      run('DELETE FROM skills WHERE id=?', [payload.id]);
      return true;
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
        db.exec('DELETE FROM settings; DELETE FROM projects; DELETE FROM folders; DELETE FROM chats; DELETE FROM messages; DELETE FROM memories; DELETE FROM story; DELETE FROM chapters; DELETE FROM providers; DELETE FROM plugins; DELETE FROM skills; DELETE FROM automations; DELETE FROM mcp_servers; DELETE FROM scenes; DELETE FROM flow_beats; DELETE FROM prompts; DELETE FROM chapter_versions;');
        persistNow();
      }
      return true;
    default:
      throw new Error('Unknown db op: ' + op);
  }
}

export function closeDb(): void {
  if (saveTimer) clearTimeout(saveTimer);
  persistNow();
  if (db) db.close();
  db = null;
}
