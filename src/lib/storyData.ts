/**
 * Story-bible rows store `tags` and `links` in TEXT columns as JSON arrays.
 * Older rows — and anything a model wrote through the story tools before the
 * DB layer normalised them — can be a bare string, a JSON string, or an
 * object. The Story Bible view calls `.map()` on the parsed value, so one bad
 * row used to blank the whole screen with `e.map is not a function`.
 *
 * This helper always returns a string array, no matter what came out of the
 * database. (The main process normalises reads too; this is the last line of
 * defence for data restored from old backups or written by another build.)
 */
export function toStoryArray(raw: unknown): string[] {
  // Preserve real arrays exactly; only drop values that cannot be a tag.
  const clean = (items: unknown[]): string[] => items
    .filter((item) => item !== null && item !== undefined && typeof item !== 'object')
    .map((item) => String(item));
  const fromText = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean);

  if (Array.isArray(raw)) return clean(raw);
  if (typeof raw !== 'string') return [];

  const value = raw.trim();
  if (!value) return [];

  // JSON array (the normal shape) or a JSON string (a model sent a string and
  // JSON.stringify stored it as one quoted value).
  if (value.startsWith('[') || value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return clean(parsed);
      if (typeof parsed === 'string') return fromText(parsed);
    } catch { /* not JSON — fall through to comma splitting */ }
  }

  // A JSON object is not a tag list; never render it as one literal chip.
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return [];
    } catch { /* plain text */ }
  }

  // Legacy/plain text: "fantasy, politics".
  return fromText(value);
}
