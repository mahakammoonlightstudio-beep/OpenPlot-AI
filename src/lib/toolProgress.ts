/**
 * Agent tool progress (pure).
 *
 * The chat used to show only the raw tool name once a call returned, so a long
 * agent run (project → bible entries → chapters) looked frozen. This turns a
 * tool name + its result string into one readable step the UI can list live:
 * what it created, and whether it worked.
 */
export type ToolStepKind = 'project' | 'entry' | 'chapter' | 'read' | 'search' | 'memory' | 'skill' | 'web' | 'mode' | 'other';

export interface ToolStep {
  name: string;
  kind: ToolStepKind;
  /** Human subject: the project name or the entry/chapter title (may be ''). */
  detail: string;
  ok: boolean;
}

const KIND: Record<string, ToolStepKind> = {
  create_project: 'project',
  create_story_entry: 'entry',
  update_story_entry: 'entry',
  create_chapter: 'chapter',
  update_chapter: 'chapter',
  append_to_chapter: 'chapter',
  read_project: 'read',
  read_story_bible: 'read',
  read_chapter: 'read',
  read_story_file: 'read',
  list_projects: 'read',
  list_chapters: 'read',
  list_memories: 'memory',
  save_memory: 'memory',
  search_story: 'search',
  search_text_dump: 'search',
  restore_text_dump: 'chapter',
  web_search: 'web',
  web_fetch: 'web',
  list_skills: 'skill',
  use_skill: 'skill',
  drop_skill: 'skill',
  // The agent switching its own working mode (v1.3.0).
  set_mode: 'mode'
};

function parse(result: string): any {
  try { return JSON.parse(result); } catch { return null; }
}

export function describeToolStep(name: string, result: string): ToolStep {
  const json = parse(result);
  const ok = !(json && (json.error || json.ok === false));
  const kind = KIND[name] || 'other';
  let detail = '';
  if (json) {
    detail = String(json.title || json.name || '');
    if (!detail && Array.isArray(json)) detail = String(json.length);
    if (!detail && Array.isArray(json.entries)) detail = String(json.entries.length);
    if (!detail && json.project?.name) detail = String(json.project.name);
    if (kind === 'mode' && json.mode) detail = String(json.mode);
    if (kind === 'web') {
      // A search step is best described by what it looked for, a fetch by
      // the page it read.
      if (Array.isArray(json.results)) detail = String(json.results.length) + (json.results.length === 1 ? ' result' : ' results');
      else if (json.query) detail = String(json.query);
      else if (json.title || json.url) detail = String(json.title || json.url);
    }
  }
  // A failure's own message is the most useful thing to show.
  if (!ok && json?.error) detail = String(json.error).slice(0, 120);
  return { name, kind, detail, ok };
}
