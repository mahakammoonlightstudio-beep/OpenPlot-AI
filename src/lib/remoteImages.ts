import { LOW_MEMORY } from './deviceProfile';

/**
 * Remote Markdown images, hydrated through the main process.
 *
 * The sanitizer keeps `<img src="https://…">`, but the page CSP is
 * `img-src 'self' data: blob:` with `connect-src 'none'` — so the renderer
 * never loads it. The main process fetches the bytes (http(s) only, private
 * hosts refused, 5 MB cap) and this module swaps the src for a `data:` URL.
 * Results are cached by URL so scrolling a transcript does not re-request the
 * same image; the cache is bounded like the Markdown one.
 */
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
// A data URL is held as a JS string AND decoded by the renderer. Forty images
// at the 5 MB fetch cap could pin hundreds of megabytes, so the cache is
// bounded by bytes as well as count. Low-memory machines get a smaller budget.
const CACHE_MAX = LOW_MEMORY ? 12 : 24;
const CACHE_BYTES_MAX = (LOW_MEMORY ? 6 : 12) * 1024 * 1024;
let cacheBytes = 0;

function remember(url: string, data: string): void {
  // A single huge image still displays for this view, it just is not retained.
  if (data.length > CACHE_BYTES_MAX / 2) return;
  const prev = cache.get(url);
  if (prev) cacheBytes -= prev.length + url.length;
  cache.set(url, data);
  cacheBytes += data.length + url.length;
  while ((cache.size > CACHE_MAX || cacheBytes > CACHE_BYTES_MAX) && cache.size) {
    const oldest = cache.keys().next().value as string;
    const val = cache.get(oldest) || '';
    cacheBytes -= val.length + oldest.length;
    cache.delete(oldest);
  }
  if (cacheBytes < 0) cacheBytes = 0;
}

function load(url: string): Promise<string | null> {
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;
  // Plain-browser dev has no bridge: leave the image alone rather than throw.
  const bridge = (window as any).inkwell?.fetchImage;
  if (typeof bridge !== 'function') return Promise.resolve(null);
  const p = Promise.resolve()
    .then(() => bridge(url))
    .then((r: any) => (r?.ok && typeof r.data === 'string' ? r.data : null))
    .catch(() => null)
    .finally(() => pending.delete(url));
  pending.set(url, p);
  return p;
}

/** Replace every remote image src inside a rendered Markdown container. */
export function hydrateRemoteImages(root: HTMLElement | null): void {
  if (!root) return;
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'));
  for (const img of imgs) {
    const raw = img.getAttribute('src') || '';
    if (!/^https?:\/\//i.test(raw)) continue;
    const hit = cache.get(raw);
    if (hit) {
      img.src = hit;
      continue;
    }
    // A streaming bubble re-renders its HTML every frame; the marker (and the
    // shared `pending` map) keep that from firing one IPC call per token.
    if (img.dataset.remoteImage === 'loading') continue;
    img.dataset.remoteImage = 'loading';
    void load(raw).then((data) => {
      if (!img.isConnected) return;
      delete img.dataset.remoteImage;
      if (data) {
        remember(raw, data);
        img.src = data;
      } else {
        // Leave the alt text visible instead of a broken-image icon.
        img.removeAttribute('src');
        img.classList.add('md-img-failed');
      }
    });
  }
}

/** Test hook: how many images are held in memory. */
export function remoteImageCacheSize(): number {
  return cache.size;
}
