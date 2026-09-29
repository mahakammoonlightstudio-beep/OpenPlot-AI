// Renders an OG card HTML to a 1200x630 PNG using the Electron binary
// already present in node_modules.
// Usage: node scripts/make-og-image.mjs [card.html] [out.png]
// Defaults: docs/og-card.html -> docs/og-image.png
// Re-run whenever the card HTML changes, then commit the new PNG.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cardPath = resolve(process.argv[2] ?? join(root, 'docs', 'og-card.html'));
const outPath = resolve(process.argv[3] ?? join(root, 'docs', 'og-image.png'));

if (!existsSync(cardPath)) {
  console.error('card not found at', cardPath);
  process.exit(1);
}

// require('electron') from plain Node resolves to the path of the real
// Electron binary (node_modules/electron/dist/electron[.exe] on Windows).
const require = createRequire(import.meta.url);
let electronBin;
try {
  electronBin = require('electron');
} catch {
  electronBin = undefined;
}
if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
  const guess = join(root, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(guess)) {
    console.error('Electron binary not found — run: npm install');
    process.exit(1);
  }
  electronBin = guess;
}

const mainJs = join(root, 'scripts', 'og-capture-main.cjs');
mkdirSync(dirname(outPath), { recursive: true });

const result = spawnSync(electronBin, [mainJs, cardPath, outPath], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
});
process.exit(result.status ?? 1);
