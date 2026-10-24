import { handleDb, uid } from './db';

export interface ToolCall { name: string; input: any; id?: string }

// ---------- Tool definitions (provider-agnostic) ----------

const TOOL_DEFS = [
  { name: 'save_memory', description: 'Save a durable memory/fact about the user or their story project for future chats. Use for stated preferences, world rules, decisions.', input_schema: { type: 'object', properties: { content: { type: 'string', description: 'The fact to remember' } }, required: ['content'] } },
  { name: 'list_memories', description: 'List all saved memories.', input_schema: { type: 'object', properties: {} } },
  { name: 'create_story_entry', description: 'Create a story bible entry. kind: world | location | character | item | lore.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['world', 'location', 'character', 'item', 'lore'] }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } }, required: ['kind', 'title', 'content'] } },
  { name: 'update_story_entry', description: 'Update an existing story entry. Find it by id, or by its exact current title; pass newTitle to rename it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current title to find the entry if id is unknown' }, newTitle: { type: 'string', description: 'New title when renaming' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'search_story', description: 'Search story bible entries (world, locations, characters, items, lore) by keyword across titles and content. Returns matching entries with their full content.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Keyword to search (case-insensitive substring)' }, kind: { type: 'string', enum: ['world', 'location', 'character', 'item', 'lore'], description: 'Optional filter by kind' } }, required: ['query'] } },
  { name: 'read_story_bible', description: 'Read the WHOLE story bible of a project in one call: every world, location, character, item and lore entry with full content and tags, plus the names of any attached reference files. Use before writing or continuing a story so everything you invent stays consistent with established canon. Prefer this over search_story when you need full context.', input_schema: { type: 'object', properties: { projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } } } },
  { name: 'read_story_file', description: 'Read the full text of a reference file attached to a story-bible entry (or to the project). Use after read_story_bible lists attachment names and you need the details inside one.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Attachment id when known' }, name: { type: 'string', description: 'Attachment file name (exact, case-insensitive)' } } } },
  { name: 'create_chapter', description: 'Create a new chapter for a project.', input_schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, projectId: { type: 'string' } }, required: ['title'] } },
  { name: 'update_chapter', description: 'Update chapter content or status (draft|revising|done). Find by id or exact current title; pass newTitle to rename it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current title to find the chapter' }, newTitle: { type: 'string', description: 'New title when renaming' }, content: { type: 'string' }, status: { type: 'string', enum: ['draft', 'revising', 'done'] } } } },
  { name: 'list_chapters', description: 'List chapters of a project with word counts.', input_schema: { type: 'object', properties: { projectId: { type: 'string' } } } },
  { name: 'read_chapter', description: 'Read the full content of one chapter by id or exact title.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
  { name: 'append_to_chapter', description: 'Append prose to the END of a chapter (or prepend to its beginning). Safer than update_chapter for adding text: you cannot accidentally overwrite existing prose. Use for continuing drafts, adding scenes, or inserting AI-written passages.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current chapter title (when id is unknown)' }, content: { type: 'string', description: 'The text to add' }, where: { type: 'string', enum: ['end', 'beginning'], description: 'Default: end' } }, required: ['content'] } },
  { name: 'list_projects', description: 'List all story projects with their format, rating and word totals. Use when the user has several stories and you need to find the right one.', input_schema: { type: 'object', properties: {} } },
  { name: 'read_project', description: 'Read one project\'s metadata (name, description, context, format, rating) plus a compact overview of its chapters and story bible entry titles. Use to orient yourself before diving into a specific chapter or bible entry.', input_schema: { type: 'object', properties: { projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } } } }
];

export function toolDefsForApi(): any[] {
  return TOOL_DEFS;
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

// ---------- Tool executor ----------

export function executeTool(call: ToolCall, ctx: { projectId?: string | null } = {}): string {
  const name = call.name;
  const input = call.input || {};
  try {
    switch (name) {
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
        if (!projectId) return JSON.stringify({ error: 'No project exists. Ask the user to create a project first.' });
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
        if (!projectId) return JSON.stringify({ error: 'No project exists. Ask the user to create a project first.' });
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
        if (!projectId) return JSON.stringify({ error: 'No project exists. Ask the user to create a project first.' });
        const row = handleDb('createChapter', { projectId, title: input.title, content: input.content || '', status: 'draft' });
        return JSON.stringify({ ok: true, id: row.id, title: row.title });
      }
      case 'update_chapter': {
        const ch = findChapter(input, ctx.projectId);
        if (!ch) return JSON.stringify({ error: 'Chapter not found.' });
        // Same rename fix as update_story_entry: a fresh `newTitle` renames,
        // a bare `title` that matches the current one is just the lookup key.
        const newTitle = (input.newTitle ?? (input.title && input.title !== ch.title ? input.title : ch.title)).toString();
        handleDb('updateChapter', { id: ch.id, title: newTitle, content: input.content ?? undefined, status: input.status ?? undefined });
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
        if (!projectId) return JSON.stringify({ error: 'No project exists. Ask the user to create a project first.' });
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
