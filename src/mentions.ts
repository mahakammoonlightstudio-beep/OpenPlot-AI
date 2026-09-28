/**
 * @-mentions — reference story bible entries and chapters in the composer.
 *
 * Typing `@` opens a picker (fuzzy search over titles + kind); a chosen
 * candidate inserts a token like `@["Kael Ardent"]` (or `@[chapter:…]/`)
 * that stays human-readable in the composer. Before sending, tokens are
 * expanded to full content blocks so the model gets the real text, while
 * the chat transcript keeps the compact token.
 *
 * Deliberately plain-text (no markdown link syntax) so tokens survive
 * round-trips through edit/resend and are easy to type/delete.
 */

import { StoryEntry, Chapter } from './types';

export type MentionKind = 'story' | 'chapter';

export interface MentionCandidate {
  id: string;
  kind: MentionKind;
  /** story bible kind (world/location/…) for story entries */
  sub?: string;
  title: string;
  /** body sent to the model when expanded */
  content: string;
}

const TOKEN_RE = /@\["(story|chapter):([^\]"]+)"\]/g;

/** Build the mention token shown in the composer. */
export function mentionToken(c: MentionCandidate): string {
  return `@["${c.kind}:${c.title.replace(/"/g, "'")}"]`;
}

/** All mention tokens currently present in the text. */
export function findMentions(text: string): Array<{ kind: MentionKind; title: string }> {
  const out: Array<{ kind: MentionKind; title: string }> = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ kind: m[1] as MentionKind, title: m[2] });
  }
  return out;
}

/**
 * Expand every mention token into a full content block.
 * `resolve` receives (kind, title) and returns the referenced object (or
 * null when it was deleted since insertion — the token is left as-is then,
 * so nothing the user typed is silently lost).
 */
export async function expandMentions(
  text: string,
  resolve: (kind: MentionKind, title: string) => MentionCandidate | null
): Promise<string> {
  let expanded = text;
  for (const m of findMentions(text)) {
    const c = resolve(m.kind, m.title);
    if (!c) continue;
    const block =
      c.kind === 'chapter'
        ? `@chapter "${c.title}":\n"""\n${c.content}\n"""`
        : `@${c.sub || 'entry'} "${c.title}":\n"""\n${c.content}\n"""`;
    expanded = expanded.split(mentionToken(c)).join(block);
  }
  return expanded;
}

/** Build candidates from the store rows, newest first, capped per kind. */
export function buildCandidates(story: StoryEntry[], chapters: Chapter[], projectId?: string | null): MentionCandidate[] {
  const inProject = <T extends { project_id?: string | null }>(rows: T[]) =>
    (projectId ? rows.filter((r) => r.project_id === projectId) : rows);
  const storyCands: MentionCandidate[] = inProject(story)
    .slice()
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .map((e) => ({ id: e.id, kind: 'story' as const, sub: e.kind, title: e.title, content: e.content }));
  const chapterCands: MentionCandidate[] = inProject(chapters)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, kind: 'chapter' as const, title: c.title, content: c.content }));
  return [...storyCands, ...chapterCands];
}
