import * as fs from 'fs';
import * as path from 'path';

/**
 * Portable library export (v1.3.0).
 *
 * The database copy itself comes from db.ts. This module owns the filesystem
 * part so it can be tested without Electron: a friendly dated name, a refusal
 * to overwrite the live library, and an all-or-nothing write.
 */

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `openplot.db` → `openplot-portable-2026-11-11.db`, host characters removed. */
export function portableFileName(dbFile: string, now = new Date()): string {
  const stem = path.basename(dbFile, path.extname(dbFile)) || 'openplot';
  const safe = stem
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'openplot';
  return `${safe}-portable-${stamp(now)}.db`;
}

function samePath(a: string, b: string): boolean {
  // Windows and the default macOS filesystems are case-insensitive; Linux is
  // not. Compare the way the filesystem would, so `OPENPLOT.DB` cannot slip
  // past the live-file guard on Windows.
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Resolve the chosen save path, adding `.db`, and refuse the open library. */
export function portableTarget(requested: string, dbFile: string): string {
  const target = path.resolve(path.extname(requested) ? requested : `${requested}.db`);
  if (samePath(target, path.resolve(dbFile))) {
    throw new Error('That is the open library. Pick a different file for the export.');
  }
  // A symlink or hard link can reach the same file under another name. The
  // save dialog only offers to overwrite an existing file, so stat it too.
  try {
    const live = fs.statSync(dbFile);
    const chosen = fs.statSync(target);
    if (live.dev === chosen.dev && live.ino === chosen.ino) {
      throw new Error('That is the open library. Pick a different file for the export.');
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return target;
    throw err;
  }
  return target;
}

/** Stage beside the target, then replace in one step; a partial file never passes. */
export function writePortableCopy(target: string, data: Buffer): void {
  const tmp = `${target}.part`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch {
    fs.writeFileSync(target, data);
    try { fs.unlinkSync(tmp); } catch { /* already moved or absent */ }
  }
}
