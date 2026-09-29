// Renders docs/og-card.html to docs/og-image.png (1200x630) using the
// Electron binary already present in node_modules. Run: node scripts/make-og-image.mjs
// Re-run whenever docs/og-card.html changes, then commit the new PNG.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cardPath = join(root, 'docs', 'og-card.html');
const outPath = join(root, 'docs', 'og-image.png');

if (!existsSync(cardPath)) {
  console.error('og-card.html not found at', cardPath);
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
