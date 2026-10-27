/**
 * In-app guide: parsing, indexing and search (v1.2.3 Task 9).
 *
 * Pure and dependency-free on purpose — the articles ship as Markdown files and
 * this module is the only thing that decides what they mean, so a headless test
 * can read the same files from disk and assert against the same code the app
 * runs. Front matter is `key: value` lines, not YAML: the guide needs three
 * fields and a YAML parser would be a dependency for nothing.
 */

export type GuideLang = 'en' | 'id';

export interface GuideHeading {
  id: string;
  text: string;
}

export interface GuideDoc {
  slug: string;
  title: string;
  summary: string;
  order: number;
  body: string;
  headings: GuideHeading[];
  chars: number;
}

/** One article as the UI sees it: translated, or English with a badge. */
export interface GuideArticle extends GuideDoc {
  lang: GuideLang;
  /** True when the requested language has no file and English is shown. */
  fallback: boolean;
}

export interface GuideSearchHit {
  slug: string;
  title: string;
  /** Matching heading, when the hit came from a section rather than the body. */
  section: string | null;
  snippet: string;
  score: number;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const m = text.match(FRONT_MATTER);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

/** Stable anchor id for a heading: ascii slug, numbered when duplicated. */
export function headingId(text: string, seen?: Set<string>): string {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  if (!seen) return base;
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

export function extractHeadings(body: string): GuideHeading[] {
  const seen = new Set<string>();
  const out: GuideHeading[] = [];
  for (const line of String(body || '').split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+)$/);
    if (!m) continue;
    const text = m[2].trim();
    out.push({ id: headingId(text, seen), text });
  }
  return out;
}

export function parseArticle(slug: string, raw: string): GuideDoc {
  const { meta, body } = parseFrontMatter(raw);
  const order = Number(meta.order);
  return {
    slug,
    title: meta.title || slug,
    summary: meta.summary || '',
    order: Number.isFinite(order) ? order : 999,
    body,
    headings: extractHeadings(body),
    chars: body.length
  };
}

export function sortDocs<T extends { order: number; title: string }>(docs: T[]): T[] {
  return [...docs].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/**
 * Resolve one article for a language, falling back to English rather than
 * showing a blank page. `fallback` lets the UI say so instead of pretending.
 */
export function resolveArticle(
  slug: string,
  lang: GuideLang,
  sets: Record<GuideLang, GuideDoc[]>
): GuideArticle | null {
  const primary = sets[lang]?.find((d) => d.slug === slug);
  if (primary) return { ...primary, lang, fallback: false };
  const english = sets.en?.find((d) => d.slug === slug);
  return english ? { ...english, lang: 'en', fallback: lang !== 'en' } : null;
}

/** Article list for a language: translated first, English as the safety net. */
export function articleList(lang: GuideLang, sets: Record<GuideLang, GuideDoc[]>): GuideArticle[] {
  const base = sets.en || [];
  const local = new Map((sets[lang] || []).map((d) => [d.slug, d]));
  return sortDocs(base.map((doc) => {
    const translated = local.get(doc.slug);
    return translated
      ? { ...translated, lang, fallback: false }
      : { ...doc, lang: 'en' as GuideLang, fallback: lang !== 'en' };
  }));
}

export function neighbours(slug: string, list: GuideArticle[]): { prev: GuideArticle | null; next: GuideArticle | null } {
  const i = list.findIndex((a) => a.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: list[i - 1] || null, next: list[i + 1] || null };
}

const clean = (s: string) => String(s || '').replace(/[#*`>|\-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Plain-text window around the first match, for the results list. */
export function snippetAround(haystack: string, needle: string, width = 110): string {
  const text = clean(haystack);
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + text.slice(start, start + width).trim() + (start + width < text.length ? '…' : '');
}

/**
 * Search over title, headings and body, case-insensitive. Title hits rank
 * highest, then section hits, then body — the order a reader expects when they
 * type "cache" and know which page they mean.
 */
export function searchGuide(query: string, list: GuideArticle[]): GuideSearchHit[] {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: GuideSearchHit[] = [];
  for (const a of list) {
    const title = a.title.toLowerCase();
    const heading = a.headings.find((h) => h.text.toLowerCase().includes(q));
    const body = a.body.toLowerCase();
    let score = 0;
    if (title === q) score = 120;
    else if (title.startsWith(q)) score = 100;
    else if (title.includes(q)) score = 80;
    if (heading) score = Math.max(score, 60);
    if (body.includes(q)) score = Math.max(score, 40);
    if (!score) continue;
    const source = heading
      ? a.body.slice(a.body.indexOf(heading.text))
      : a.body;
    hits.push({ slug: a.slug, title: a.title, section: heading ? heading.text : null, snippet: snippetAround(source, q), score });
  }
  return hits.sort((x, y) => y.score - x.score || x.title.localeCompare(y.title));
}

export interface GuideToken {
  kind: 'settings' | 'route' | 'guide';
  target: string;
}

const TOKEN = /\[\[(settings|route|guide):([a-z0-9-]+)\]\]/gi;

/**
 * `[[settings:skills]]`, `[[route:flow]]`, `[[guide:files]]` become in-app
 * links. They are rewritten to hash links so the Markdown sanitizer keeps them
 * (unknown schemes are stripped) and a single delegated click handler can act.
 */
export function rewriteTokens(markdown: string, label: (token: GuideToken) => string): string {
  return String(markdown || '').replace(TOKEN, (_all, kind: string, target: string) => {
    const k = kind.toLowerCase() as GuideToken['kind'];
    return `[${label({ kind: k, target })}](#guide-action-${k}:${target})`;
  });
}

export function parseActionHref(href: string): GuideToken | null {
  const m = String(href || '').match(/^#guide-action-(settings|route|guide):([a-z0-9-]+)$/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase() as GuideToken['kind'], target: m[2] };
}

/** Every token in a set of articles — the guide test asserts they all resolve. */
export function tokensIn(markdown: string): GuideToken[] {
  const out: GuideToken[] = [];
  for (const m of String(markdown || '').matchAll(TOKEN)) {
    out.push({ kind: m[1].toLowerCase() as GuideToken['kind'], target: m[2] });
  }
  return out;
}
