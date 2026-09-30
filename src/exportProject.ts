/**
 * Project export — the whole project as ONE human-readable Markdown file:
 * metadata, story bible (grouped by kind), Story Flow outline and every
 * chapter in reading order. No AI involved; runs fully in the renderer and
 * then reuses the existing `exportMarkdown` IPC (native save dialog).
 *
 * Deliberately plain Markdown (no HTML) so the file is diff-friendly and
 * can be pasted anywhere — including back into the app or into a chat.
 */

import { Project, StoryEntry, Chapter, FlowBeat } from './types';
import { useSettings } from './store';

const KINDS: Array<StoryEntry['kind']> = ['world', 'location', 'character', 'item', 'lore'];

export interface ExportProjectResult {
  name: string;
  markdown: string;
  stats: { entries: number; beats: number; chapters: number; words: number };
}

export function buildProjectMarkdown(
  project: Project,
  story: StoryEntry[],
  chapters: Chapter[],
  beats: FlowBeat[]
): ExportProjectResult {
  const wordCount = (s: string) => (String(s).trim().match(/\S+/g) || []).length;

  const projStory = story
    .filter((e) => e.project_id === project.id)
    .sort((a, b) => a.title.localeCompare(b.title));
  const projChapters = chapters
    .filter((c) => c.project_id === project.id)
    .sort((a, b) => a.position - b.position);
  const projBeats = beats
    .filter((b) => b.project_id === project.id)
    .sort((a, b) => a.act - b.act || a.position - b.position);

  const L: string[] = [];
  const safeTags = (raw: string | null | undefined): string[] => {
    try {
      const v = JSON.parse(raw || '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };

  // ---- header / metadata ----
  L.push(`# ${project.name}`, '');
  if (project.description?.trim()) L.push(`> ${project.description.trim()}`, '');
  const meta: string[] = [];
  if (project.format) meta.push(`**Format:** ${project.format}`);
  if (project.rating) meta.push(`**Rating:** ${project.rating}`);
  meta.push(`**Exported:** ${new Date().toLocaleDateString()}`);
  L.push(...meta, '');
  if (project.context?.trim()) {
    L.push('## Context', '', project.context.trim(), '');
  }

  // ---- story bible ----
  if (projStory.length) {
    L.push('---', '', '# Story Bible', '');
    for (const kind of KINDS) {
      const entries = projStory.filter((e) => e.kind === kind);
      if (!entries.length) continue;
      L.push(`## ${kind.charAt(0).toUpperCase() + kind.slice(1)}s`, '');
      for (const e of entries) {
        L.push(`### ${e.title}`, '');
        const tags = safeTags(e.tags);
        if (tags.length) L.push(`*Tags: ${tags.join(', ')}*`, '');
        if (e.content?.trim()) L.push(e.content.trim(), '');
      }
    }
  }

  // ---- story flow (outline) ----
  if (projBeats.length) {
    L.push('---', '', '# Story Flow', '');
    for (const act of [1, 2, 3] as const) {
      const list = projBeats.filter((b) => b.act === act);
      if (!list.length) continue;
      L.push(`## Act ${act}`, '');
      for (const b of list) {
        L.push(`- **${b.title}** (${b.status})${b.summary ? ` — ${b.summary}` : ''}`);
      }
      L.push('');
    }
  }

  // ---- chapters ----
  const totalWords = projChapters.reduce((a, c) => a + wordCount(c.content), 0);
  if (projChapters.length) {
    L.push('---', '', '# Chapters', '', `*${projChapters.length} chapters · ${totalWords.toLocaleString()} words*`, '');
    projChapters.forEach((c, i) => {
      L.push(`## ${i + 1}. ${c.title}`, '', `*Status: ${c.status} · ${wordCount(c.content).toLocaleString()} words*`, '');
      if (c.content.trim()) L.push(c.content.trim(), '');
    });
  }

  return {
    name: project.name,
    markdown: L.join('\n'),
    stats: {
      entries: projStory.length,
      beats: projBeats.length,
      chapters: projChapters.length,
      words: totalWords
    }
  };
}

/**
 * Plain-text manuscript — what manuscript submissions traditionally expect:
 * title page, then chapters as "Chapter N — title" with blank-line spacing.
 * No markup at all, so it survives any editor/processor untouched.
 */
export function buildProjectTxt(project: Project, chapters: Chapter[]): { name: string; text: string; chapters: number; words: number } {
  const wordCount = (s: string) => (String(s).trim().match(/\S+/g) || []).length;
  const projChapters = chapters
    .filter((c) => c.project_id === project.id)
    .sort((a, b) => a.position - b.position);
  const totalWords = projChapters.reduce((a, c) => a + wordCount(c.content), 0);

  const L: string[] = [];
  L.push(project.name.toUpperCase());
  if (project.description?.trim()) L.push('', project.description.trim());
  L.push('', `Exported ${new Date().toLocaleDateString()} — ${projChapters.length} chapters, ${totalWords.toLocaleString()} words`);
  for (const c of projChapters) {
    L.push('', '', ''.padEnd(48, '='), `CHAPTER ${projChapters.indexOf(c) + 1}: ${c.title}`.toUpperCase(), ''.padEnd(48, '='), '');
    if (c.content.trim()) L.push(c.content.replace(/\r\n/g, '\n').trim());
  }
  return { name: project.name, text: L.join('\n'), chapters: projChapters.length, words: totalWords };
}

// ---------- unified export entry ----------

export type ExportFormat = 'md' | 'txt' | 'epub';

/**
 * One funnel for every export path: builds the payload for `fmt` and hands it
 * to the right IPC. Returns false when the user cancelled the save dialog.
 */
export async function exportProjectAs(
  fmt: ExportFormat,
  project: Project,
  story: StoryEntry[],
  chapters: Chapter[],
  beats: FlowBeat[]
): Promise<{ ok: boolean; cancelled: boolean; chapters: number; words: number; entries: number; beats: number }> {
  const md = buildProjectMarkdown(project, story, chapters, beats);
  let res: { ok: boolean; error?: string };
  if (fmt === 'txt') {
    const txt = buildProjectTxt(project, chapters);
    res = await window.inkwell.exportFile(`${project.name}.txt`, txt.text, 'txt');
    return { ok: res.ok, cancelled: res.error === 'cancelled', chapters: txt.chapters, words: txt.words, entries: 0, beats: 0 };
  }
  if (fmt === 'epub') {
    // Story bible + project context ride along as an appendix on the last
    // chapter — non-destructive, keeps the spine purely chronological.
    const projChapters = chapters.filter((c) => c.project_id === project.id).sort((a, b) => a.position - b.position);
    const words = projChapters.reduce((a, c) => a + (c.content.trim().match(/\S+/g) || []).length, 0);
    const front = [project.description?.trim() || '', project.context?.trim() || ''].filter(Boolean).join('\n\n');
    const bibleIdx = md.markdown.indexOf('# Story Bible');
    const appendix = [front, bibleIdx >= 0 ? md.markdown.slice(bibleIdx) : ''].filter(Boolean).join('\n\n---\n\n');
    const epubChapters = projChapters.map((c, i) => ({
      title: c.title || `Chapter ${i + 1}`,
      content: (c.content || '').trim() + (i === projChapters.length - 1 && appendix ? `\n\n${appendix}` : '')
    }));
    // Main process assembles the ZIP (zlib) and shows the native save dialog.
    // The author name comes from Settings → Chat Behavior (falls back to
    // 'Unknown Author'); the language tag mirrors the UI language.
    const author = useSettings.getState().authorName?.trim() || 'Unknown Author';
    const lang = useSettings.getState().lang === 'id' ? 'id' : 'en';
    res = await window.inkwell.exportEpub(`${project.name}.epub`, author, epubChapters, lang);
    return { ok: res.ok, cancelled: res.error === 'cancelled', chapters: projChapters.length, words, entries: 0, beats: 0 };
  }
  res = await window.inkwell.exportMarkdown(`${project.name}.md`, md.markdown);
  return { ok: res.ok, cancelled: res.error === 'cancelled', chapters: md.stats.chapters, words: md.stats.words, entries: md.stats.entries, beats: md.stats.beats };
}
