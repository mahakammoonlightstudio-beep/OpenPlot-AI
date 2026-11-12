import type { SkillRow } from '../types';
import { activeSkills, buildSkillsBlock, SKILLS_BLOCK_CHARS, type PromptSkill } from './prompt';

/**
 * Skill Lab (v1.3.0): what a skill actually adds to the system prompt, how
 * much room it takes, and which other active skills may be pulling in a
 * different direction. The preview uses the same block builder as the real
 * prompt, so the text cannot drift from what the model receives.
 */

export type SkillTensionTopic = 'length' | 'rewrite' | 'ask' | 'formality';

export interface SkillLabIssue {
  kind: 'duplicate' | 'overlap' | 'tension';
  id: string;
  name: string;
  /** Shared distinctive words for an overlap. */
  shared: string[];
  /** Set for a possible contradiction. */
  topic?: SkillTensionTopic;
}

export interface SkillLabResult {
  /** This skill's block, exactly as `buildSkillsBlock` emits it. */
  body: string;
  chars: number;
  tokens: number;
  activeCount: number;
  activeChars: number;
  activeTokens: number;
  budget: number;
  truncated: boolean;
  issues: SkillLabIssue[];
}

const STOP = new Set(`
a an and are as at be been before being between both but by can could did do does doing
for from had has have having he her here hers him his how i if in into is it its itself
just like may me might more most must my no nor not now of off on once only or other our
out over own same she should so some such than that the their them then there these they
this those through to too under until up very was we were what when where which while who
whom why will with would you your yours yourself
always never rewrite rewrites rewritten preserving preserve keep keeps keeping cut cuts
shorter longer concise expand expands detailed details detail formal casual informal
`.trim().split(/\s+/));

const TENSIONS: Array<{ topic: SkillTensionTopic; a: RegExp; b: RegExp }> = [
  {
    topic: 'length',
    a: /\b(?:concise|shorten|shorter|trim|tighten|cut)\b/i,
    b: /\b(?:expand|longer|elaborate|more detail|detailed)\b/i
  },
  {
    topic: 'rewrite',
    a: /\b(?:do not rewrite|never rewrite|don't rewrite|without rewriting|preserve)\b/i,
    b: /\b(?:rewrite|revise|replace)\b/i
  },
  {
    topic: 'ask',
    a: /\b(?:always ask|ask before|ask the user|one clarifying question)\b/i,
    b: /\b(?:never ask|do not ask|don't ask|without asking)\b/i
  },
  {
    topic: 'formality',
    a: /\bformal\b/i,
    b: /\b(?:casual|informal)\b/i
  }
];

/** The exact text `buildSkillsBlock` puts under this skill's heading. */
export function skillBlockBody(skill: SkillRow): string {
  const description = String(skill.description || '').trim();
  return `## ${skill.name}${description ? '\n' + description : ''}\n${String(skill.content || '').trim()}`;
}

function words(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .match(/[a-z][a-z'-]{3,}/g)
      ?.filter((w) => !STOP.has(w)) || []
  );
}

/** A conservative overlap: same distinctive vocabulary, not just "writing". */
function overlapOf(a: SkillRow, b: SkillRow): { shared: string[]; score: number } {
  const left = words(`${a.content} ${a.description || ''}`);
  const right = words(`${b.content} ${b.description || ''}`);
  const shared: string[] = [];
  for (const word of left) if (right.has(word)) shared.push(word);
  const union = new Set([...left, ...right]).size || 1;
  return { shared: shared.slice(0, 6), score: shared.length / union };
}

function tensionOf(a: SkillRow, b: SkillRow): SkillTensionTopic | null {
  const left = `${a.content} ${a.description || ''}`;
  const right = `${b.content} ${b.description || ''}`;
  for (const rule of TENSIONS) {
    if ((rule.a.test(left) && rule.b.test(right)) || (rule.b.test(left) && rule.a.test(right))) {
      return rule.topic;
    }
  }
  return null;
}

export function buildSkillLab(
  selected: SkillRow,
  allSkills: SkillRow[],
  opts: { skillsOn?: string[]; skillsOff?: string[] } = {}
): SkillLabResult {
  const active = activeSkills(
    allSkills as unknown as PromptSkill[],
    opts.skillsOff || [],
    opts.skillsOn || []
  ) as unknown as SkillRow[];
  const body = skillBlockBody(selected);
  const block = buildSkillsBlock(
    allSkills as unknown as PromptSkill[],
    opts.skillsOff || [],
    opts.skillsOn || []
  ) || '';
  const issues: SkillLabIssue[] = [];
  for (const peer of active) {
    if (peer.id === selected.id) continue;
    const own = String(selected.content || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const other = String(peer.content || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (own && own === other) {
      issues.push({ kind: 'duplicate', id: peer.id, name: peer.name, shared: [] });
      continue;
    }
    const topic = tensionOf(selected, peer);
    if (topic) {
      issues.push({ kind: 'tension', id: peer.id, name: peer.name, shared: [], topic });
      continue;
    }
    const overlap = overlapOf(selected, peer);
    if (overlap.shared.length >= 5 && overlap.score >= 0.25) {
      issues.push({ kind: 'overlap', id: peer.id, name: peer.name, shared: overlap.shared });
    }
  }
  return {
    body,
    chars: body.length,
    tokens: Math.ceil(body.length / 4),
    activeCount: active.length,
    activeChars: block.length,
    activeTokens: Math.ceil(block.length / 4),
    budget: SKILLS_BLOCK_CHARS,
    truncated: block.includes('[skill truncated'),
    issues: issues.slice(0, 6)
  };
}
