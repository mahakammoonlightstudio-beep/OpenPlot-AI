import { handleDb, uid } from './db';
import { isMcpToolName, mcpToolDefs, callMcpTool } from './mcp';
import { runWebFetch, runWebSearch } from './webtools';

export interface ToolCall { name: string; input: any; id?: string }

// ---------- Tool definitions (provider-agnostic) ----------

const TOOL_DEFS = [
  { name: 'save_memory', description: 'Save a durable memory/fact about the user or their story project for future chats. Use for stated preferences, world rules, decisions.', input_schema: { type: 'object', properties: { content: { type: 'string', description: 'The fact to remember' } }, required: ['content'] } },
  { name: 'list_memories', description: 'List all saved memories.', input_schema: { type: 'object', properties: {} } },
  { name: 'create_story_entry', description: 'Create a story bible entry. kind: world | location | character | item | lore.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['world', 'location', 'character', 'item', 'lore'] }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } }, required: ['kind', 'title', 'content'] } },
  { name: 'update_story_entry', description: 'Update an existing story entry. Find it by id, or by its exact current title; pass newTitle to rename it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current title to find the entry if id is unknown' }, newTitle: { type: 'string', description: 'New title when renaming' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'search_story', description: 'Search story bible entries by keyword across titles, content and attached reference files. Returns { entries, files } where entries carry their full content and attachment names; if a file body matches, use read_story_file to read it.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Keyword to search (case-insensitive substring)' }, kind: { type: 'string', enum: ['world', 'location', 'character', 'item', 'lore'], description: 'Optional filter by kind' } }, required: ['query'] } },
  { name: 'read_story_bible', description: 'Read the WHOLE story bible of a project in one call: every world, location, character, item and lore entry with full content and tags, plus the names of any attached reference files. Use before writing or continuing a story so everything you invent stays consistent with established canon. Prefer this over search_story when you need full context.', input_schema: { type: 'object', properties: { projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } } } },
  { name: 'read_story_file', description: 'Read the full text of a reference file attached to a story-bible entry (or to the project). Use after read_story_bible lists attachment names and you need the details inside one.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Attachment id when known' }, name: { type: 'string', description: 'Attachment file name (exact, case-insensitive)' } } } },
  { name: 'create_chapter', description: 'Create a new chapter for a project.', input_schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, projectId: { type: 'string' } }, required: ['title'] } },
  { name: 'update_chapter', description: 'Update chapter content or status (draft|revising|done). Find by id or exact current title; pass newTitle to rename it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current title to find the chapter' }, newTitle: { type: 'string', description: 'New title when renaming' }, content: { type: 'string' }, status: { type: 'string', enum: ['draft', 'revising', 'done'] } } } },
  { name: 'list_chapters', description: 'List chapters of a project with word counts.', input_schema: { type: 'object', properties: { projectId: { type: 'string' } } } },
  { name: 'read_chapter', description: 'Read the full content of one chapter by id or exact title.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
  { name: 'append_to_chapter', description: 'Append prose to the END of a chapter (or prepend to its beginning). Safer than update_chapter for adding text: you cannot accidentally overwrite existing prose. Use for continuing drafts, adding scenes, or inserting AI-written passages.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current chapter title (when id is unknown)' }, content: { type: 'string', description: 'The text to add' }, where: { type: 'string', enum: ['end', 'beginning'], description: 'Default: end' } }, required: ['content'] } },
  { name: 'search_text_dump', description: 'Search Text Dump, the recovery bin of text that AI edits or manual saves displaced from a chapter. Use this before rewriting a passage the user says they liked, or when they ask to bring back / undo AI-deleted prose. Returns matching rows with ids, chapter titles, action, source and the original text.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to find in the displaced text or chapter title (empty = newest entries)' }, projectId: { type: 'string', description: 'Optional project id; omit to search all projects' }, limit: { type: 'number', description: '1-20, default 8' } } } },
  { name: 'restore_text_dump', description: 'Put one Text Dump entry back into its chapter. Smart restore only succeeds when the chapter still matches what replaced the old text; otherwise it reports a conflict. Use force only after the user explicitly confirms overwriting newer prose. The old text can also be returned without changing the chapter by calling search_text_dump.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Text Dump row id from search_text_dump' }, force: { type: 'boolean', description: 'Overwrite the current chapter even if it changed since (needs explicit user consent)' } }, required: ['id'] } },
  { name: 'create_project', description: 'Create a new story project. Call this FIRST when the user asks for a new story and no project exists. It returns the new project id — pass that id as projectId to every later create_story_entry / create_chapter call so nothing lands in the wrong project.', input_schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, format: { type: 'string', enum: ['short-story', 'novel', 'book', 'fanfic', 'script'] }, rating: { type: 'string', enum: ['family', 'teen', 'mature'] } }, required: ['name'] } },
  { name: 'list_projects', description: 'List all story projects with their format, rating and word totals. Use when the user has several stories and you need to find the right one.', input_schema: { type: 'object', properties: {} } },
  { name: 'read_project', description: 'Read one project\'s metadata (name, description, context, format, rating) plus a compact overview of its chapters and story bible entry titles. Use to orient yourself before diving into a specific chapter or bible entry.', input_schema: { type: 'object', properties: { projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } } } },
  { name: 'web_search', description: 'Search the web for facts the story bible does not contain: real places, dates, terminology, recent events, sources for research. Returns a short list of { title, url, snippet }. Follow up with web_fetch on the most promising url. Needs a search key in Settings; if it reports none, use web_fetch with a URL you already know.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, in natural language' }, limit: { type: 'number', description: 'How many results (1-10, default from Settings)' } }, required: ['query'] } },
  { name: 'set_mode', description: 'Switch the working mode of this chat when the task moves on: plan (think and plan only), brainstorm (offer options), write (draft prose), edit (revise existing prose). The user sees the mode switch immediately, so use it instead of asking them to switch by hand.', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['plan', 'brainstorm', 'write', 'edit'] }, reason: { type: 'string', description: 'One short line shown to the user' } }, required: ['mode'] } },
  { name: 'list_skills', description: 'List the available skills — reusable instruction packs such as continuity, prose, dialogue, pacing, beta reading or worldbuilding — with what each one is for and whether it is active in this chat. Call this before a task so you know which skills fit.', input_schema: { type: 'object', properties: {} } },
  { name: 'use_skill', description: 'Switch a skill ON for this chat right before doing work it applies to. Accepts the skill id or name. Returns the instructions immediately so you can follow them in this same turn, and the skill stays active for later turns. Use it instead of asking the user to enable a skill by hand.', input_schema: { type: 'object', properties: { skill: { type: 'string', description: 'Skill id or name, e.g. "skill-continuity" or "Continuity Guardian"' }, reason: { type: 'string', description: 'One short line on why this skill fits the task' } }, required: ['skill'] } },
  { name: 'drop_skill', description: 'Switch a skill OFF for this chat when it no longer applies to the task. Accepts the skill id or name. Keeping the active set small stops overlapping skills from contradicting each other.', input_schema: { type: 'object', properties: { skill: { type: 'string', description: 'Skill id or name' } }, required: ['skill'] } },
  { name: 'web_fetch', description: 'Read one web page (http/https) as readable text: title, final url and the page text with markup removed. Use it to verify a fact, read the article behind a search result, or check a public page the user linked. Works without any API key. Text is capped at 20000 characters.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Full http(s) URL' } }, required: ['url'] } }
];

/**
 * What the provider is told it can call: the built-in tools plus every tool of
 * a connected MCP server (empty when none is configured, so nothing changes for
 * users who never enable one).
 */
export function toolDefsForApi(): any[] {
  return [...TOOL_DEFS, ...mcpToolDefs()];
}

/**
 * Dispatch a tool call, async because MCP tools go over a pipe to another
 * process. Local tools keep the synchronous path, so the headless tool suite
 * and every existing caller are unaffected.
 */
export async function executeToolCall(call: ToolCall, ctx: { projectId?: string | null; chatId?: string | null } = {}): Promise<string> {
  // Web tools hit the network, so they live on the async path next to MCP.
  if (call.name === 'web_search') return runWebSearch(call.input);
  if (call.name === 'web_fetch') return runWebFetch(call.input);
  if (isMcpToolName(call.name)) return callMcpTool(call.name, call.input);
  return executeTool(call, ctx);
}

function resolveProject(payload: any, defaultProjectId?: string | null): string | null {
  // Prefer the id the model passed, then the chat's project (ctx), then the
  // most recent project as a last resort. (Order used to be listProjects
  // first, which could bind entries to an unrelated project.)
  const pid = payload.projectId || defaultProjectId || null;
  if (pid) return pid;
  const projects = handleDb('listProjects', {}) as any[];
  return projects.length ? projects[0].id : null;
}

function findStory(byId?: string, byTitle?: string): any | undefined {
  const entries = handleDb('listStory', {}) as any[];
  if (byId) return entries.find((e: any) => e.id === byId);
  if (byTitle) {
    const t = byTitle.toLowerCase();
    return entries.find((e: any) => e.title.toLowerCase() === t);
  }
  return undefined;
}

function findChapter(payload: any, defaultProjectId?: string | null): any | undefined {
  // Scope the search to the chat's project when possible: the old version
  // looped over EVERY project, so two chapters with the same title in
  // different projects resolved to whichever was created first.
  const projects = handleDb('listProjects', {}) as any[];
  const ordered = [
    ...(defaultProjectId ? projects.filter((p) => p.id === defaultProjectId) : []),
    ...projects.filter((p) => p.id !== defaultProjectId)
  ];
  for (const p of ordered) {
    const chapters = handleDb('listChapters', { projectId: p.id }) as any[];
    if (payload.id) {
      const c = chapters.find((c: any) => c.id === payload.id);
      if (c) return c;
    }
    if (payload.title) {
      const t = payload.title.toLowerCase();
      const c = chapters.find((c: any) => c.title.toLowerCase() === t);
      if (c) return c;
    }
  }
  return undefined;
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// ---------- Skills ----------

/** A chat's skill allow/deny lists, tolerating JSON text or an already-parsed array. */
function chatSkillState(chatId?: string | null): { on: string[]; off: string[] } {
  const parse = (raw: unknown): string[] => {
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  };
  const chat = chatId ? (handleDb('listChats', {}) as any[]).find((c) => c.id === chatId) : null;
  return { on: parse(chat?.skills_on), off: parse(chat?.skills_off) };
}

/** Find a skill by id or name, then by the closest name/description match. */
function findSkill(query: string): any | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const skills = handleDb('listSkills', {}) as any[];
  const name = (s: any) => String(s.name || '').toLowerCase();
  return skills.find((s) => String(s.id).toLowerCase() === q)
    || skills.find((s) => name(s) === q)
    || skills.find((s) => name(s).includes(q) || q.includes(name(s)))
    || skills.find((s) => String(s.description || '').toLowerCase().includes(q));
}

// ---------- Tool executor ----------

export function executeTool(call: ToolCall, ctx: { projectId?: string | null; chatId?: string | null } = {}): string {
  const name = call.name;
  const input = call.input || {};
  try {
    switch (name) {
      case 'create_project': {
        const projectName = String(input.name || '').trim();
        if (!projectName) return JSON.stringify({ error: 'create_project needs a name.' });
        const row = handleDb('createProject', {
          name: projectName,
          description: String(input.description || ''),
          format: input.format || 'novel',
          rating: input.rating || 'teen'
        }) as any;
        // The run keeps its own project id on purpose: ctx.projectId is fixed
        // for the whole generation, so later calls must pass this id explicitly.
        return JSON.stringify({ ok: true, id: row?.id, name: row?.name, next: 'Pass this id as projectId on every later call.' });
      }
      case 'set_mode': {
        const mode = String(input.mode || '');
        if (!['plan', 'brainstorm', 'write', 'edit'].includes(mode)) {
          return JSON.stringify({ error: 'set_mode needs one of: plan, brainstorm, write, edit.' });
        }
        if (!ctx.chatId) {
          return JSON.stringify({ error: 'This run is not attached to a chat, so its mode cannot be switched.' });
        }
        handleDb('updateChat', { id: ctx.chatId, chat_mode: mode });
        return JSON.stringify({ ok: true, mode, note: 'The chat now runs in this mode — continue working in it.' });
      }
      case 'list_skills': {
        const { on, off } = chatSkillState(ctx.chatId);
        const skills = handleDb('listSkills', {}) as any[];
        return JSON.stringify(skills.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          global: Number(s.enabled) === 1,
          active: (Number(s.enabled) === 1 || on.includes(s.id)) && !off.includes(s.id)
        })));
      }
      case 'use_skill': {
        if (!ctx.chatId) {
          return JSON.stringify({ error: 'This run is not attached to a chat, so a skill cannot be switched on.' });
        }
        const skill = findSkill(String(input.skill || ''));
        if (!skill) {
          return JSON.stringify({ error: `No skill matched "${input.skill || ''}". Call list_skills to see the available names.` });
        }
        const { on, off } = chatSkillState(ctx.chatId);
        handleDb('updateChat', {
          id: ctx.chatId,
          skills_on: on.includes(skill.id) ? on : [...on, skill.id],
          // Switching it on clears an earlier mute, or the two lists fight.
          skills_off: off.filter((id) => id !== skill.id)
        });
        return JSON.stringify({
          ok: true,
          id: skill.id,
          name: skill.name,
          description: skill.description || '',
          instructions: String(skill.content || '').slice(0, 8000),
          note: 'Follow these instructions now and in later turns.'
        });
      }
      case 'drop_skill': {
        if (!ctx.chatId) {
          return JSON.stringify({ error: 'This run is not attached to a chat, so a skill cannot be switched off.' });
        }
        const skill = findSkill(String(input.skill || ''));
        if (!skill) {
          return JSON.stringify({ error: `No skill matched "${input.skill || ''}". Call list_skills to see the available names.` });
        }
        const { on, off } = chatSkillState(ctx.chatId);
        handleDb('updateChat', {
          id: ctx.chatId,
          skills_on: on.filter((id) => id !== skill.id),
          // Muting also stops a globally enabled skill for this chat only.
          skills_off: off.includes(skill.id) ? off : [...off, skill.id]
        });
        return JSON.stringify({ ok: true, id: skill.id, name: skill.name, note: 'This skill no longer rides in the prompt for this chat.' });
      }
      case 'save_memory': {
        handleDb('addMemory', { content: String(input.content || ''), source: 'agent' });
        return 'Memory saved.';
      }
      case 'list_memories': {
        const mems = handleDb('listMemories', {}) as any[];
        return JSON.stringify(mems.map((m: any) => ({ id: m.id, content: m.content })));
      }
      case 'create_story_entry': {
        const projectId = resolveProject(input, ctx.projectId);
        if (!projectId) return JSON.stringify({ error: 'No project exists yet. Call create_project first, then pass its id as projectId.' });
        const row = handleDb('createStory', { projectId, kind: input.kind, title: input.title, content: input.content || '', tags: input.tags || [], links: input.links || [] });
        return JSON.stringify({ ok: true, id: row.id, kind: row.kind, title: row.title });
      }
      case 'update_story_entry': {
        const entry = findStory(input.id, input.title);
        if (!entry) return JSON.stringify({ error: 'Story entry not found.' });
        // If the model ALSO passed a new title, treat `title` as the rename;
        // otherwise fall back to newTitle. (The old version always wrote the
        // current title back, so renaming an entry was impossible.)
        const newTitle = (input.newTitle ?? input.title ?? entry.title).toString();
        handleDb('updateStory', { id: entry.id, title: newTitle, content: input.content ?? entry.content, tags: input.tags ?? JSON.parse(entry.tags || '[]'), links: input.links ?? JSON.parse((entry as any).links || '[]') });
        return JSON.stringify({ ok: true, id: entry.id, title: newTitle });
      }
      case 'search_story': {
        const q = String(input.query || '').toLowerCase();
        let entries = handleDb('listStory', {}) as any[];
        if (input.kind) entries = entries.filter((e: any) => e.kind === input.kind);
        // Attached reference files are searchable too — the whole point of
        // attaching them is that the agent can find canon without copy-paste.
        const files = ((handleDb('listStoryFiles', {}) as any[]) || []);
        const fileIdsByEntry = new Map<string, any[]>();
        for (const f of files) {
          if (!f.story_id) continue;
          const arr = fileIdsByEntry.get(f.story_id) || [];
          arr.push(f);
          fileIdsByEntry.set(f.story_id, arr);
        }
        // Attachment bodies live in the DB, so search them there instead of
        // loading every file into this process just to filter it.
        const fileHits = (handleDb('searchStoryFiles', { q: input.query }) as any[]) || [];
        const hitFileEntryIds = new Set(fileHits.map((f) => f.story_id).filter(Boolean));
        const hits = entries.filter((e: any) =>
          e.title.toLowerCase().includes(q) ||
          String(e.content).toLowerCase().includes(q) ||
          (fileIdsByEntry.get(e.id) || []).some((f: any) => String(f.name).toLowerCase().includes(q)) ||
          hitFileEntryIds.has(e.id)
        );
        return JSON.stringify({
          entries: hits.map((e: any) => ({
            id: e.id, kind: e.kind, title: e.title, content: e.content,
            tags: (() => { try { return JSON.parse(e.tags || '[]'); } catch { return []; } })(),
            attachments: (fileIdsByEntry.get(e.id) || []).map((f: any) => f.name)
          })),
          files: fileHits.map((f: any) => ({ name: f.name, storyId: f.story_id, matchedIn: f.matched_in }))
        });
      }
      case 'read_story_bible': {
        const projectId = resolveProject(input, ctx.projectId);
        if (!projectId) return JSON.stringify({ error: 'No project exists yet. Call create_project first, then pass its id as projectId.' });
        const entries = (handleDb('listStory', {}) as any[]).filter((e) => e.project_id === projectId);
        const files = (handleDb('listStoryFiles', { projectId }) as any[]);
        return JSON.stringify({
          projectId,
          entryCount: entries.length,
          entries: entries.map((e) => ({
            id: e.id, kind: e.kind, title: e.title, content: e.content,
            tags: (() => { try { return JSON.parse(e.tags || '[]'); } catch { return []; } })(),
            // Names only here; the full text is loaded on demand by
            // read_story_file so one huge attachment cannot flood the context.
            attachments: files.filter((f) => f.story_id === e.id).map((f) => f.name)
          })),
          projectFiles: files.filter((f) => !f.story_id).map((f) => f.name)
        });
      }
      case 'read_story_file': {
        const name = String(input.name || '').trim().toLowerCase();
        const id = String(input.id || '').trim();
        if (!name && !id) return JSON.stringify({ error: 'Pass the attachment id or file name.' });
        // Scope to the chat's project first so two projects with a
        // "notes.md" never resolve to the wrong story's canon.
        const files = (handleDb('listStoryFiles', ctx.projectId ? { projectId: ctx.projectId } : {}) as any[])
          .concat(ctx.projectId ? (handleDb('listStoryFiles', {}) as any[]).filter((f) => f.project_id !== ctx.projectId) : []);
        const found = id
          ? files.find((f) => f.id === id)
          : files.find((f) => String(f.name).toLowerCase() === name);
        if (!found) return JSON.stringify({ error: 'Attachment not found.' });
        const row = handleDb('getStoryFile', { id: found.id }) as any;
        // A single 2 MB attachment would otherwise dominate the whole context
        // window. The model gets the head of the file plus a clear notice.
        const MAX_TOOL_FILE_CHARS = 60_000;
        const content = String(row.content || '');
        const truncated = content.length > MAX_TOOL_FILE_CHARS;
        return JSON.stringify({
          id: row.id,
          name: row.name,
          storyId: row.story_id,
          content: truncated ? content.slice(0, MAX_TOOL_FILE_CHARS) : content,
          truncated,
          ...(truncated ? { note: `Only the first ${MAX_TOOL_FILE_CHARS.toLocaleString('en-US')} characters are shown.` } : {})
        });
      }
      case 'create_chapter': {
        const projectId = resolveProject(input, ctx.projectId);
        if (!projectId) return JSON.stringify({ error: 'No project exists yet. Call create_project first, then pass its id as projectId.' });
        const row = handleDb('createChapter', { projectId, title: input.title, content: input.content || '', status: 'draft' });
        return JSON.stringify({ ok: true, id: row.id, title: row.title });
      }
      case 'update_chapter': {
        const ch = findChapter(input, ctx.projectId);
        if (!ch) return JSON.stringify({ error: 'Chapter not found.' });
        // Same rename fix as update_story_entry: a fresh `newTitle` renames,
        // a bare `title` that matches the current one is just the lookup key.
        const newTitle = (input.newTitle ?? (input.title && input.title !== ch.title ? input.title : ch.title)).toString();
        const before = String(ch.content || '');
        handleDb('updateChapter', { id: ch.id, title: newTitle, content: input.content ?? undefined, status: input.status ?? undefined });
        // Keep the displaced prose in Text Dump. A whole-chapter rewrite stores
        // the whole previous chapter, so "undo the AI" is always possible even
        // when the model did not use append_to_chapter.
        if (typeof input.content === 'string' && input.content !== before) {
          handleDb('addTextDump', {
            projectId: ch.project_id,
            chapterId: ch.id,
            chapterTitle: newTitle,
            source: 'agent',
            action: input.content.trim() ? 'replace' : 'delete',
            scope: 'chapter',
            original: before,
            replacement: input.content
          });
        }
        return JSON.stringify({ ok: true, id: ch.id, title: newTitle });
      }
      case 'list_chapters': {
        const projectId = resolveProject(input, ctx.projectId);
        if (!projectId) return JSON.stringify([]);
        const chapters = handleDb('listChapters', { projectId }) as any[];
        return JSON.stringify(chapters.map((c: any) => ({ id: c.id, title: c.title, status: c.status, words: wordCount(c.content || '') })));
      }
      case 'read_chapter': {
        const ch = findChapter(input, ctx.projectId);
        if (!ch) return JSON.stringify({ error: 'Chapter not found.' });
        return JSON.stringify({ id: ch.id, title: ch.title, status: ch.status, content: ch.content });
      }
      case 'search_text_dump': {
        const limit = Math.max(1, Math.min(20, Number(input.limit) || 8));
        const projectId = input.projectId || ctx.projectId || null;
        const rows = handleDb('listTextDump', projectId ? { projectId } : {}) as any[];
        const q = String(input.query || '').trim().toLowerCase();
        const hits = (q
          ? rows.filter((r) => String(r.original).toLowerCase().includes(q)
            || String(r.replacement).toLowerCase().includes(q)
            || String(r.chapter_title).toLowerCase().includes(q))
          : rows
        ).slice(0, limit);
        return JSON.stringify({
          count: hits.length,
          rows: hits.map((r) => ({
            id: r.id,
            chapterId: r.chapter_id,
            chapterTitle: r.chapter_title,
            action: r.action,
            source: r.source,
            createdAt: r.created_at,
            restored: !!r.restored_at,
            original: String(r.original || '').slice(0, 5000),
            truncated: String(r.original || '').length > 5000
          }))
        });
      }
      case 'restore_text_dump': {
        const id = String(input.id || '').trim();
        if (!id) return JSON.stringify({ error: 'restore_text_dump needs a Text Dump id.' });
        const result = handleDb('restoreTextDump', { id, force: input.force === true }) as any;
        if (!result?.ok) {
          if (result?.error === 'conflict') {
            return JSON.stringify({
              ok: false,
              error: 'conflict',
              message: 'The chapter changed after this text was displaced. Ask the user before forcing; search_text_dump can also return the old text without changing anything.',
              chapterTitle: result.row?.chapter_title || ''
            });
          }
          return JSON.stringify({ ok: false, error: result?.error || 'restore-failed' });
        }
        return JSON.stringify({
          ok: true,
          chapterId: result.chapterId,
          title: result.title,
          note: 'The displaced text is back in the chapter. The previous state was saved to chapter history.'
        });
      }
      case 'append_to_chapter': {
        const ch = findChapter(input, ctx.projectId);
        if (!ch) return JSON.stringify({ error: 'Chapter not found.' });
        const addition = String(input.content || '');
        if (!addition.trim()) return JSON.stringify({ error: 'Nothing to append — content was empty.' });
        const base = String(ch.content || '');
        const merged = input.where === 'beginning'
          ? `${addition.trimEnd()}\n\n${base}`
          : `${base.trimEnd()}${base.trim() ? '\n\n' : ''}${addition.trimStart()}`;
        handleDb('updateChapter', { id: ch.id, content: merged });
        return JSON.stringify({ ok: true, id: ch.id, title: ch.title, words: wordCount(merged) });
      }
      case 'list_projects': {
        const projects = handleDb('listProjects', {}) as any[];
        const allChapters = handleDb('listAllChapters', {}) as any[];
        return JSON.stringify(projects.map((p) => ({
          id: p.id, name: p.name, format: p.format, rating: p.rating,
          description: p.description,
          chapters: allChapters.filter((c) => c.project_id === p.id).length,
          words: allChapters.filter((c) => c.project_id === p.id).reduce((a, c) => a + wordCount(c.content || ''), 0)
        })));
      }
      case 'read_project': {
        const projectId = resolveProject(input, ctx.projectId);
        if (!projectId) return JSON.stringify({ error: 'No project exists yet. Call create_project first, then pass its id as projectId.' });
        const p = (handleDb('listProjects', {}) as any[]).find((x) => x.id === projectId);
        if (!p) return JSON.stringify({ error: 'Project not found.' });
        const chapters = (handleDb('listChapters', { projectId }) as any[]).map((c) => ({ id: c.id, title: c.title, status: c.status, words: wordCount(c.content || '') }));
        const bible = (handleDb('listStory', {}) as any[])
          .filter((e) => e.project_id === projectId)
          .map((e) => ({ id: e.id, kind: e.kind, title: e.title }));
        const files = (handleDb('listStoryFiles', { projectId }) as any[])
          .map((f) => ({ name: f.name, storyId: f.story_id }));
        return JSON.stringify({
          id: p.id, name: p.name, description: p.description, context: p.context,
          format: p.format, rating: p.rating,
          chapters, bible, files
        });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e: any) {
    return JSON.stringify({ error: e?.message || String(e) });
  }
}

export function newToolCallId(): string {
  return uid();
}
