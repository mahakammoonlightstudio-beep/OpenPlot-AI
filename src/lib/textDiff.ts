/**
 * Word-level diff for the Writing AI preview.
 *
 * The preview has to stay responsive while prose is ~1–5k words, so the exact
 * LCS path is bounded: past MAX_TOKENS (or MAX_CELLS) it degrades to a common
 * prefix/suffix diff, which is still accurate for the usual "rewrite one
 * paragraph" case and never allocates an unbounded DP table.
 */
export type DiffKind = 'same' | 'add' | 'del';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

const MAX_TOKENS = 1100;
const MAX_CELLS = 700_000;

function tokenize(text: string): string[] {
  return String(text || '').match(/\s+|[^\s]+/g) || [];
}

function push(parts: DiffPart[], kind: DiffKind, text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

function prefixSuffix(a: string[], b: string[]): DiffPart[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const parts: DiffPart[] = [];
  push(parts, 'same', a.slice(0, start).join(''));
  push(parts, 'del', a.slice(start, endA).join(''));
  push(parts, 'add', b.slice(start, endB).join(''));
  push(parts, 'same', a.slice(endA).join(''));
  return parts;
}

export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  if (!a.length) return b.length ? [{ kind: 'add', text: after }] : [];
  if (!b.length) return [{ kind: 'del', text: before }];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS || a.length * b.length > MAX_CELLS) {
    return prefixSuffix(a, b);
  }

  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(parts, 'same', a[i]); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { push(parts, 'del', a[i]); i++; }
    else { push(parts, 'add', b[j]); j++; }
  }
  while (i < a.length) { push(parts, 'del', a[i]); i++; }
  while (j < b.length) { push(parts, 'add', b[j]); j++; }
  return parts;
}

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** Added/removed WORD counts — what the writer sees next to the preview. */
export function diffCounts(parts: DiffPart[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.kind === 'add') added += words(p.text);
    else if (p.kind === 'del') removed += words(p.text);
  }
  return { added, removed };
}
