/**
 * Web tools for agent mode: read one page (`web_fetch`) and search the web
 * (`web_search`).
 *
 * Both run in the MAIN process, so the user's search key never reaches the
 * renderer. `web_fetch` needs no key at all; `web_search` uses a
 * bring-your-own key (Exa by default, Serper or Brave optional) saved in
 * Settings → Chat Behavior.
 *
 * Responses are bounded: a 2 MB download cap and a 20k character text cap keep
 * one page from eating the whole context window.
 */
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { handleDb, settingSecret } from './db';

const USER_AGENT = 'OpenPlotAI/1.3.0 (+local web research; no crawler)';
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 20_000;
const REQUEST_MS = 20_000;
const MAX_REDIRECTS = 3;

/**
 * Test-only escape hatch: the harnesses exercise `web_fetch` against a loopback
 * mock server. It is read ONCE at module load and only the test runner sets it,
 * so a model cannot flip it at runtime and the shipped app never enables it.
 */
const ALLOW_LOCAL_FETCH = process.env.OPENPLOT_WEB_ALLOW_LOCAL === '1';

export type WebProvider = 'exa' | 'serper' | 'brave';

export const WEB_PROVIDER_ENDPOINTS: Record<WebProvider, string> = {
  exa: 'https://api.exa.ai/search',
  serper: 'https://google.serper.dev/search',
  brave: 'https://api.search.brave.com/res/v1/web/search'
};

interface FetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  /** The body was cut at MAX_BYTES (huge page, binary stream). */
  capped: boolean;
}

function errorJson(message: string): string {
  return JSON.stringify({ error: message });
}

function readSettings(): Record<string, string> {
  try {
    return (handleDb('getAllSettings', {}) || {}) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Settings are JSON-encoded strings; accept both shapes. */
function readSetting(key: string, fallback = ''): string {
  // The web-search key is sealed in the settings table; decrypt it only here
  // rather than asking a generic reader for ciphertext.
  if (key === 'webSearchApiKey') {
    const secret = settingSecret(key);
    return secret || fallback;
  }
  const raw = readSettings()[key];
  if (raw == null || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return raw;
  }
}

/**
 * Address guard for `web_fetch`.
 *
 * The URL is chosen by the model, so it must not become a doorway into the
 * machine running the app. Loopback, private ranges, CGNAT, link-local
 * metadata (169.254.169.254) and their IPv6 equivalents are refused, and
 * every redirect goes through `request()` again — so a public URL cannot
 * bounce to 127.0.0.1.
 *
 * Hostname spellings are decoded here because `new URL` keeps them raw:
 *   http://2130706433/   decimal IPv4
 *   http://0x7f000001/   hex IPv4
 *   http://127.1/        inet_aton shorthand
 *   http://localhost./   trailing dot
 * Anything numeric that is not a canonical dotted quad is refused outright:
 * we cannot tell where it points, so we do not follow it.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|home\.arpa|lan|localdomain)$/.test(host)) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isBlockedHost(mapped[1]);
    // Some resolvers render an IPv4-mapped address as two hex groups.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isBlockedHost([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;   // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;    // fe80::/10 link-local
    return false;
  }
  // A single-label host ("server", "nas", "router") resolves through the local
  // search domain, which is exactly the intranet `web_fetch` must not reach.
  // Public pages always carry a dot.
  if (!host.includes('.') && !/^[0-9a-fx.]+$/.test(host)) return true;
  if (/^[0-9a-fx.]+$/.test(host)) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return true;
    const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if ([a, b, c, d].some((n) => n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;             // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;                           // multicast + reserved
  }
  return false;
}

/**
 * DNS lookup used for every outbound web request.
 *
 * Checking only the hostname is not enough: a public name can resolve to
 * 127.0.0.1 or 169.254.169.254 (DNS rebinding). This lookup rejects any answer
 * in a private range and returns the exact addresses the socket will use, so
 * the check and the connection cannot disagree.
 */
export function publicLookup(
  hostname: string,
  options: any,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = (addresses || []) as Array<{ address: string; family: number }>;
    if (!list.length) return callback(new Error('That host could not be resolved.'));
    const blocked = list.find((entry) => isBlockedHost(entry.address));
    if (blocked) {
      return callback(new Error('That host resolves to your own machine or local network.'));
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  redirects = MAX_REDIRECTS
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('That is not a valid URL.'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Only http:// and https:// pages can be fetched.'));
      return;
    }
    // Redirects recurse into this function, so each hop is checked too.
    if (!ALLOW_LOCAL_FETCH && isBlockedHost(parsed.hostname)) {
      reject(new Error('That address is on your own machine or local network. web_fetch only reads public web pages.'));
      return;
    }
    let settled = false;
    const done = (fn: (v: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const mod: typeof http | typeof https = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: init.method || 'GET',
        // Pin the socket to the same public answers that were just checked.
        ...(ALLOW_LOCAL_FETCH ? {} : { lookup: publicLookup as any }),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'en,id;q=0.8',
          ...(init.headers || {})
        }
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          let next = String(location);
          try { next = new URL(String(location), parsed).toString(); } catch { /* keep raw */ }
          request(next, init, redirects - 1).then(
            (r) => done(resolve, r),
            (e) => done(reject, e)
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let capped = false;
        res.on('data', (chunk: Buffer) => {
          if (capped) return;
          const room = MAX_BYTES - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            size = MAX_BYTES;
            capped = true;
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => done(resolve, {
          status,
          finalUrl: parsed.toString(),
          contentType: String(res.headers['content-type'] || ''),
          body: Buffer.concat(chunks).toString('utf8'),
          capped
        }));
        res.on('error', (e) => done(reject, e));
      }
    );
    req.on('error', (e) => done(reject, e));
    req.setTimeout(REQUEST_MS, () => {
      req.destroy(new Error('The site did not respond in time.'));
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…'
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.charAt(0) === '#') {
      const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const spaced = stripped
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(spaced)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `web_fetch`: read one URL and return readable text. Never throws. */
export async function runWebFetch(input: any = {}): Promise<string> {
  const raw = String(input.url || '').trim();
  if (!raw) return errorJson('web_fetch needs a url.');
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const res = await request(url, {});
    if (res.status >= 400) return errorJson(`The page returned HTTP ${res.status}.`);
    const isJson = /json/i.test(res.contentType);
    const title = isJson ? '' : titleOf(res.body);
    const text = isJson ? res.body : htmlToText(res.body);
    const clipped = text.length > MAX_TEXT;
    return JSON.stringify({
      ok: true,
      url: res.finalUrl,
      title,
      contentType: res.contentType,
      chars: text.length,
      truncated: clipped || res.capped,
      text: clipped ? text.slice(0, MAX_TEXT) : text,
      ...(clipped ? { note: `Only the first ${MAX_TEXT.toLocaleString('en-US')} characters are shown.` } : {})
    });
  } catch (e: any) {
    return errorJson(e?.message || String(e));
  }
}

function clampResults(n: any, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(10, Math.max(1, Math.round(v)));
}

const trim = (s: any, max = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

/** `web_search`: one provider call, mapped to { title, url, snippet }. */
export async function runWebSearch(input: any = {}): Promise<string> {
  const query = String(input.query || '').trim();
  if (!query) return errorJson('web_search needs a query.');
  const providerRaw = readSetting('webSearchProvider', 'exa');
  const provider: WebProvider = providerRaw === 'serper' || providerRaw === 'brave' ? providerRaw : 'exa';
  const key = readSetting('webSearchApiKey', '').trim();
  if (!key) {
    return errorJson(
      'No web search key yet. Add one in Settings → Chat Behavior → Web research (Exa, Serper or Brave). ' +
      'web_fetch still works without a key.'
    );
  }
  const defaultLimit = clampResults(readSetting('webSearchResults', '5'), 5);
  const limit = clampResults(input.limit, defaultLimit);
  // Overridable so self-hosted gateways (and the test suite) can point at their
  // own endpoint; the shipped default is the provider's public API.
  const endpoint = readSetting('webSearchBaseUrl', '').trim() || WEB_PROVIDER_ENDPOINTS[provider];

  try {
    let results: Array<{ title: string; url: string; snippet: string }> = [];
    if (provider === 'exa') {
      const res = await request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ query, numResults: limit, contents: { highlights: { numSentences: 2 } } })
      });
      if (res.status >= 400) return errorJson(`Web search failed (HTTP ${res.status}). ${trim(res.body, 200)}`);
      const data = safeJson(res.body);
      results = (Array.isArray(data?.results) ? data.results : []).slice(0, limit).map((r: any) => ({
        title: trim(r.title, 160),
        url: trim(r.url, 500),
        snippet: trim(Array.isArray(r.highlights) ? r.highlights[0] : (r.summary || r.text), 300)
      }));
    } else if (provider === 'brave') {
      const url = endpoint + (endpoint.includes('?') ? '&' : '?') +
        'q=' + encodeURIComponent(query) + '&count=' + limit;
      const res = await request(url, {
        headers: { 'x-subscription-token': key, accept: 'application/json' }
      });
      if (res.status >= 400) return errorJson(`Web search failed (HTTP ${res.status}). ${trim(res.body, 200)}`);
      const data = safeJson(res.body);
      const rows = data?.web?.results;
      results = (Array.isArray(rows) ? rows : []).slice(0, limit).map((r: any) => ({
        title: trim(r.title, 160),
        url: trim(r.url, 500),
        snippet: trim(r.description, 300)
      }));
    } else {
      const res = await request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ q: query, num: limit })
      });
      if (res.status >= 400) return errorJson(`Web search failed (HTTP ${res.status}). ${trim(res.body, 200)}`);
      const data = safeJson(res.body);
      const rows = data?.organic;
      results = (Array.isArray(rows) ? rows : []).slice(0, limit).map((r: any) => ({
        title: trim(r.title, 160),
        url: trim(r.link, 500),
        snippet: trim(r.snippet, 300)
      }));
    }
    results = results.filter((r) => r.url);
    return JSON.stringify({
      ok: true,
      provider,
      query,
      results,
      ...(results.length ? {} : { note: 'The provider returned no results. Try different words.' })
    });
  } catch (e: any) {
    return errorJson(e?.message || String(e));
  }
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}
