/**
 * Story-bible file import — pure parsing helpers.
 *
 * The whole point: writers keep character sheets, lore notes and outlines in
 * Markdown/JSON/CSV files. Instead of copy-pasting them into the Bible one
 * entry at a time, they can import the file and get real entries. This module
 * has no DOM/Node dependencies so it is unit-tested directly (scripts/
 * story-import-test.mjs) and reused by the import dialog.
 */
import type { StoryKind } from '../types';

export const STORY_KINDS: StoryKind[] = ['world', 'location', 'character', 'item', 'lore'];

export interface ParsedEntry {
  kind: StoryKind;
  title: string;
  content: string;
  tags: string[];
}

export interface ImportResult {
  entries: ParsedEntry[];
  warnings: string[];
}

export interface SourceFile {
  name: string;
  content: string;
}

const MAX_ENTRIES_PER_FILE = 200;
const MAX_ENTRIES_TOTAL = 500;
const MAX_ENTRY_CHARS = 120_000;
const MAX_TITLE = 160;

export function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function normalizeKind(value: unknown): StoryKind | null {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  const aliases: Record<string, StoryKind> = {
    world: 'world', worlds: 'world', setting: 'world', universe: 'world', dunia: 'world',
    location: 'location', locations: 'location', place: 'location', places: 'location', lokasi: 'location', tempat: 'location',
    character: 'character', characters: 'character', person: 'character', people: 'character', cast: 'character', tokoh: 'character', karakter: 'character',
    item: 'item', items: 'item', object: 'item', objects: 'item', artifact: 'item', artefact: 'item', artefak: 'item', benda: 'item',
    lore: 'lore', lores: 'lore', legend: 'lore', legends: 'lore', myth: 'lore', myths: 'lore', history: 'lore', note: 'lore', notes: 'lore', mitos: 'lore', legenda: 'lore'
  };
  return aliases[v] || null;
}

/** Guess a bible category from the filename ("characters_sheet.md" → character). */
export function guessKindFromName(name: string): StoryKind | null {
  const stem = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  const direct = normalizeKind(stem);
  if (direct) return direct;
  // Filenames are often qualified ("characters sheet", "my-lore-notes") —
  // check each word so a useful hint is not wasted.
  for (const word of stem.split(/[^a-z]+/)) {
    const kind = normalizeKind(word);
    if (kind) return kind;
  }
  return null;
}

function cleanTitle(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return (s || fallback).slice(0, MAX_TITLE);
}

function clampContent(raw: unknown): string {
  const s = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  return s.length > MAX_ENTRY_CHARS ? s.slice(0, MAX_ENTRY_CHARS) + '\n\n…[truncated]' : s;
}

function cleanTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
  }
  if (typeof raw === 'string') {
    return raw.split(/[,;|]/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

// ---------------------------------------------------------------- markdown --

/**
 * Split a Markdown document into sections by its `#`, `##` and `###` headings.
 * Text before the first heading becomes an "Overview" entry (when meaningful).
 */
export function parseMarkdownSections(text: string, fallbackTitle = 'Notes'): { title: string; content: string }[] {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/;

  // Split at the SHALLOWEST heading level in the document. A character sheet
  // with `# Kael` + `## Wants` must stay ONE entry, not become a "Wants"
  // entry; a notes file with only `##` sections still splits correctly.
  let splitLevel = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = headingRe.exec(line);
    if (h) {
      const level = h[1].length;
      if (!splitLevel || level < splitLevel) splitLevel = level;
    }
  }
  if (!splitLevel) return [{ title: fallbackTitle, content: lines.join('\n').trim() }].filter((s) => s.content);

  const out: { title: string; content: string }[] = [];
  let title: string | null = null;
  let buf: string[] = [];
  inFence = false;

  const flush = () => {
    const content = buf.join('\n').trim();
    if (title === null) {
      if (content) out.push({ title: fallbackTitle, content });
    } else if (content) {
      out.push({ title, content });
    }
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence ? headingRe.exec(line) : null;
    if (h && h[1].length === splitLevel) {
      flush();
      title = h[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// --------------------------------------------------------------------- csv --

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF, any delimiter. */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!src.trim()) return [];
  let delim = delimiter;
  if (!delim) {
    const firstLine = src.split('\n')[0] || '';
    const counts: Array<[string, number]> = [[',', 0], [';', 0], ['\t', 0]];
    let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ) {
        const hit = counts.find(([d]) => d === ch);
        if (hit) hit[1]++;
      }
    }
    counts.sort((a, b) => b[1] - a[1]);
    delim = counts[0][1] > 0 ? counts[0][0] : ',';
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const TITLE_COLS = ['title', 'name', 'entry', 'heading', 'subject', 'judul', 'nama', 'entri'];
const CONTENT_COLS = ['content', 'description', 'summary', 'text', 'body', 'notes', 'details', 'isi', 'deskripsi', 'ringkasan', 'keterangan'];
const KIND_COLS = ['kind', 'type', 'category', 'tipe', 'kategori', 'jenis'];
const TAG_COLS = ['tags', 'tag', 'labels', 'label'];

function colIndex(header: string[], aliases: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = header[i].trim().toLowerCase();
    if (aliases.includes(h)) return i;
  }
  return -1;
}

export function parseCsvEntries(text: string, fallbackKind: StoryKind, fallbackTitle: string): ParsedEntry[] {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const tIdx = colIndex(header, TITLE_COLS);
  const cIdx = colIndex(header, CONTENT_COLS);
  const kIdx = colIndex(header, KIND_COLS);
  const tagIdx = colIndex(header, TAG_COLS);
  // No recognizable header row → treat every row as [title, content, kind?].
  const hasHeader = tIdx >= 0 || cIdx >= 0 || kIdx >= 0;
  const body = hasHeader ? rows.slice(1) : rows;
  const out: ParsedEntry[] = [];
  body.forEach((row, i) => {
    if (!hasHeader) {
      const title = cleanTitle(row[0], `${fallbackTitle} ${i + 1}`);
      const content = clampContent(row.slice(1).join(' — '));
      const kind = normalizeKind(row[2]) || fallbackKind;
      if (title && content) out.push({ kind, title, content, tags: [] });
      return;
    }
    const title = tIdx >= 0 ? row[tIdx] : row[0];
    let content = cIdx >= 0 ? row[cIdx] : '';
    if (!content) {
      // No content column: join every other populated cell so nothing is lost.
      const skip = new Set([tIdx, kIdx, tagIdx].filter((n) => n >= 0));
      content = row.filter((_, j) => !skip.has(j)).join(' — ');
    }
    const kind = normalizeKind(hasHeader && kIdx >= 0 ? row[kIdx] : hasHeader ? '' : row[2]) || fallbackKind;
    const tags = hasHeader && tagIdx >= 0 ? cleanTags(row[tagIdx]) : [];
    const t = cleanTitle(title, `${fallbackTitle} ${i + 1}`);
    const c = clampContent(content);
    if (!c) return;
    out.push({ kind, title: t, content: c, tags });
  });
  return out;
}

// -------------------------------------------------------------------- json --

function jsonEntriesFromValue(value: unknown, fallbackKind: StoryKind, fallbackTitle: string): ParsedEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => {
      if (typeof item === 'string') return [{ kind: fallbackKind, title: cleanTitle(item, `${fallbackTitle} ${i + 1}`), content: item, tags: [] }];
      if (item && typeof item === 'object') return jsonEntriesFromValue(item, fallbackKind, `${fallbackTitle} ${i + 1}`);
      return [];
    });
  }
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, any>;

  // A container keyed by category: { characters: [...], locations: [...] }
  const containerKeys = Object.keys(obj).filter((k) => Array.isArray(obj[k]) && normalizeKind(k));
  if (containerKeys.length && !obj.title && !obj.name && !obj.content) {
    return containerKeys.flatMap((k) => {
      const kind = normalizeKind(k) || fallbackKind;
      return (obj[k] as unknown[]).flatMap((item, i) => jsonEntriesFromValue(item, kind, `${k} ${i + 1}`));
    });
  }
  // A wrapper object: { entries: [...] } / { items: [...] }
  for (const wrapper of ['entries', 'items', 'data', 'results']) {
    if (Array.isArray(obj[wrapper])) {
      return (obj[wrapper] as unknown[]).flatMap((item, i) => jsonEntriesFromValue(item, fallbackKind, `${fallbackTitle} ${i + 1}`));
    }
  }

  const title = obj.title ?? obj.name ?? obj.heading ?? obj.label ?? obj.judul;
  const content = obj.content ?? obj.description ?? obj.summary ?? obj.text ?? obj.body ?? obj.bio ?? obj.notes ?? obj.isi;
  if (title == null && content == null) return [];
  const kind = normalizeKind(obj.kind ?? obj.type ?? obj.category ?? obj.tipe ?? obj.kategori) || fallbackKind;
  const t = cleanTitle(title, fallbackTitle);
  // Character sheets often carry structured extras (want/flaw/secret). Keep
  // them instead of silently dropping everything except the description.
  const coreKeys = ['title', 'name', 'heading', 'label', 'judul', 'kind', 'type', 'category', 'tipe', 'kategori', 'content', 'description', 'summary', 'text', 'body', 'bio', 'notes', 'isi', 'tags', 'labels', 'tag'];
  const extras = Object.entries(obj)
    .filter(([k, v]) => !coreKeys.includes(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim())
    .map(([k, v]) => `- **${k}**: ${String(v).trim()}`)
    .join('\n');
  const c = clampContent([content != null ? String(content) : '', extras].filter(Boolean).join('\n\n'));
  if (!t || !c) return [];
  return [{ kind, title: t, content: c, tags: cleanTags(obj.tags ?? obj.labels ?? obj.tag) }];
}

export function parseJsonEntries(text: string, fallbackKind: StoryKind, fallbackTitle: string): ParsedEntry[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  return jsonEntriesFromValue(parsed, fallbackKind, fallbackTitle);
}

// ------------------------------------------------------------------ public --

function stem(name: string): string {
  return String(name || 'Imported file').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported file';
}

/** Parse one file into zero or more story-bible entries. */
export function parseStoryFile(file: SourceFile, fallbackKind: StoryKind = 'lore'): ImportResult {
  const name = file?.name || 'file';
  const text = String(file?.content ?? '');
  const ext = (/\.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();
  const kind = normalizeKind(fallbackKind) || guessKindFromName(name) || 'lore';
  const base = stem(name);
  const warnings: string[] = [];
  if (!text.trim()) return { entries: [], warnings: [`${name}: the file is empty.`] };

  let entries: ParsedEntry[] = [];
  if (ext === 'json') {
    entries = parseJsonEntries(text, kind, base);
    if (!entries.length) warnings.push(`${name}: no entries found — expected a JSON array or object with title/content.`);
  } else if (ext === 'csv' || ext === 'tsv') {
    entries = parseCsvEntries(text, kind, base);
    if (!entries.length) warnings.push(`${name}: no rows found. Add a "title" and a "content" column.`);
  } else if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'text' || ext === 'fountain' || ext === 'log' || !ext) {
    const sections = parseMarkdownSections(text, base);
    if (sections.length > 1) {
      entries = sections.map((s) => ({
        kind: normalizeKind(s.title) || kind,
        title: cleanTitle(s.title, base),
        content: clampContent(s.content),
        tags: []
      }));
    } else {
      entries = [{ kind, title: cleanTitle(base, 'Imported notes'), content: clampContent(text), tags: [] }];
    }
  } else {
    warnings.push(`${name}: unsupported file type (.${ext}) — import as .md, .txt, .json or .csv.`);
  }

  // A deliberately imprecise split (e.g. every ## in a prose manuscript) is
  // clamped so one huge file cannot flood the bible or freeze the UI.
  if (entries.length > MAX_ENTRIES_PER_FILE) {
    warnings.push(`${name}: only the first ${MAX_ENTRIES_PER_FILE} of ${entries.length} entries were imported.`);
    entries = entries.slice(0, MAX_ENTRIES_PER_FILE);
  }
  entries = entries.filter((e) => e.title.trim() && e.content.trim());
  return { entries, warnings };
}

/** Parse a batch of files, de-duplicating identical titles inside the batch. */
export function parseStoryFiles(files: SourceFile[], fallbackKind: StoryKind = 'lore'): ImportResult {
  const entries: ParsedEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const res = parseStoryFile(file, fallbackKind);
    warnings.push(...res.warnings);
    for (const e of res.entries) {
      const key = `${e.kind}\u0000${e.title.toLowerCase()}`;
      if (seen.has(key)) {
        warnings.push(`${file.name}: skipped duplicate "${e.title}".`);
        continue;
      }
      if (entries.length >= MAX_ENTRIES_TOTAL) {
        warnings.push(`Import stopped at ${MAX_ENTRIES_TOTAL} entries.`);
        return { entries, warnings };
      }
      seen.add(key);
      entries.push(e);
    }
  }
  return { entries, warnings };
}
