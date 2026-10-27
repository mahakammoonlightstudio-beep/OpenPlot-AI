/**
 * Chat attachment helpers (v1.2.3).
 *
 * Files attached to a message are stored with that message and can be reopened
 * from the transcript. The model only ever sees a bounded excerpt: a single
 * huge file must not blow up the prompt (and the context guard) for the whole
 * chat.
 *
 * The byte caps mirror `electron/db.ts` — the main process re-checks them
 * because the renderer is not a trust boundary.
 */

export const MAX_CHAT_FILES = 8;
export const MAX_CHAT_FILE_BYTES = 256 * 1024;
export const MAX_CHAT_TOTAL_BYTES = 1024 * 1024;

/** Prompt budget: 16k chars per file, 48k chars for the whole attachment block. */
export const PROMPT_FILE_CHARS = 16_000;
export const PROMPT_TOTAL_CHARS = 48_000;

export interface AttachmentLike {
  name: string;
  kind: 'file' | 'story' | 'chapter';
  content: string;
  bytes?: number;
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** Stable thousands separators (toLocaleString depends on the OS locale). */
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** UTF-8 byte length — what the DB stores, not JS string length. */
export function utf8Bytes(s: string): number {
  if (encoder) return encoder.encode(s || '').length;
  return Buffer.byteLength(s || '', 'utf8');
}

export function attachmentBytes(a: AttachmentLike): number {
  return typeof a.bytes === 'number' && Number.isFinite(a.bytes) ? a.bytes : utf8Bytes(a.content);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the system-prompt section for the attachments of the NEXT message.
 * Returns null when there is nothing to attach. Truncation is announced in
 * the text itself so the model knows the excerpt is incomplete.
 */
export function buildAttachmentPrompt(attachments: AttachmentLike[]): string | null {
  if (!attachments.length) return null;
  const blocks: string[] = [];
  let budget = PROMPT_TOTAL_CHARS;
  for (const a of attachments) {
    if (budget <= 0) {
      blocks.push(`=== FILE: ${a.name} ===\n[omitted — the ${num(PROMPT_TOTAL_CHARS)}-character attachment budget for this message was already used]`);
      continue;
    }
    const limit = Math.min(PROMPT_FILE_CHARS, budget);
    const body = a.content.slice(0, limit);
    budget -= body.length;
    const truncated = a.content.length > body.length
      ? `\n[truncated: showing the first ${num(body.length)} of ${num(a.content.length)} characters]`
      : '';
    blocks.push(`=== FILE: ${a.name} ===\n${body}${truncated}`);
  }
  return `# Attached files (${attachments.length}) — user-provided context for this turn\n${blocks.join('\n\n')}`;
}
