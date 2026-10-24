/**
 * Plot Smith — the story-development agent.
 *
 * A guided, option-driven workflow that turns a short brief into a saved plan:
 * premise options → cast & world → three-act outline → a real project with
 * bible entries, chapters and flow beats.
 *
 * Everything here is pure (no React, no DB) so the prompts, JSON recovery and
 * plan→project conversion are unit-tested: scripts/story-agent-test.mjs.
 */
import type { ContentRating, WorkFormat, StoryKind } from '../types';

// ------------------------------------------------------------------ options --

export interface Choice {
  id: string;
  en: string;
  id_label: string;
  hintEn?: string;
  hintId?: string;
}

export const GENRES: Choice[] = [
  { id: 'fantasy', en: 'Fantasy', id_label: 'Fantasi', hintEn: 'magic, myth, invented worlds', hintId: 'sihir, mitos, dunia rekaan' },
  { id: 'scifi', en: 'Science fiction', id_label: 'Fiksi ilmiah', hintEn: 'technology, space, futures', hintId: 'teknologi, antariksa, masa depan' },
  { id: 'mystery', en: 'Mystery', id_label: 'Misteri', hintEn: 'clues, secrets, a question to solve', hintId: 'petunjuk, rahasia, teka-teki' },
  { id: 'romance', en: 'Romance', id_label: 'Romansa', hintEn: 'longing, chemistry, choice', hintId: 'kerinduan, chemistry, pilihan' },
  { id: 'thriller', en: 'Thriller', id_label: 'Thriller', hintEn: 'pressure, danger, momentum', hintId: 'tekanan, bahaya, ketegangan' },
  { id: 'horror', en: 'Horror', id_label: 'Horor', hintEn: 'dread, the uncanny, survival', hintId: 'kengerian, yang ganjil, bertahan hidup' },
  { id: 'historical', en: 'Historical', id_label: 'Sejarah', hintEn: 'a real past, strongly felt', hintId: 'masa lalu nyata, terasa hidup' },
  { id: 'adventure', en: 'Adventure', id_label: 'Petualangan', hintEn: 'journeys, obstacles, discovery', hintId: 'perjalanan, rintangan, penemuan' },
  { id: 'slice', en: 'Slice of life', id_label: 'Potongan kehidupan', hintEn: 'ordinary days, deep feeling', hintId: 'hari biasa, perasaan mendalam' },
  { id: 'literary', en: 'Literary', id_label: 'Sastra', hintEn: 'voice, theme, ambiguity', hintId: 'gaya, tema, ambiguitas' }
];

export const TONES: Choice[] = [
  { id: 'epic', en: 'Epic', id_label: 'Epik', hintEn: 'sweeping, consequential', hintId: 'luas, penuh konsekuensi' },
  { id: 'dark', en: 'Dark', id_label: 'Gelap', hintEn: 'grim, morally tangled', hintId: 'muram, moral yang rumit' },
  { id: 'hopeful', en: 'Hopeful', id_label: 'Penuh harapan', hintEn: 'warm, earned optimism', hintId: 'hangat, optimisme yang diperjuangkan' },
  { id: 'whimsical', en: 'Whimsical', id_label: 'Cerah aneh', hintEn: 'playful, strange, charming', hintId: 'ringan, aneh, memikat' },
  { id: 'gritty', en: 'Gritty', id_label: 'Kasar', hintEn: 'grounded, unglamorous', hintId: 'membumi, tanpa kilau' },
  { id: 'cozy', en: 'Cozy', id_label: 'Hangat', hintEn: 'safe, intimate, gentle', hintId: 'aman, intim, lembut' },
  { id: 'melancholic', en: 'Melancholic', id_label: 'Melankolis', hintEn: 'quiet grief, beauty', hintId: 'duka sunyi, keindahan' },
  { id: 'satirical', en: 'Satirical', id_label: 'Satir', hintEn: 'sharp, funny, pointed', hintId: 'tajam, lucu, menyindir' }
];

export const POVS: Choice[] = [
  { id: 'third-limited', en: 'Third person, limited', id_label: 'Orang ketiga, terbatas', hintEn: 'closest to one character at a time', hintId: 'dekat ke satu tokoh setiap adegan' },
  { id: 'first-person', en: 'First person', id_label: 'Orang pertama', hintEn: 'the narrator says “I”', hintId: 'narator berkata “aku”' },
  { id: 'third-omniscient', en: 'Third person, omniscient', id_label: 'Orang ketiga, mahatahu', hintEn: 'the camera knows every mind', hintId: 'kamera tahu semua pikiran' },
  { id: 'second-person', en: 'Second person', id_label: 'Orang kedua', hintEn: 'the narrator says “you”', hintId: 'narator berkata “kamu”' }
];

export const LENGTHS: Choice[] = [
  { id: 'flash', en: 'Flash (~1,500 words)', id_label: 'Kilat (~1.500 kata)', hintEn: 'one scene, one turn', hintId: 'satu adegan, satu perubahan' },
  { id: 'short', en: 'Short story (~5,000)', id_label: 'Cerpen (~5.000)', hintEn: 'single arc', hintId: 'satu busur' },
  { id: 'novelette', en: 'Novelette (~12,000)', id_label: 'Novelet (~12.000)', hintEn: 'a few turns', hintId: 'beberapa perubahan' },
  { id: 'novella', en: 'Novella (~30,000)', id_label: 'Novela (~30.000)', hintEn: 'deep but tight', hintId: 'mendalam tapi padat' },
  { id: 'novel', en: 'Novel (~80,000)', id_label: 'Novel (~80.000)', hintEn: 'full arcs and subplots', hintId: 'busur penuh dan subplot' },
  { id: 'epic', en: 'Epic (150,000+)', id_label: 'Epik (150.000+)', hintEn: 'multi-arc, large cast', hintId: 'banyak busur, banyak tokoh' }
];

export const FORMATS: Array<{ id: WorkFormat; en: string; id_label: string }> = [
  { id: 'short-story', en: 'Short story', id_label: 'Cerpen' },
  { id: 'novel', en: 'Novel', id_label: 'Novel' },
  { id: 'book', en: 'Book / series', id_label: 'Buku / seri' },
  { id: 'fanfic', en: 'Fan fiction', id_label: 'Fanfiction' },
  { id: 'script', en: 'Script', id_label: 'Naskah' }
];

export const AUDIENCES: Array<{ id: ContentRating; en: string; id_label: string }> = [
  { id: 'family', en: 'Family', id_label: 'Semua umur' },
  { id: 'teen', en: 'Teen', id_label: 'Remaja' },
  { id: 'mature', en: 'Mature', id_label: 'Dewasa' }
];

export const LENGTH_WORDS: Record<string, number> = {
  flash: 1500,
  short: 5000,
  novelette: 12000,
  novella: 30000,
  novel: 80000,
  epic: 150000
};

export interface StoryBrief {
  idea: string;
  genres: string[];
  tone: string;
  audience: ContentRating;
  format: WorkFormat;
  pov: string;
  length: string;
  language: 'en' | 'id';
  notes: string;
}

export const DEFAULT_BRIEF: StoryBrief = {
  idea: '',
  genres: ['fantasy'],
  tone: 'hopeful',
  audience: 'teen',
  format: 'novel',
  pov: 'third-limited',
  length: 'novel',
  language: 'en',
  notes: ''
};

export function optionLabel(list: Choice[], id: string, lang: 'en' | 'id'): string {
  const found = list.find((o) => o.id === id);
  if (!found) return id;
  return lang === 'id' ? found.id_label : found.en;
}

export function briefSummary(brief: StoryBrief, lang: 'en' | 'id'): string {
  const genres = brief.genres.map((g) => optionLabel(GENRES, g, lang)).join(', ') || '—';
  const tone = optionLabel(TONES, brief.tone, lang);
  const pov = optionLabel(POVS, brief.pov, lang);
  const len = optionLabel(LENGTHS, brief.length, lang);
  const fmt = FORMATS.find((f) => f.id === brief.format);
  const aud = AUDIENCES.find((a) => a.id === brief.audience);
  if (lang === 'id') {
    return `${genres} · ${tone} · ${pov} · ${len} · ${fmt?.id_label || brief.format} · ${aud?.id_label || brief.audience}`;
  }
  return `${genres} · ${tone} · ${pov} · ${len} · ${fmt?.en || brief.format} · ${aud?.en || brief.audience}`;
}

// -------------------------------------------------------------------- plan --

export interface PremiseOption {
  title: string;
  logline: string;
  hook: string;
  stakes: string;
  themes: string[];
  openingImage: string;
}

export interface StoryCharacter {
  name: string;
  role: string;
  age: string;
  want: string;
  flaw: string;
  secret: string;
  description: string;
}

export interface StoryLocation {
  name: string;
  description: string;
  significance: string;
}

export interface StoryLore {
  title: string;
  content: string;
  relevance: string;
}

export interface CastBundle {
  world: { name: string; premise: string; rules: string; conflict: string };
  characters: StoryCharacter[];
  locations: StoryLocation[];
  lore: StoryLore[];
}

export interface OutlineBeat {
  title: string;
  summary: string;
}

export interface OutlineAct {
  act: number;
  title: string;
  summary: string;
  beats: OutlineBeat[];
}

export interface StoryChapterPlan {
  title: string;
  summary: string;
  act: number;
}

export interface OutlineBundle {
  acts: OutlineAct[];
  chapters: StoryChapterPlan[];
  themes: string[];
}

export interface StoryPlanState {
  premise: PremiseOption | null;
  cast: CastBundle | null;
  outline: OutlineBundle | null;
}

export const EMPTY_PLAN: StoryPlanState = { premise: null, cast: null, outline: null };

// ------------------------------------------------------------ json recovery --

/** Pull the first JSON object/array out of a model reply, tolerating fences. */
export function extractJsonBlock(text: string): string | null {
  let raw = String(text || '').trim();
  if (!raw) return null;
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) raw = fence[1].trim();
  const firstObj = raw.indexOf('{');
  const firstArr = raw.indexOf('[');
  let start = -1;
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) start = firstObj;
  else if (firstArr >= 0) start = firstArr;
  if (start < 0) return null;
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  const end = raw.lastIndexOf(close);
  if (end <= start) return null;
  let candidate = raw.slice(start, end + 1);
  // Common model slips: trailing commas and smart quotes around keys.
  candidate = candidate
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  return candidate;
}

export function parseAgentJson(text: string): any | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  try { return JSON.parse(block); } catch { return null; }
}

const str = (v: unknown, max = 4000): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const multi = (v: unknown, max = 1200): string => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function normalizePremises(value: any): PremiseOption[] {
  const list = arr(value?.options ?? value?.premises ?? value);
  return list
    .map((o: any) => ({
      title: str(o?.title ?? o?.name, 160),
      logline: str(o?.logline ?? o?.summary ?? o?.description, 600),
      hook: str(o?.hook ?? o?.twist ?? o?.question, 600),
      stakes: str(o?.stakes ?? o?.conflict, 500),
      themes: arr(o?.themes).map((t) => str(t, 60)).filter(Boolean).slice(0, 6),
      openingImage: str(o?.openingImage ?? o?.opening ?? o?.image, 500)
    }))
    .filter((o) => o.title && o.logline)
    .slice(0, 4);
}

export function normalizeCast(value: any): CastBundle | null {
  const src = value?.cast ?? value ?? {};
  const world = src.world ?? {};
  const characters = arr(src.characters ?? src.cast).map((c: any) => ({
    name: str(c?.name, 120),
    role: str(c?.role, 80),
    age: str(c?.age, 40),
    want: str(c?.want ?? c?.goal ?? c?.motivation, 500),
    flaw: str(c?.flaw ?? c?.weakness, 500),
    secret: str(c?.secret, 500),
    description: multi(c?.description ?? c?.bio ?? c?.summary, 3000)
  })).filter((c) => c.name).slice(0, 10);
  const locations = arr(src.locations).map((l: any) => ({
    name: str(l?.name, 120),
    description: multi(l?.description ?? l?.summary, 3000),
    significance: str(l?.significance ?? l?.role, 500)
  })).filter((l) => l.name).slice(0, 8);
  const lore = arr(src.lore ?? src.lores).map((l: any) => ({
    title: str(l?.title ?? l?.name, 160),
    content: multi(l?.content ?? l?.description ?? l?.summary, 4000),
    relevance: str(l?.relevance ?? l?.why, 500)
  })).filter((l) => l.title).slice(0, 8);
  if (!characters.length && !locations.length && !lore.length) return null;
  return {
    world: {
      name: str(world?.name, 160),
      premise: multi(world?.premise ?? world?.description, 3000),
      rules: multi(world?.rules ?? world?.magic ?? world?.technology, 3000),
      conflict: multi(world?.conflict ?? world?.tension, 2000)
    },
    characters,
    locations,
    lore
  };
}

export function normalizeOutline(value: any): OutlineBundle | null {
  const src = value?.outline ?? value ?? {};
  const acts = arr(src.acts ?? src.beats).map((a: any, i: number) => ({
    act: Number.isFinite(Number(a?.act)) ? Math.min(4, Math.max(1, Number(a.act))) : i + 1,
    title: str(a?.title ?? a?.name, 160),
    summary: multi(a?.summary, 2000),
    beats: arr(a?.beats).map((b: any) => ({
      title: str(b?.title ?? b?.name, 160),
      summary: multi(b?.summary ?? b?.description, 1200)
    })).filter((b) => b.title).slice(0, 20)
  })).filter((a) => a.title || a.beats.length).slice(0, 4);
  const chapters = arr(src.chapters).map((c: any, i: number) => ({
    title: str(c?.title ?? c?.name, 160) || `Chapter ${i + 1}`,
    summary: multi(c?.summary ?? c?.description ?? c?.synopsis, 2000),
    act: Number.isFinite(Number(c?.act)) ? Math.min(4, Math.max(1, Number(c.act))) : 0
  })).filter((c) => c.title).slice(0, 60);
  if (!acts.length && !chapters.length) return null;
  return { acts, chapters, themes: arr(src.themes).map((t) => str(t, 60)).filter(Boolean).slice(0, 8) };
}

export function normalizePlanState(value: any): StoryPlanState {
  const rawPremise = value?.premise;
  return {
    premise: rawPremise
      ? normalizePremises({ options: Array.isArray(rawPremise) ? rawPremise : [rawPremise] })[0] || null
      : null,
    cast: normalizeCast(value?.cast),
    outline: normalizeOutline(value?.outline)
  };
}

/** Empty-string-safe boolean for the UI's “include …” checkboxes. */
export function hasPremise(plan: StoryPlanState): plan is StoryPlanState & { premise: PremiseOption } {
  return !!plan.premise && !!plan.premise.title;
}

// ------------------------------------------------------------------ prompts --

const LANG_LINE: Record<'en' | 'id', string> = {
  en: 'Write every title, name, logline and description in English.',
  id: 'Tulis semua judul, nama, logline, dan deskripsi dalam Bahasa Indonesia.'
};

const RATING_GUARD: Record<ContentRating, string> = {
  family: 'Content rating: FAMILY. Keep everything suitable for all ages; no graphic violence, no sexual content, mild peril only.',
  teen: 'Content rating: TEEN. Mild profanity at most; darker themes allowed but non-graphic; no explicit sexual content.',
  mature: 'Content rating: MATURE. Adult themes, strong language and graphic violence are allowed where the story needs them; sexual content stays non-explicit (fade to black).'
};

function systemPrompt(): string {
  return [
    'You are Plot Smith, the story-development agent inside OpenPlot AI.',
    'You design character-driven, commercially aware fiction and you are decisive: you make concrete choices instead of offering vague ideas.',
    'Reply with STRICT JSON ONLY. No prose before or after, no markdown fences, no comments.',
    'Never invent a field that was not requested and never omit a required field; use an empty string when a value is genuinely unknown.'
  ].join(' ');
}

function briefBlock(brief: StoryBrief): string {
  const words = LENGTH_WORDS[brief.length] || 80000;
  const genres = brief.genres.map((g) => optionLabel(GENRES, g, 'en')).join(', ') || 'unspecified';
  return [
    `Genres: ${genres}`,
    `Tone: ${optionLabel(TONES, brief.tone, 'en')}`,
    `Point of view: ${optionLabel(POVS, brief.pov, 'en')}`,
    `Format: ${brief.format}`,
    `Target length: about ${words.toLocaleString('en-US')} words`,
    `Audience: ${brief.audience}`,
    RATING_GUARD[brief.audience],
    LANG_LINE[brief.language],
    brief.idea.trim() ? `Seed idea from the author: ${brief.idea.trim()}` : 'Seed idea: none — invent one that fits the choices above.',
    brief.notes.trim() ? `Author notes / must-haves: ${brief.notes.trim()}` : ''
  ].filter(Boolean).join('\n');
}

export function premisePrompt(brief: StoryBrief): { system: string; user: string } {
  return {
    system: systemPrompt(),
    user: `${briefBlock(brief)}

Propose 3 genuinely DIFFERENT story premises. Each must be a complete story idea (a character, a desire, an obstacle, a cost), not a setting description.
Keep loglines under 45 words. The three options must differ in protagonist, central conflict and emotional flavour.

Return exactly this JSON shape:
{"options":[{"title":"...","logline":"...","hook":"...","stakes":"...","themes":["...","..."],"openingImage":"..."}]}`
  };
}

export function castPrompt(brief: StoryBrief, premise: PremiseOption): { system: string; user: string } {
  return {
    system: systemPrompt(),
    user: `${briefBlock(brief)}

Chosen premise
Title: ${premise.title}
Logline: ${premise.logline}
Hook: ${premise.hook}
Stakes: ${premise.stakes}
Themes: ${premise.themes.join(', ') || '—'}

Build the story's core cast and world. Requirements:
- 4 to 6 characters. Exactly one protagonist and one antagonist; the rest are allies, mentors, rivals or wildcards. Every character needs a want, a flaw and a secret that can cause trouble later.
- 2 to 4 locations that matter to the plot (not decoration).
- 2 to 4 lore entries (history, rules, factions, myths) that create constraints the characters must work around.
- The world block states the central conflict in one sentence.

Return exactly this JSON shape:
{"world":{"name":"...","premise":"...","rules":"...","conflict":"..."},"characters":[{"name":"...","role":"protagonist","age":"...","want":"...","flaw":"...","secret":"...","description":"..."}],"locations":[{"name":"...","description":"...","significance":"..."}],"lore":[{"title":"...","content":"...","relevance":"..."}]}`
  };
}

export function outlinePrompt(brief: StoryBrief, premise: PremiseOption, cast: CastBundle): { system: string; user: string } {
  const words = LENGTH_WORDS[brief.length] || 80000;
  const chapterTarget = words <= 2000 ? 2 : words <= 6000 ? 4 : words <= 15000 ? 7 : words <= 40000 ? 12 : words <= 90000 ? 20 : 28;
  return {
    system: systemPrompt(),
    user: `${briefBlock(brief)}

Premise: ${premise.title} — ${premise.logline}
Cast: ${cast.characters.map((c) => `${c.name} (${c.role})`).join('; ')}
World conflict: ${cast.world.conflict || '—'}
Locations: ${cast.locations.map((l) => l.name).join(', ') || '—'}

Design the plot.
- Exactly 3 acts. Act 1 ends with the point of no return, act 2 turns at the midpoint and bottoms out before the finale, act 3 resolves the central conflict and pays off the protagonist's flaw.
- 3 to 6 beats per act. Each beat is a concrete event with a consequence, not a mood.
- ${chapterTarget} chapters. Each chapter covers one or two beats and has a one-sentence purpose.
- Number acts 1, 2, 3 and give every chapter the act it belongs to.

Return exactly this JSON shape:
{"acts":[{"act":1,"title":"...","summary":"...","beats":[{"title":"...","summary":"..."}]}],"chapters":[{"title":"...","summary":"...","act":1}],"themes":["..."]}`
  };
}

// --------------------------------------------------------- project creation --

export interface ProjectSeedEntry {
  kind: StoryKind;
  title: string;
  content: string;
  tags: string[];
}

export interface ProjectSeedChapter {
  title: string;
  content: string;
  status: 'draft' | 'revising' | 'done';
}

export interface ProjectSeedBeat {
  act: number;
  title: string;
  summary: string;
  status: 'planned' | 'drafting' | 'written';
}

export interface ProjectSeed {
  project: {
    name: string;
    description: string;
    context: string;
    format: WorkFormat;
    rating: ContentRating;
  };
  entries: ProjectSeedEntry[];
  chapters: ProjectSeedChapter[];
  beats: ProjectSeedBeat[];
}

export interface SeedOptions {
  name?: string;
  includeBible?: boolean;
  includeChapters?: boolean;
}

/**
 * Turn a finished plan into plain payloads for the existing DB ops. Keeping
 * this pure means the "Create project" action is a thin loop in the UI and the
 * exact conversion is covered by tests.
 */
export function buildProjectSeed(
  brief: StoryBrief,
  premise: PremiseOption,
  cast: CastBundle | null,
  outline: OutlineBundle | null,
  options: SeedOptions = {}
): ProjectSeed {
  const includeBible = options.includeBible !== false;
  const includeChapters = options.includeChapters !== false;
  const genres = brief.genres.map((g) => optionLabel(GENRES, g, 'en'));
  const tags = ['story-agent', ...genres.map((g) => g.toLowerCase())].slice(0, 8);
  const name = (options.name || premise.title || 'Untitled story').trim().slice(0, 160);
  const words = LENGTH_WORDS[brief.length] || 80000;

  const contextLines = [
    '## Story brief',
    `- Genres: ${genres.join(', ') || '—'}`,
    `- Tone: ${optionLabel(TONES, brief.tone, 'en')}`,
    `- POV: ${optionLabel(POVS, brief.pov, 'en')}`,
    `- Target length: ~${words.toLocaleString('en-US')} words (${brief.length})`,
    `- Audience: ${brief.audience}`,
    `- Logline: ${premise.logline}`,
    premise.hook ? `- Hook: ${premise.hook}` : '',
    premise.stakes ? `- Stakes: ${premise.stakes}` : '',
    premise.themes.length ? `- Themes: ${premise.themes.join(', ')}` : '',
    brief.idea.trim() ? `\n## Seed idea\n${brief.idea.trim()}` : '',
    brief.notes.trim() ? `\n## Author notes\n${brief.notes.trim()}` : '',
    cast && (cast.world.premise || cast.world.rules)
      ? `\n## World\n${[cast.world.premise, cast.world.rules ? `Rules: ${cast.world.rules}` : '', cast.world.conflict ? `Central conflict: ${cast.world.conflict}` : ''].filter(Boolean).join('\n\n')}`
      : '',
    cast?.characters.length
      ? `\n## Cast\n${cast.characters.map((c) => `- **${c.name}** (${c.role || 'cast'}) — ${c.want || c.description}`).join('\n')}`
      : ''
  ].filter(Boolean);

  const entries: ProjectSeedEntry[] = [];
  if (includeBible && cast) {
    const worldName = cast.world.name || name;
    const worldBody = [
      cast.world.premise,
      cast.world.rules ? `## Rules\n${cast.world.rules}` : '',
      cast.world.conflict ? `## Central conflict\n${cast.world.conflict}` : ''
    ].filter(Boolean).join('\n\n');
    if (worldBody.trim()) {
      entries.push({ kind: 'world', title: worldName, content: worldBody.trim(), tags });
    }
    for (const c of cast.characters) {
      const lines = [
        c.description,
        c.role ? `## Role\n${c.role}` : '',
        c.age ? `## Age\n${c.age}` : '',
        c.want ? `## Want\n${c.want}` : '',
        c.flaw ? `## Flaw\n${c.flaw}` : '',
        c.secret ? `## Secret\n${c.secret}` : ''
      ].filter(Boolean);
      entries.push({ kind: 'character', title: c.name, content: lines.join('\n\n').trim(), tags });
    }
    for (const l of cast.locations) {
      const lines = [l.description, l.significance ? `## Why it matters\n${l.significance}` : ''].filter(Boolean);
      entries.push({ kind: 'location', title: l.name, content: lines.join('\n\n').trim(), tags });
    }
    for (const l of cast.lore) {
      const lines = [l.content, l.relevance ? `## Relevance\n${l.relevance}` : ''].filter(Boolean);
      entries.push({ kind: 'lore', title: l.title, content: lines.join('\n\n').trim(), tags });
    }
  }

  const chapters: ProjectSeedChapter[] = includeChapters && outline
    ? outline.chapters.map((c) => ({
        title: c.title,
        content: c.summary ? `> **Outline** — ${c.summary}\n\n` : '',
        status: 'draft' as const
      }))
    : [];

  const beats: ProjectSeedBeat[] = outline
    ? outline.acts.flatMap((a) => a.beats.map((b) => ({
        act: a.act,
        title: b.title,
        summary: b.summary,
        status: 'planned' as const
      })))
    : [];

  return {
    project: {
      name,
      description: premise.logline.slice(0, 500),
      context: contextLines.join('\n'),
      format: brief.format,
      rating: brief.audience
    },
    entries: entries.filter((e) => e.title.trim() && e.content.trim()),
    chapters,
    beats
  };
}
