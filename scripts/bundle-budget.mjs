/**
 * Bundle budget (v1.2.3 Task 12).
 *
 * Reads what `npm run build` produced and fails when the renderer gets fat —
 * the check that stops "one more import" from quietly costing a megabyte. It
 * prints a table either way, so a release note can quote real numbers.
 *
 * Budgets:
 *   - no single JS chunk larger than 900 KB,
 *   - total JS under 2.2 MB gzipped,
 *   - total CSS under 250 KB gzipped.
 *
 * Run: node scripts/bundle-budget.mjs            (needs dist/ — skips politely)
 *      node scripts/bundle-budget.mjs --json     (machine-readable)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'dist', 'assets');
const MAX_CHUNK_BYTES = 900 * 1024;
const MAX_TOTAL_GZIP = 2.2 * 1024 * 1024;
const MAX_CSS_GZIP = 250 * 1024;

if (!fs.existsSync(ASSETS)) {
  console.log('SKIP  bundle budget — dist/assets not found (run `npm run build` first)');
  process.exit(0);
}

const files = fs.readdirSync(ASSETS).filter((f) => /\.(js|css)$/.test(f));
const rows = files.map((f) => {
  const buf = fs.readFileSync(path.join(ASSETS, f));
  return {
    file: f,
    kind: f.endsWith('.css') ? 'css' : 'js',
    bytes: buf.length,
    gzip: zlib.gzipSync(buf).length
  };
});

const js = rows.filter((r) => r.kind === 'js');
const css = rows.filter((r) => r.kind === 'css');
const totalJs = js.reduce((a, r) => a + r.gzip, 0);
const totalCss = css.reduce((a, r) => a + r.gzip, 0);
const biggest = js.slice().sort((a, b) => b.bytes - a.bytes)[0];

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
rows.slice().sort((a, b) => b.bytes - a.bytes).forEach((r) => {
  console.log(`  ${r.kind}  ${kb(r.bytes).padStart(9)}  gz ${kb(r.gzip).padStart(9)}  ${r.file}`);
});

const checks = [
  ['largest JS chunk under 900 KB', biggest ? biggest.bytes <= MAX_CHUNK_BYTES : true,
    biggest ? `${biggest.file} ${kb(biggest.bytes)}` : 'no JS chunks'],
  ['total JS under 2.2 MB gzipped', totalJs <= MAX_TOTAL_GZIP, kb(totalJs)],
  ['total CSS under 250 KB gzipped', totalCss <= MAX_CSS_GZIP, kb(totalCss)],
  ['the build actually split the app', js.length >= 2, `${js.length} JS chunks`]
];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, totalJs, totalCss, checks }, null, 2));
}

let failed = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

console.log(`\n${failed === 0 ? 'ALL BUNDLE BUDGET CHECKS PASSED' : `${failed} BUNDLE BUDGET CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
