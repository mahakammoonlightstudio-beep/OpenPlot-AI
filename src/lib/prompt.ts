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

export interface PromptSkill {
  id: string;
  name: string;
  description?: string | null;
  content: string;
  enabled?: number | boolean;
}

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
  style?: PromptStyle | null;
  goal?: string | null;
  toolsEnabled?: boolean;
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

const TOOL_NAMES = 'save_memory, list_memories, create_story_entry, update_story_entry, search_story, read_story_bible, read_story_file, create_chapter, update_chapter, append_to_chapter, list_chapters, read_chapter, list_projects, read_project';

/** Chat rows store the opt-out list as JSON text; accept either shape. */
export function parseSkillsOff(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Skills that actually reach the model: enabled globally AND not muted here. */
export function activeSkills(skills: PromptSkill[] = [], skillsOff: string[] = []): PromptSkill[] {
  const off = new Set(skillsOff);
  return skills.filter((s) => Number(s.enabled) === 1 && !off.has(s.id));
}

/**
 * The injected skills block, capped as a whole. A skill that does not fit is
 * replaced by a one-line marker rather than half a paragraph — a truncated
 * instruction is worse than a missing one, because the model cannot tell.
 */
export function buildSkillsBlock(skills: PromptSkill[], skillsOff: string[] = []): string | null {
  const list = activeSkills(skills, skillsOff);
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

  const project = opts.project || null;
  if (project) {
    const fmt = FORMAT_LABELS[String(project.format || '')];
    if (fmt) parts.push('# Work format\nThis project is ' + fmt + '.');
    const rating = RATING_LABELS[String(project.rating || '')];
    if (rating) parts.push('# ' + rating);
    if (project.context?.trim()) parts.push('# Project: ' + project.name + '\n' + project.context.trim());
  }

  if (opts.memoryEnabled) {
    const mems = (opts.memories || []).map((m) => String(m || '').trim()).filter(Boolean);
    if (mems.length) parts.push('# Long-term memory\n' + mems.map((m) => '- ' + m).join('\n'));
  }

  const skillsBlock = buildSkillsBlock(opts.skills || [], opts.skillsOff || []);
  if (skillsBlock) parts.push(skillsBlock);

  if (opts.goal?.trim()) parts.push('# Session goal\n' + opts.goal.trim());

  if (opts.style) {
    const kind = Number(opts.style.builtin) === 1 ? '' : ' (custom)';
    parts.push('# Reply style' + kind + '\n' + opts.style.content.trim());
  }

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
