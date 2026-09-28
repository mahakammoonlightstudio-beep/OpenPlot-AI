import { handleDb, uid } from './db';

export interface ToolCall { name: string; input: any; id?: string }

// ---------- Tool definitions (provider-agnostic) ----------

const TOOL_DEFS = [
  { name: 'save_memory', description: 'Save a durable memory/fact about the user or their story project for future chats. Use for stated preferences, world rules, decisions.', input_schema: { type: 'object', properties: { content: { type: 'string', description: 'The fact to remember' } }, required: ['content'] } },
  { name: 'list_memories', description: 'List all saved memories.', input_schema: { type: 'object', properties: {} } },
  { name: 'create_story_entry', description: 'Create a story bible entry. kind: world | location | character | item | lore.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['world', 'location', 'character', 'item', 'lore'] }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, projectId: { type: 'string', description: 'Optional project id; omit to use the active project' } }, required: ['kind', 'title', 'content'] } },
  { name: 'update_story_entry', description: 'Update an existing story entry. Find it by id, or by its exact current title; pass newTitle to rename it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current title to find the entry if id is unknown' }, newTitle: { type: 'string', description: 'New title when renaming' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'search_story', description: 'Search story bible entries (world, locations, characters, items, lore) by keyword across titles and content. Returns matching entries with their full content.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Keyword to search (case-insensitive substring)' }, kind: { type: 'string', enum: ['world', 'location', 'character', 'item', 'lore'], description: 'Optional filter by kind' } }, required: ['query'] } },
  { name: 'create_chapter', description: 'Create a new chapter for a project.', input_schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, projectId: { type: 'string' } }, required: ['title'] } },
  { name: 'update_chapter', description: 'Update chapter content or status (draft|revising|done). Find by id or exact current title; pass newTitle to rename it.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Exact current title to find the chapter' }, newTitle: { type: 'string', description: 'New title when renaming' }, content: { type: 'string' }, status: { type: 'string', enum: ['draft', 'revising', 'done'] } } } },
  { name: 'list_chapters', description: 'List chapters of a project with word counts.', input_schema: { type: 'object', properties: { projectId: { type: 'string' } } } },
  { name: 'read_chapter', description: 'Read the full content of one chapter by id or exact title.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } }
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
        const hits = entries.filter((e: any) => e.title.toLowerCase().includes(q) || String(e.content).toLowerCase().includes(q));
        return JSON.stringify(hits.map((e: any) => ({ id: e.id, kind: e.kind, title: e.title, content: e.content, tags: JSON.parse(e.tags || '[]') })));
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
