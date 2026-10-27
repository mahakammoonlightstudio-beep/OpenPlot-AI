/**
 * Prompt Library — curated starter prompts for storytellers.
 *
 * Inserted from the composer by typing "/" (or via the + ADD panel).
 * `template` strings may contain {placeholders}; anything the user types
 * right after insertion replaces the FIRST placeholder, so
 *   "Critique {my_chapter_name} ..." + "chapter 3" becomes a ready prompt.
 * Everything is local text — no DB row, no settings key needed.
 */

export type PromptCategory = 'craft' | 'bible' | 'revise' | 'chat' | 'user';

export interface LibraryPrompt {
  id: string;
  category: PromptCategory;
  /** Short label shown in the menu. */
  label: string;
  /** One-line description of what the prompt does. */
  desc: string;
  /** The actual prompt text. {placeholders} are replaced on insert. */
  template: string;
}

const FIRST_PLACEHOLDER = /\{[a-z_]+\}/i;

/** Replace the first {placeholder} with the user's seed text (if any). */
export function applyPromptTemplate(template: string, seed?: string): string {
  const text = (seed || '').trim();
  if (!text || !FIRST_PLACEHOLDER.test(template)) return template;
  return template.replace(FIRST_PLACEHOLDER, text);
}

export const PROMPT_LIBRARY: LibraryPrompt[] = [
  // ---- Craft ----
  {
    id: 'continue-scene',
    category: 'craft',
    label: 'Continue my scene',
    desc: 'Picks up the prose where you stopped, matching voice',
    template: 'Continue writing my scene from where it stops. Match the established voice and tense, keep momentum, and end on a small hook. Return ONLY the continuation prose.\n\n---\n{paste_your_scene_here}\n---'
  },
  {
    id: 'describe-setting',
    category: 'craft',
    label: 'Describe a setting vividly',
    desc: 'Sensory paragraph for any location',
    template: 'Write a vivid, sensory description of {place}. Engage at least three senses, hint at the mood of the scene, and keep it under 150 words. No clichés.'
  },
  {
    id: 'dialogue-pass',
    category: 'craft',
    label: 'Write a dialogue exchange',
    desc: 'Two characters, distinct voices, tension',
    template: 'Write a short dialogue exchange between {character_a} and {character_b}. Give each a distinct voice and let them want different things — the tension should be in the subtext, not stated outright.'
  },
  {
    id: 'brainstorm-names',
    category: 'craft',
    label: 'Brainstorm names',
    desc: '10 name options with a flavor note each',
    template: 'Give me 10 name options for {thing}, each with a one-line note on the flavor/vibe it carries. Favor names that are easy to pronounce but memorable.'
  },
  {
    id: 'opening-line',
    category: 'craft',
    label: 'Generate opening lines',
    desc: '5 contrasting first lines to choose from',
    template: 'Write 5 possible opening lines for a story about {premise}. Make them contrast in tone (e.g. ominous, wry, intimate, epic, clinical) so I can pick a direction.'
  },

  // ---- Story Bible ----
  {
    id: 'build-character',
    category: 'bible',
    label: 'Build a character profile',
    desc: 'Full profile, then saved via story tools',
    template: 'Build a complete character profile for {name_or_concept}: appearance, personality, motivation, fears, flaws and a character arc. Then use your create_story_entry tool to save it as a character in my active project.'
  },
  {
    id: 'expand-lore',
    category: 'bible',
    label: 'Expand my lore',
    desc: 'Deepens an entry with history and implications',
    template: 'Here is my lore entry:\n\n{paste_lore_here}\n\nExpand it: add the legend as commonly told, the hidden truth beneath it, and two plot implications. Then update the entry with your story tools.'
  },
  {
    id: 'worldbuilding-gaps',
    category: 'bible',
    label: 'Find worldbuilding gaps',
    desc: 'Audits the bible for inconsistencies & holes',
    template: 'Review my story bible for gaps: missing motivations, unexplained rules, contradictions between entries. Ask me about anything critical that is undefined. Use your search_story tool to check before assuming.'
  },
  {
    id: 'faction-dynamics',
    category: 'bible',
    label: 'Design faction dynamics',
    desc: 'Relationships, rivalries & pressure points',
    template: 'Design the power dynamics between the factions/groups in my story. For each pair: relationship status, source of tension, and what would push them to open conflict. Summarize as a compact table I can paste into my world entry.'
  },

  // ---- Revision ----
  {
    id: 'critique-chapter',
    category: 'revise',
    label: 'Critique this chapter',
    desc: 'Pacing, voice, stakes, prose — with fixes',
    template: 'Critique the chapter below. Cover pacing, character voice, stakes and prose quality. Be specific: quote the weak lines and show a stronger rewrite for each. End with the three highest-impact fixes.\n\n---\n{paste_chapter_here}\n---'
  },
  {
    id: 'tighten-prose',
    category: 'revise',
    label: 'Tighten my prose',
    desc: 'Cuts filler, keeps meaning (~20% shorter)',
    template: 'Tighten the prose below by roughly 20%: cut filler words, redundancies and over-explaining, but keep the voice and all story-relevant detail. Show the revised text only.\n\n{paste_paragraphs_here}'
  },
  {
    id: 'show-dont-tell',
    category: 'revise',
    label: 'Show-don\'t-tell pass',
    desc: 'Converts exposition into dramatized moments',
    template: 'Rewrite the passages below that TELL instead of SHOW. Convert exposition into action, dialogue or sensory detail — but only where it genuinely improves the scene; leave intentional summary alone.\n\n{paste_text_here}'
  },
  {
    id: 'pacing-map',
    category: 'revise',
    label: 'Map my story pacing',
    desc: 'Tension curve with rise/climax/fall labels',
    template: 'Here are my chapters in order:\n\n{chapter_list}\n\nMap the pacing: for each chapter estimate tension 1-10, flag flat stretches and rushed escalations, and suggest where a breather or a stronger beat is needed.'
  },

  // ---- Chat ----
  {
    id: 'summarize-chat',
    category: 'chat',
    label: 'Summarize our chat',
    desc: 'Decisions & open questions as bullet points',
    template: 'Summarize our conversation so far as: (1) decisions made, (2) open questions, (3) next steps. Keep it under 150 words.'
  },
  {
    id: 'explain-simply',
    category: 'chat',
    label: 'Explain more simply',
    desc: 'Re-explains the last answer for a beginner',
    template: 'Explain your last answer again as if I were a curious beginner: plain words, one concrete example, no jargon.'
  },
  {
    id: 'devils-advocate',
    category: 'chat',
    label: 'Play devil\'s advocate',
    desc: 'Challenges my plan to surface blind spots',
    template: 'Play devil\'s advocate against my plan below: list the strongest objections, the risks I am likely ignoring, and what would have to be true for it to fail. Be blunt but fair.\n\n{paste_plan_here}'
  }
];

export const PROMPT_CATEGORIES: PromptCategory[] = ['craft', 'bible', 'revise', 'chat'];

// ---- user-defined prompts (stored in the DB via the prompts table) ----

import { UserPrompt } from './types';

/** Adapt a DB row into the menu's LibraryPrompt shape. */
export function userPromptToLibrary(row: UserPrompt): LibraryPrompt {
  return { id: 'user-' + row.id, category: 'user', label: row.title, desc: '', template: row.template };
}

/** Built-ins + user prompts in one menu-ready list. */
export function mergePrompts(user: UserPrompt[] | undefined | null): LibraryPrompt[] {
  const mine = (user || []).map(userPromptToLibrary);
  return [...mine, ...PROMPT_LIBRARY];
}

// ---- portable bundles (import / export) ----

/** Prompts a bundle may carry. Keeps a malformed 10 MB file from flooding the DB. */
export const PROMPT_IMPORT_MAX = 500;

const KNOWN_CATEGORIES: string[] = [...PROMPT_CATEGORIES, 'user'];

/** Stable identity for de-duplication: title + category, case/space-insensitive. */
export function promptKey(title: string, category: string): string {
  return `${String(title).trim().toLowerCase()}|${String(category || 'user').trim().toLowerCase()}`;
}

/** The file a user can share or back up. Only their own prompts travel — the
 *  built-ins ship with the app, so exporting them would freeze them in time. */
export function buildPromptBundle(user: UserPrompt[]): string {
  return JSON.stringify({
    app: 'OpenPlot AI',
    kind: 'prompt-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts: (user || []).map((p) => ({ title: p.title, category: p.category || 'user', template: p.template }))
  }, null, 2);
}

export interface PromptImportResult {
  accepted: { title: string; category: string; template: string }[];
  /** Entries dropped because an identical title+category is already present. */
  duplicates: number;
  /** Entries dropped because they were not shaped like a prompt, plus why. */
  errors: string[];
}

/**
 * Parse an exported (or hand-written) library file.
 *
 * Accepts `{ prompts: [...] }` or a bare array, tolerates extra keys, and
 * refuses anything without a usable title AND template. Duplicates are matched
 * against the existing library and within the file itself, so importing the
 * same bundle twice is a no-op rather than a wall of copies.
 */
export function parsePromptImport(raw: string, existing: UserPrompt[]): PromptImportResult {
  const out: PromptImportResult = { accepted: [], duplicates: 0, errors: [] };
  let data: any;
  try {
    data = JSON.parse(String(raw || ''));
  } catch {
    out.errors.push('Not valid JSON');
    return out;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.prompts) ? data.prompts : null;
  if (!list) {
    out.errors.push('Expected an array of prompts or { prompts: [...] }');
    return out;
  }
  const seen = new Set((existing || []).map((p) => promptKey(p.title, p.category)));
  for (const [i, item] of list.entries()) {
    if (out.accepted.length >= PROMPT_IMPORT_MAX) {
      out.errors.push(`Stopped after ${PROMPT_IMPORT_MAX} prompts`);
      break;
    }
    const title = typeof item?.title === 'string' ? item.title.trim() : typeof item?.label === 'string' ? item.label.trim() : '';
    const template = typeof item?.template === 'string' ? item.template.trim() : '';
    if (!title || !template) {
      out.errors.push(`Entry ${i + 1}: needs a title and a template`);
      continue;
    }
    const rawCat = typeof item?.category === 'string' ? item.category.trim().toLowerCase() : '';
    const category = KNOWN_CATEGORIES.includes(rawCat) ? rawCat : 'user';
    const key = promptKey(title, category);
    if (seen.has(key)) { out.duplicates++; continue; }
    seen.add(key);
    out.accepted.push({ title, category, template });
  }
  return out;
}

// ---- "used in this chat" counts ----
// Session-scoped on purpose: a durable per-message provenance column would be
// the only way to survive a restart, and the count is a nudge, not a record.
const usage = new Map<string, Map<string, number>>();

/** Count one insertion of `promptId` into `chatId`. */
export function notePromptUse(chatId: string | null | undefined, promptId: string): void {
  if (!chatId) return;
  const forChat = usage.get(chatId) || new Map<string, number>();
  forChat.set(promptId, (forChat.get(promptId) || 0) + 1);
  usage.set(chatId, forChat);
}

/** promptId -> times inserted in this chat during the session. */
export function promptUsage(chatId: string | null | undefined): Record<string, number> {
  if (!chatId) return {};
  return Object.fromEntries(usage.get(chatId) || []);
}
