/**
 * One place to decide whether this machine should use the lean rendering
 * profile. `deviceMemory` is Chromium's coarse RAM bucket (2/4/8 GB); it is
 * deliberately not based on CPU cores, because a fast 4-core laptop with ample
 * RAM does not need a smaller transcript window.
 *
 * Defaults to the full profile when the API is unavailable (Electron on some
 * platforms, test harnesses), so behaviour never regresses silently.
 */
const raw = typeof navigator !== 'undefined' ? Number((navigator as any).deviceMemory) : 0;

/** Coarse installed-memory bucket, or 0 when the browser hides it. */
export const DEVICE_MEMORY_GB = Number.isFinite(raw) && raw > 0 ? raw : 0;
export const LOW_MEMORY = DEVICE_MEMORY_GB > 0 && DEVICE_MEMORY_GB <= 4;
