import * as fs from 'fs';
import * as path from 'path';

/**
 * Library Time Machine (v1.3.0).
 *
 * Snapshots are whole SQLite files, kept inside the profile so they travel
 * with the library and never sit somewhere a path-traversal bug could reach.
 * Each library gets its own folder: restoring a snapshot of "Trial 2.db" must
 * never overwrite "openplot.db", even though both live in the same profile.
 *
 * Names carry the timestamp and reason (`snap-<epoch>-<reason>.db`) so the
 * list needs no index file that can drift out of sync with the filesystem.
 */

export const SNAPSHOT_MAX = 12;
export const SNAPSHOT_ROOT = 'snapshots';

export interface SnapshotFile {
  name: string;
  reason: string;
  savedAt: number;
  bytes: number;
}

/** A filesystem-safe folder name for one library; never contains a slash. */
function libraryFolder(libraryName: string): string {
  const stem = path.basename(String(libraryName || 'library.db')).replace(/\.db$/i, '');
  return stem
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'library';
}

export function snapshotDirectory(dataDir: string, libraryName: string): string {
  return path.join(dataDir, SNAPSHOT_ROOT, libraryFolder(libraryName));
}

function reasonCode(reason: string): string {
  return String(reason || 'manual')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'manual';
}

function parseSnapshotName(name: string): { savedAt: number; reason: string } | null {
  const match = /^snap-(\d{10,})-(.+)\.db$/i.exec(name);
  if (!match) return null;
  const savedAt = Number(match[1]);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  return { savedAt, reason: match[2] };
}

/** Newest first. Invalid or half-written files are ignored, never listed. */
export function listSnapshotFiles(dataDir: string, libraryName: string): SnapshotFile[] {
  const dir = snapshotDirectory(dataDir, libraryName);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SnapshotFile[] = [];
  for (const name of names) {
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      out.push({ name, reason: parsed.reason, savedAt: parsed.savedAt, bytes: stat.size });
    } catch { /* removed while listing */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

function prune(dir: string, max: number): void {
  const keep = Math.max(1, Math.min(100, Number(max) || SNAPSHOT_MAX));
  const files: SnapshotFile[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const parsed = parseSnapshotName(name);
      if (!parsed) continue;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) files.push({ name, ...parsed, bytes: stat.size });
      } catch { /* removed while pruning */ }
    }
  } catch { return; }
  files.sort((a, b) => b.savedAt - a.savedAt);
  for (const old of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* already gone */ }
  }
}

function nextTarget(dir: string, baseMs: number, reason: string): { target: string; tmp: string } {
  for (let i = 0; i < 100; i++) {
    const name = `snap-${baseMs + i}-${reason}.db`;
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      return { target, tmp: path.join(dir, `.writing-${process.pid}-${baseMs}-${i}.tmp`) };
    }
  }
  throw new Error('Could not find a free snapshot filename.');
}

function finish(target: string, tmp: string, reason: string): SnapshotFile {
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  const stat = fs.statSync(target);
  const parsed = parseSnapshotName(path.basename(target));
  return {
    name: path.basename(target),
    reason: parsed?.reason || reason,
    savedAt: parsed?.savedAt || Date.now(),
    bytes: stat.size
  };
}

/** Write bytes already in memory (used before a migration, when the file on
 *  disk is still the old schema). */
export function writeSnapshotFile(
  dataDir: string,
  libraryName: string,
  data: Uint8Array,
  reason = 'manual',
  max = SNAPSHOT_MAX
): SnapshotFile {
  if (!data || !data.byteLength) throw new Error('Snapshot data is empty.');
  const dir = snapshotDirectory(dataDir, libraryName);
  fs.mkdirSync(dir, { recursive: true });
  const code = reasonCode(reason);
  const { target, tmp } = nextTarget(dir, Date.now(), code);
  fs.writeFileSync(tmp, data);
  const out = finish(target, tmp, code);
  prune(dir, max);
  return out;
}

/** Copy the active DB file into a snapshot without loading it twice in RAM. */
export function copySnapshotFile(
  dataDir: string,
  libraryName: string,
  sourceFile: string,
  reason = 'manual',
  max = SNAPSHOT_MAX
): SnapshotFile {
  if (!fs.existsSync(sourceFile)) throw new Error('The active library file does not exist.');
  const dir = snapshotDirectory(dataDir, libraryName);
  fs.mkdirSync(dir, { recursive: true });
  const code = reasonCode(reason);
  const { target, tmp } = nextTarget(dir, Date.now(), code);
  fs.copyFileSync(sourceFile, tmp);
  const out = finish(target, tmp, code);
  prune(dir, max);
  return out;
}

/** Resolve a listed name to a path inside this library's snapshot folder. */
export function snapshotFilePath(dataDir: string, libraryName: string, file: string): string {
  const raw = String(file || '');
  const name = path.basename(raw);
  if (!raw || name !== raw || !parseSnapshotName(name)) {
    throw new Error('Invalid snapshot name.');
  }
  const dir = snapshotDirectory(dataDir, libraryName);
  const full = path.join(dir, name);
  const rel = path.relative(dir, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid snapshot path.');
  }
  return full;
}
