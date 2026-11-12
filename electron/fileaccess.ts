/**
 * File access for the renderer — grant based.
 *
 * `files:read` used to accept any path the renderer named. With rendered model
 * output in the same renderer, a single XSS could read `~/.ssh/id_rsa` and hand
 * it to a provider. Access now works like a capability:
 *
 *  - the main process grants the results of ITS OWN open dialog (trusted),
 *  - a dropped file is granted explicitly by the renderer, for that exact path,
 *    for 30 minutes (a drop is a user gesture; the window is what keeps a
 *    forgotten grant from lasting forever),
 *  - secret-shaped paths, key material and credential stores are refused even
 *    when granted — no chat attachment needs them,
 *  - the app's own data directory is refused even when granted: the database
 *    holds every chat, the story bible and the encrypted provider keys, and no
 *    attachment has a reason to read it back as text.
 *
 * Reads stay bounded: 40 paths per call, 2 MB per file, binary files skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

const GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_FILES = 40;
const MAX_BYTES = 2_000_000;
const DEFAULT_BYTES = 300_000;
const MAX_PATH_LENGTH = 4096;

/** normalized path → expiry timestamp */
const GRANTS = new Map<string, number>();

/** Directories this app owns. Nothing reachable from the renderer may read
 *  them through files:read, regardless of grants. */
const PRIVATE_ROOTS = new Set<string>();

export function setPrivateRoot(dir: string): void {
  const p = String(dir || '').trim();
  if (!p) return;
  PRIVATE_ROOTS.add(normalizePath(p));
  // The profile directory itself can be reached through a symlink/junction;
  // refuse both the spelling and the real target.
  try { PRIVATE_ROOTS.add(normalizePath(fs.realpathSync.native(p))); } catch { /* not created yet */ }
}

function isInsidePrivateRoot(input: string): boolean {
  const p = normalizePath(input);
  for (const root of PRIVATE_ROOTS) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (p === root || p.startsWith(prefix)) return true;
  }
  return false;
}

export function normalizePath(input: string): string {
  const resolved = path.resolve(String(input || ''));
  // Windows and the default macOS volume are case-insensitive, so casing must
  // not be able to smuggle a path past a grant or a private-root check.
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Resolve a path to its real target when it exists; otherwise keep the lexical path. */
function canonicalPath(input: string): string {
  try {
    return normalizePath(fs.realpathSync.native(input));
  } catch {
    return normalizePath(input);
  }
}

/** Record the paths the user just picked/dropped. Returns how many are live. */
export function grantPaths(paths: unknown): number {
  if (!Array.isArray(paths)) return GRANTS.size;
  const now = Date.now();
  for (const raw of paths.slice(0, MAX_FILES)) {
    const p = String(raw || '').trim();
    if (!p) continue;
    try { GRANTS.set(normalizePath(p), now + GRANT_TTL_MS); } catch { /* unusable path */ }
  }
  return GRANTS.size;
}

export function isGranted(input: string): boolean {
  const key = normalizePath(input);
  const expiry = GRANTS.get(key);
  if (expiry === undefined) return false;
  if (expiry < Date.now()) { GRANTS.delete(key); return false; }
  return true;
}

/** Test helper: forget every grant. */
export function clearGrants(): void { GRANTS.clear(); }

const SECRET_SEGMENTS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.azure', '.terraform.d', 'gcloud',
  '.password-store', '.docker', 'cookies', 'login data', 'local state', 'keychain'
];
const SECRET_FILES = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.git-credentials|\.netrc|\.pgpass|\.boto|\.s3cfg|\.vault-token|\.htpasswd|\.my\.cnf|credentials(\.json)?|wallet\.dat|ntds\.dit|(openplot|inkwell|sec)\.db(-wal|-shm)?)$/i;
const SECRET_EXT = /\.(pem|key|pfx|p12|der|jks|keystore|kdbx|keychain|ppk|ovpn)$/i;

/** True for paths that look like secrets: refused even when granted. */
export function isSensitivePath(input: string): boolean {
  const p = String(input || '').replace(/\\/g, '/');
  const segments = p.toLowerCase().split('/');
  if (segments.some((s) => SECRET_SEGMENTS.includes(s))) return true;
  const base = segments[segments.length - 1] || '';
  if (SECRET_FILES.test(base)) return true;
  if (SECRET_EXT.test(base)) return true;
  return false;
}

export type ReadVerdict = { ok: true; path: string } | { ok: false; error: string };

/** Why a path may or may not be read. Exported so the tests can assert reasons. */
export function checkReadable(input: string, opts: { granted?: boolean } = {}): ReadVerdict {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty path' };
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, error: 'path too long' };
  if (isSensitivePath(raw)) return { ok: false, error: 'sensitive path' };
  if (isInsidePrivateRoot(raw)) return { ok: false, error: 'private path' };
  // Check the real target too: a harmless-looking symlink must not become a
  // grant to ~/.ssh or the app's own database.
  const target = canonicalPath(raw);
  if (isSensitivePath(target)) return { ok: false, error: 'sensitive path' };
  if (isInsidePrivateRoot(target)) return { ok: false, error: 'private path' };
  const granted = opts.granted ?? (isGranted(raw) || isGranted(target));
  if (!granted) return { ok: false, error: 'not granted' };
  return { ok: true, path: target };
}

export interface ReadRow { name: string; content: string; size: number }

/** The only way the renderer gets file text. Never throws; skips counters. */
export function readTextFiles(paths: unknown, maxBytes?: number): ReadRow[] {
  const cap = Math.min(MAX_BYTES, Math.max(1_000, Number(maxBytes) || DEFAULT_BYTES));
  const list = Array.isArray(paths) ? paths.slice(0, MAX_FILES) : [];
  const out: ReadRow[] = [];
  for (const raw of list) {
    const verdict = checkReadable(String(raw ?? ''));
    if (!verdict.ok) continue;
    let fd: number | null = null;
    try {
      // Open the resolved target, not the user-supplied spelling, and refuse a
      // symlink swapped in after the check (O_NOFOLLOW is 0 on platforms that
      // do not support it; Windows reparse points are already resolved above).
      const noFollow = (fs.constants as any).O_NOFOLLOW || 0;
      fd = fs.openSync(verdict.path, fs.constants.O_RDONLY | noFollow);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > cap) continue;
      const buf = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < st.size) {
        const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
        if (!n) break;
        offset += n;
      }
      const body = buf.subarray(0, offset);
      // NUL bytes mean binary (images, archives, office zips): importing those
      // as UTF-8 would only produce garbage.
      if (body.subarray(0, 256).includes(0)) continue;
      out.push({ name: path.basename(verdict.path), content: body.toString('utf8'), size: offset });
    } catch { /* unreadable file — skip */ } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }
  return out;
}
