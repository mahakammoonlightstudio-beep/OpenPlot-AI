import crypto from 'node:crypto';

/**
 * Execution approvals for plugins and MCP servers.
 *
 * A plugin (JavaScript) or MCP server (a local command) runs only after the
 * user approved that exact payload. The stored value is a hash of the code or
 * the command, never the payload itself, so an approval stops matching as soon
 * as the code is edited — `listTrust` reports that as `stale` and the gate asks
 * again.
 *
 * This module is deliberately pure: the caller owns the map and persists it.
 * That keeps the rules testable from plain Node (`scripts/trust-test.mjs`)
 * without booting Electron, and leaves the database and the stop/reload side
 * effects in `main.ts` where they belong.
 */

export type ExecKind = 'plugin' | 'mcp';

/** `plugin:<id>` / `mcp:<id>` → hash of the approved payload. */
export type TrustedMap = Record<string, string>;

export interface TrustEntry {
  kind: ExecKind;
  id: string;
  label: string;
  /** The database row still exists. */
  present: boolean;
  /** The row exists but its code/command changed since the approval. */
  stale: boolean;
}

export interface PluginRow {
  id: string;
  name?: string;
  code?: string;
}

export interface McpRow {
  id: string;
  name?: string;
  command?: string;
  args?: string;
  env?: string;
}

/** Hash one exact payload; `kind` is part of it so ids cannot cross over. */
export function trustHash(kind: ExecKind, parts: Array<string | undefined | null>): string {
  return crypto.createHash('sha256')
    .update(kind + '\u0000' + parts.map((p) => String(p ?? '')).join('\u0000'))
    .digest('hex');
}

/** Parse the stored JSON defensively: junk, arrays and non-strings are dropped. */
export function parseTrust(raw: unknown): TrustedMap {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw) return {};
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: TrustedMap = {};
  for (const [key, hash] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hash === 'string' && hash) out[key] = hash;
  }
  return out;
}

export function isTrusted(trust: TrustedMap, kind: ExecKind, id: string, hash: string): boolean {
  return trust[`${kind}:${id}`] === hash;
}

/** Record an approval. Returns the same map so callers can persist it directly. */
export function remember(trust: TrustedMap, kind: ExecKind, id: string, hash: string): TrustedMap {
  trust[`${kind}:${id}`] = hash;
  return trust;
}

/** Drop one approval. Other kinds (and other ids) are untouched. */
export function revoke(trust: TrustedMap, kind: ExecKind, id: string): TrustedMap {
  delete trust[`${kind}:${id}`];
  return trust;
}

/**
 * Join the stored approvals with the rows they belong to.
 *
 * `stale` means the code changed after approval (it will ask again);
 * `present:false` means the row was deleted but its hash is still stored.
 */
export function listTrust(
  trust: TrustedMap,
  plugins: PluginRow[],
  servers: McpRow[]
): TrustEntry[] {
  const out: TrustEntry[] = [];
  for (const key of Object.keys(trust)) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const kind = key.slice(0, sep) as ExecKind;
    if (kind !== 'plugin' && kind !== 'mcp') continue;
    const id = key.slice(sep + 1);
    if (!id) continue;
    const row: PluginRow | McpRow | undefined = kind === 'plugin'
      ? plugins.find((r) => r.id === id)
      : servers.find((r) => r.id === id);
    const hash = row
      ? trustHash(kind, kind === 'plugin'
        ? [(row as PluginRow).code]
        : [(row as McpRow).command, (row as McpRow).args, (row as McpRow).env])
      : '';
    out.push({
      kind,
      id,
      label: row ? (row.name || (kind === 'mcp' ? ((row as McpRow).command || 'MCP') : 'plugin')) : id,
      present: !!row,
      stale: !!row && !!hash && trust[key] !== hash
    });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.label).localeCompare(String(b.label)));
}
