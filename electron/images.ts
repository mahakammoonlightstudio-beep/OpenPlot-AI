import { isBlockedHost } from './webtools';

/**
 * Remote Markdown images, fetched by the main process instead of the renderer.
 *
 * CSP allows `img-src 'self' data: blob:` and `connect-src 'none'`, so a
 * model-written `<img src="https://…">` can never make the trusted window talk
 * to a third party. The renderer asks this module for the bytes and swaps in a
 * `data:` URL. Only raster formats are proxied (an SVG can reference remote
 * resources of its own, which would turn this into a generic loader), private
 * and metadata hosts are refused, and the size is capped.
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

export async function fetchRemoteImage(raw: string): Promise<{ ok: boolean; data?: string; error?: string }> {
  const first = proxyImageUrl(String(raw || ''));
  if (!first) return { ok: false, error: 'blocked' };
  let url: URL = first;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: any = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(url, {
        signal: ctrl.signal,
        // Redirects are followed by hand so every hop is re-checked: a public
        // URL must not be able to bounce the fetch onto a private address.
        redirect: 'manual',
        headers: { accept: 'image/*' }
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        const next: URL | null = loc ? proxyImageUrl(loc, url.toString()) : null;
        if (!next) return { ok: false, error: 'redirect blocked' };
        url = next;
        continue;
      }
      break;
    }
    if (!res) return { ok: false, error: 'no response' };
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const type = res.headers.get('content-type') || '';
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return { ok: false, error: 'too large' };
    const buf = Buffer.from(await res.arrayBuffer());
    return imageDataUrl(type, buf);
  } catch (err: any) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
