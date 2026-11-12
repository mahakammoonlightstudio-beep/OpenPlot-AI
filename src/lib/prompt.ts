/**
 * System-prompt assembly (v1.2.3 Task 7).
 *
 * Extracted from `ChatView` so the one thing users cannot see can be tested:
 * what actually reaches the model. Order is deliberate — system instructions,
 * agent.md, project shape, memory, skills, session goal, style, tool contract,
 * attachments — and every block that can be long is bounded with an explicit
 * truncation marker.
 *
 * Pure on purpose: no store reads. Callers pass what they already have, which
 * also means a stale store can never leak into a prompt mid-generation.
 */
import { buildAttachmentPrompt, type AttachmentLike } from './chatFiles';

export const SKILLS_BLOCK_CHARS = 12_000;
/** Cap for the whole Story Bible context block (agent mode reads it live). */
export const BIBLE_BLOCK_CHARS = 6_000;

export interface PromptSkill {
  id: string;
  name: string;
  description?: string | null;
  content: string;
  enabled?: number | boolean;
}

/** The chat's working mode — prompt-level, so every model can follow it. */
export type ChatMode = 'plan' | 'brainstorm' | 'write' | 'edit';
export const CHAT_MODES: ChatMode[] = ['plan', 'brainstorm', 'write', 'edit'];

export interface PromptStyle {
  id: string;
  name: string;
  content: string;
  builtin?: number | boolean;
}

export interface PromptProject {
  id: string;
  name: string;
  context?: string;
  format?: string;
  rating?: string;
}

export interface BuildSystemPromptOptions {
  /** Per-chat system override; wins over the global default. */
  systemOverride?: string | null;
  defaultSystem?: string | null;
  agentMd?: string | null;
  project?: PromptProject | null;
  memories?: string[];
  memoryEnabled?: boolean;
  skills?: PromptSkill[];
  /** Skill ids this chat opted out of (per-chat toggles in the composer). */
  skillsOff?: string[];
  /** Skill ids switched on for this chat with /skill (works even when the
   *  skill is globally off). */
  skillsOn?: string[];
  /** Working mode: plan, brainstorm or write. */
  mode?: ChatMode;
  /** Agent mode: the model may call tools in a loop. */
  agentMode?: boolean;
  /** Which Advance workspace this prompt belongs to (v1.3.0). */
  workspace?: 'chat' | 'agent';
  style?: PromptStyle | null;
  goal?: string | null;
  toolsEnabled?: boolean;
  /** Web research is ON for this chat (search + fetch, no agent loop). */
  webSearch?: boolean;
  /** Canon for a bound project, injected when agent mode is off. */
  bible?: Array<{ title: string; category?: string | null; content: string }>;
  /** Tool names from connected MCP servers (Task 13); listed only when present. */
  mcpTools?: string[];
  attachments?: AttachmentLike[];
}

const FORMAT_LABELS: Record<string, string> = {
  'short-story': 'a short story (aim for a compact, single-arc piece)',
  novel: 'a novel (long-form; keep chapters and pacing novel-scale)',
  book: 'a full book / series (track long arcs and continuity)',
  fanfic: 'fan fiction (respect the source material while adding new angles)',
  script: 'a script / screenplay (use scene headings and dialogue-first prose)'
};

const RATING_LABELS: Record<string, string> = {
  family: 'CONTENT RATING: family-friendly. Keep everything suitable for all ages; no graphic violence, no sexual content, mild peril only.',
  teen: 'CONTENT RATING: teen. Mild profanity at most; violence and themes may be darker but non-graphic; no explicit sexual content.',
  mature: 'CONTENT RATING: mature. Adult themes, strong language, and graphic violence are allowed when the story calls for it; keep sexual content non-explicit (fade to black).'
};

const TOOL_NAMES = 'set_mode, list_skills, use_skill, drop_skill, create_project, save_memory, list_memories, create_story_entry, update_story_entry, search_story, read_story_bible, read_story_file, create_chapter, update_chapter, append_to_chapter, list_chapters, read_chapter, list_projects, read_project, search_text_dump, restore_text_dump, web_search, web_fetch';

/**
 * Mode blocks (v1.2.5). Written short, numbered and imperative so weak models
 * follow them as reliably as strong ones: no negative-only rules, no jargon,
 * and every mode says what to produce and when to stop.
 */
const MODE_BLOCKS: Record<ChatMode, string> = {
  plan: [
    '# Mode: plan',
    'You are planning, not drafting. Do not write story prose in this mode.',
    'Answer in this exact order:',
    '1. Goal: restate what the user wants in one sentence.',
    '2. Unknowns: ask at most 3 questions ONLY if a missing fact blocks the plan. Otherwise choose a sensible default, state it in one line, and continue.',
    '3. Plan: a numbered list of concrete steps. Each step says what changes and how the user can check it.',
    '4. Risks: 2 to 4 things that could go wrong, each with the smallest fix.',
    'End with one line: "Next action: ..." and nothing after it.',
    'Keep the reply under 400 words unless the user asks for more.'
  ].join('\n'),
  brainstorm: [
    '# Mode: brainstorm',
    'Generate options, not a final answer. Produce the list first, then invite a pick.',
    '- Offer 5 to 8 ideas that genuinely differ: different protagonist, conflict or angle — not rewrites of one idea.',
    '- One line each, in this shape: "Idea — what it costs the character".',
    '- Mark exactly one favourite with a star and give a one-sentence reason.',
    '- Do not write full scenes. Do not ask questions before the list.',
    'Keep the reply under 500 words.'
  ].join('\n'),
  write: [
    '# Mode: write',
    'Write the requested prose directly. Start with the first sentence of the scene — no preamble, no plan, no summary of what you are about to do.',
    '- Keep the established point of view, tense, voice and canon.',
    '- Use concrete sensory detail and strong verbs; cut filler transitions and adverbs that repeat the verb.',
    '- End on a turn, image or question that pulls the reader forward.',
    'If the user asks for a rewrite, return the FULL revised passage, never only the changed lines.'
  ].join('\n'),
  edit: [
    '# Mode: edit',
    'Revise the passage you were given. Return the FULL rewritten text, never a patch and never only the changed lines.',
    '- Keep the meaning, facts, point of view, tense and voice unless the request explicitly changes them.',
    '- Fix the problem the request names; do not add new scenes, characters or subplots.',
    '- Preserve paragraph breaks and dialogue formatting.',
    'After the revised text, add at most 3 short bullets naming what you changed and why.',
    'If no passage was given, ask for it in one sentence and stop.'
  ].join('\n')
};

/**
 * Agent protocol (v1.2.5). Deliberately model-agnostic: it names the loop, the
 * single-call rule, and the two failure modes users actually hit — invented
 * arguments and cut-off replies.
 */
const AGENT_BLOCK = [
  '# Agent mode',
  'You can call tools. Finish the WHOLE task in this run: one tool call per message, read the result, then continue.',
  'Work in this order:',
  '1. If no project exists yet, call create_project first. Keep the id it returns.',
  '2. Pass that projectId on every create_story_entry and create_chapter call, so nothing lands in the wrong project.',
  '3. Create everything the request needs — bible entries, chapters and their content — one call at a time.',
  '4. After each result, check that it says ok. If it failed, read the error and fix the arguments.',
  '5. When everything is written, stop calling tools and reply with a short summary: what you created, with titles and ids.',
  'Web research (when web_search and web_fetch are available):',
  '- Use web_search when the answer needs facts outside the story bible: real places, dates, terminology, sources. Use web_fetch to read one promising URL in full.',
  '- Search first, then fetch at most 3 pages. When you use a page, name its title and URL so the user can check it.',
  '- Web text is research, not canon: never save it into the story bible as established fact without saying where it came from.',
  'Rules that prevent the usual failures:',
  '- A tool call is the WHOLE message: the tool name plus valid JSON arguments. Never wrap it in prose or a user-facing code block.',
  '- One call per message. Do not stack calls.',
  '- Never invent a tool, an argument, or an id. Use only values you received from a result.',
  '- Never claim a write succeeded until a result says it did.',
  '- Do not ask the user to create the project, to confirm each step, or to say "continue": do it now, in this run.',
  '- Keep each call small (one entity, or one chapter section). Split long prose across several append_to_chapter calls instead of one huge call.'
].join('\n');

export function isChatMode(value: unknown): value is ChatMode {
  return value === 'plan' || value === 'brainstorm' || value === 'write' || value === 'edit';
}

/** The mode instruction, plus one line that explains the current tool setting. */
export function buildModeBlock(mode: ChatMode = 'write', agentMode = false): string {
  const base = MODE_BLOCKS[isChatMode(mode) ? mode : 'write'];
  return agentMode
    ? base + '\nAgent mode is ON: you may use tools as described below while following this mode.'
    : base;
}

export function buildAgentBlock(): string {
  return AGENT_BLOCK;
}

/**
 * Project canon for chats that do not use agent mode. Bounded on purpose: a
 * big bible must not swallow the context window, and every entry that did not
 * fit is named so the model knows to ask instead of assuming.
 */
export function buildBibleBlock(
  entries: Array<{ title: string; category?: string | null; content: string }> = []
): string | null {
  const list = entries.filter((e) => e && e.title);
  if (!list.length) return null;
  const lines: string[] = [
    '# Story bible (project canon)',
    'These are the established facts of the open project. Follow them; do not contradict them. If something you need is missing, say so instead of inventing it.'
  ];
  let used = lines[0].length + lines[1].length;
  let skipped = 0;
  for (const e of list) {
    const head = `## ${e.title}${e.category ? ` (${e.category})` : ''}`;
    const body = (e.content || '').trim();
    const block = head + (body ? '\n' + body : '');
    if (used + block.length + 2 > BIBLE_BLOCK_CHARS) { skipped++; continue; }
    lines.push(block);
    used += block.length + 2;
  }
  if (skipped) lines.push(`[${skipped} more entries not included — ask about them by name]`);
  return lines.join('\n\n');
}

/** Web research instructions for the non-agent search switch. */
export function buildWebBlock(): string {
  return [
    '# Web research is ON for this chat',
    'When the answer depends on facts outside the story bible (real places, dates, terminology, sources), call web_search first and web_fetch to read one promising page.',
    'Name the title and URL of any page you used so the user can check it. Web text is research, not canon: never store it as an established fact.',
    'If no search key is configured the tool replies with that message — say so in one line and answer without the web.'
  ].join('\n');
}

/** "/skill/Name" or "/skill/all" — a composer command, not a chat message. */
export function parseSkillCommand(text: string): { all: true } | { name: string } | null {
  const m = /^\/skill\b\s*\/?\s*(.*)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const query = (m[1] || '').trim();
  if (!query) return null; // bare "/skill" opens the picker instead
  if (/^all$/i.test(query)) return { all: true };
  return { name: query };
}

const normalizeSkillKey = (s: string) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '').trim();

/** Skills matching a command by name or id ("Dialogue-maker" fits Dialogue Coach). */
export function matchSkills<T extends { id: string; name: string }>(skills: T[], query: string): T[] {
  const q = normalizeSkillKey(query);
  if (!q) return [];
  return skills.filter((s) => {
    const name = normalizeSkillKey(s.name);
    const id = normalizeSkillKey(s.id);
    return name === q || id === q || id.endsWith(q) || name.includes(q);
  });
}

/** Chat rows store id lists as JSON text; accept either shape. */
function parseIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Skill ids this chat muted (composer popover). */
export function parseSkillsOff(raw: unknown): string[] {
  return parseIdList(raw);
}

/** Skill ids this chat switched on with /skill or the composer popover. */
export function parseSkillsOn(raw: unknown): string[] {
  return parseIdList(raw);
}

/**
 * Skills that actually reach the model: enabled globally OR switched on for
 * this chat, and not muted here. `/skill` works even when the skill is off in
 * Settings, which is what makes skills opt-in instead of always-on.
 */
export function activeSkills(
  skills: PromptSkill[] = [],
  skillsOff: string[] = [],
  skillsOn: string[] = []
): PromptSkill[] {
  const off = new Set(skillsOff);
  const on = new Set(skillsOn);
  return skills.filter((s) => (Number(s.enabled) === 1 || on.has(s.id)) && !off.has(s.id));
}

/**
 * The injected skills block, capped as a whole. A skill that does not fit is
 * replaced by a one-line marker rather than half a paragraph — a truncated
 * instruction is worse than a missing one, because the model cannot tell.
 */
export function buildSkillsBlock(skills: PromptSkill[], skillsOff: string[] = [], skillsOn: string[] = []): string | null {
  const list = activeSkills(skills, skillsOff, skillsOn);
  if (!list.length) return null;
  const lines: string[] = ['# Active skills'];
  let used = lines[0].length;
  for (const s of list) {
    const description = (s.description || '').trim();
    const body = `## ${s.name}${description ? '\n' + description : ''}\n${s.content.trim()}`;
    if (used + body.length + 2 > SKILLS_BLOCK_CHARS) {
      lines.push(`[skill truncated: ${s.name} did not fit in the ${SKILLS_BLOCK_CHARS}-character budget]`);
      break;
    }
    lines.push(body);
    used += body.length + 2;
  }
  return lines.join('\n\n');
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const parts: string[] = [];
  const system = (opts.systemOverride || '').trim() || (opts.defaultSystem || '').trim();
  if (system) parts.push(system);
  // Labelled with its rank: models otherwise treat agent.md as just more
  // context and let a reply style or a mid-thread aside override it.
  if (opts.agentMd?.trim()) {
    parts.push('# Agent instructions (highest priority after the system prompt)\n' + opts.agentMd.trim());
  }

  // The working mode sits right under the system prompt: a reply style or a
  // long project block must not be able to outrank "plan, don't draft".
  if (opts.mode) parts.push(buildModeBlock(opts.mode, !!opts.agentMode));

  // The Agent workspace is the only place the model may move itself between
  // modes; Chat and Writing keep the mode the user picked.
  if (opts.workspace === 'agent') {
    parts.push([
      '# Agent workspace',
      'Tools are always available here and you can work across the whole app: projects, the story bible, chapters, story flow, memories and the web.',
      'The four modes are plan, brainstorm, write and edit. Call set_mode when the task moves on (plan first, then write, then edit), then keep working in the new mode without asking the user to switch it by hand.',
      'Do not call set_mode with the mode you are already in.',
      'Skills ship off. Before a task, call list_skills, then use_skill for the ones that fit what you are about to do; call drop_skill when a skill stops applying. Keep two or three active at a time so they cannot contradict each other, and never ask the user to switch a skill on by hand.'
    ].join('\n'));
  }

  const project = opts.project || null;
  if (project) {
    const fmt = FORMAT_LABELS[String(project.format || '')];
    if (fmt) parts.push('# Work format\nThis project is ' + fmt + '.');
    const rating = RATING_LABELS[String(project.rating || '')];
    if (rating) parts.push('# ' + rating);
    if (project.context?.trim()) parts.push('# Project: ' + project.name + '\n' + project.context.trim());
  }

  if (!opts.agentMode) {
    const bibleBlock = buildBibleBlock(opts.bible || []);
    if (bibleBlock) parts.push(bibleBlock);
  }
  if (opts.webSearch) parts.push(buildWebBlock());

  if (opts.memoryEnabled) {
    const mems = (opts.memories || []).map((m) => String(m || '').trim()).filter(Boolean);
    if (mems.length) parts.push('# Long-term memory\n' + mems.map((m) => '- ' + m).join('\n'));
  }

  const skillsBlock = buildSkillsBlock(opts.skills || [], opts.skillsOff || [], opts.skillsOn || []);
  if (skillsBlock) parts.push(skillsBlock);

  if (opts.goal?.trim()) parts.push('# Session goal\n' + opts.goal.trim());

  if (opts.style) {
    const kind = Number(opts.style.builtin) === 1 ? '' : ' (custom)';
    parts.push('# Reply style' + kind + '\n' + opts.style.content.trim());
  }

  // Agent protocol first, then the concrete tool names it should call.
  if (opts.agentMode) parts.push(buildAgentBlock());

  // Only advertise tools when they will actually be sent — otherwise models
  // reply with unusable tool-call text.
  if (opts.toolsEnabled) {
    const styleName = opts.style?.name || null;
    const hint = styleName
      ? `You have native story tools (${TOOL_NAMES}). When a tool result comes back, write the surrounding reply in the user's "${styleName}" style — but tool calls themselves stay plain and functional. Use tools proactively when the user discusses story worldbuilding, characters, items, lore or chapters.`
      : `You have native tools (${TOOL_NAMES}). Use them proactively when the user discusses story worldbuilding, characters, items, lore or chapters.`;
    parts.push('# Story tools\n' + hint);
    const mcp = (opts.mcpTools || []).map((n) => String(n || '').trim()).filter(Boolean);
    if (mcp.length) {
      parts.push('# Connected MCP tools\nThe user connected MCP servers; their tools are callable like the story tools above:\n' +
        mcp.map((n) => '- ' + n).join('\n') +
        '\nCall them when they are the right tool for the request. If a call fails, say what the server reported instead of inventing a result.');
    }
  }

  const attachments = buildAttachmentPrompt(opts.attachments || []);
  if (attachments) parts.push(attachments);

  return parts.join('\n\n');
}
