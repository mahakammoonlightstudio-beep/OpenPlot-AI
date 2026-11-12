import * as http from 'http';
import * as https from 'https';
import { isBlockedHost, publicLookup } from './webtools';

/**
 * Remote Markdown images, fetched by the main process instead of the renderer.
 *
 * CSP allows `img-src 'self' data: blob:` and `connect-src 'none'`, so a
 * model-written `<img src="https://…">` can never make the trusted window talk
 * to a third party. The renderer asks this module for the bytes and swaps in a
 * `data:` URL. Only raster formats are proxied (an SVG can reference remote
 * resources of its own, which would turn this into a generic loader), private
 * and metadata hosts are refused, and the size is capped while the body is
 * still streaming — `arrayBuffer()` would buffer an unbounded response first.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon'
]);

interface ImageResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
  tooLarge: boolean;
}

/** http(s) only, no credentials, no loopback/private/metadata host. */
export function proxyImageUrl(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (isBlockedHost(url.hostname)) return null;
  return url;
}

/** Validate + encode an image response; pure so the caps are testable. */
export function imageDataUrl(contentType: string, buf: Buffer): { ok: boolean; data?: string; error?: string } {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!TYPES.has(type)) return { ok: false, error: 'not a supported image' };
  if (!buf || !buf.length) return { ok: false, error: 'empty' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'too large' };
  return { ok: true, data: `data:${type};base64,${buf.toString('base64')}` };
}

function getOnce(url: URL, timeoutMs: number): Promise<ImageResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const mod: typeof http | typeof https = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { accept: 'image/*' },
        // Check and pin DNS at connection time, not just the literal hostname.
        lookup: publicLookup as any
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers.location ? String(res.headers.location) : null;
        if (status >= 300 && status < 400) {
          res.resume();
          finish(resolve, { status, location, contentType: '', body: Buffer.alloc(0), tooLarge: false });
          return;
        }
        const contentType = String(res.headers['content-type'] || '');
        const declared = Number(res.headers['content-length'] || 0);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.resume();
          finish(resolve, { status, location: null, contentType, body: Buffer.alloc(0), tooLarge: true });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on('data', (chunk: Buffer) => {
          if (tooLarge) return;
          if (size + chunk.length > MAX_BYTES) {
            tooLarge = true;
            chunks.length = 0;
            // Stop the transfer now instead of continuing to read and discard.
            req.destroy();
            finish(resolve, { status, location: null, contentType, body: Buffer.alloc(0), tooLarge: true });
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => {
          if (tooLarge) return;
          finish(resolve, { status, location: null, contentType, body: Buffer.concat(chunks), tooLarge: false });
        });
        res.on('error', (err) => finish(reject, err));
      }
    );
    req.on('error', (err) => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('The image did not respond in time.'));
    });
    req.end();
  });
}

export async function fetchRemoteImage(raw: string): Promise<{ ok: boolean; data?: string; error?: string }> {
  const first = proxyImageUrl(String(raw || ''));
  if (!first) return { ok: false, error: 'blocked' };
  let url: URL = first;
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: 'timeout' };
      const res = await getOnce(url, remaining);
      if (res.tooLarge) return { ok: false, error: 'too large' };
      if (res.status >= 300 && res.status < 400) {
        const next: URL | null = res.location ? proxyImageUrl(res.location, url.toString()) : null;
        if (!next) return { ok: false, error: 'redirect blocked' };
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `http ${res.status}` };
      return imageDataUrl(res.contentType, res.body);
    }
    return { ok: false, error: 'too many redirects' };
  } catch (err: any) {
    const message = String(err?.message || err);
    return { ok: false, error: /time|ETIMEDOUT/i.test(message) ? 'timeout' : message };
  }
}
