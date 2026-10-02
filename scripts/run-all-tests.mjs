/**
 * Test runner — one command for every test in scripts/.
 *
 *   npm test               → headless group only (no GUI, no network, no real keys)
 *   npm run test:e2e       → headless + GUI end-to-end groups
 *   node scripts/run-all-tests.mjs --list            → show groups and exit
 *   node scripts/run-all-tests.mjs --include=e2e-attach,manual
 *   node scripts/run-all-tests.mjs --rebuild         → force rebuild dist-electron
 *   node scripts/run-all-tests.mjs --skip-build-check (don't auto-rebuild)
 *
 * Groups (a script lives in exactly one group):
 *   headless    — pure node: mock servers + temp DB, safe everywhere, fast-ish.
 *   e2e-local   — boots its own vite + Electron (isolated APPDATA); slow, needs a display.
 *   e2e-attach  — drives the ALREADY RUNNING app over CDP :9222; skipped with a
 *                 notice when the app isn't running (never fails the run).
 *   manual      — touches the REAL installed app / profile / API keys, or the
 *                 packaged build. NEVER run by `npm test` or `--all`; only via
 *                 an explicit --include=manual,packaged.
 *
 * The headless scripts run against dist-electron/*.js, so the runner auto-runs
 * `npm run build:electron` when any electron/*.ts is newer than the build
 * output (or when the output is missing).
 *
 * Run: node scripts/run-all-tests.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROJ = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- groups ----
const GROUPS = {
  headless: [
    'db-test.mjs',        // sql.js schema/migrations/CRUD — no build output needed
    'ai-parser-test.mjs', // baseUrlCandidates, SseParser, dataLines, extractError, statusHint
    'tools-test.mjs',     // agent tools vs a real temp DB
    'url-fix-test.mjs',   // provider URL recovery + readable HTML errors (mock http)
    'engine-test.mjs',    // streaming, tool-call ordering, abort (mock SSE server)
    'stress-test.mjs'     // hostile-relay scenarios vs the engine
  ],
  'e2e-local': [
    'gui-test.mjs',       // boots vite+electron, drives the real UI (chat, tools, prompts)
    'focus-test.mjs'      // boots vite+electron, keyboard-focus regression suite
  ],
  'e2e-attach': [
    'e2e-flow-test.mjs',  // full story-flow flow on the running app
    'ui-composer-test.mjs', // composer/project-chip/model-dropdown smoke on the running app
    'rating-a-b-test.mjs' // rating system-prompt A/B on the running app
  ],
  manual: [
    'test-apinex-key.mjs',    // real provider key through a COPY of the profile
    'test-key-installed.mjs', // clicks through the INSTALLED app's real UI
    'smoke-packaged.mjs'      // packaged build sanity (run after npm run dist:win)
  ]
};
const CDP_PORT = 9222; // e2e-attach preflight

// ------------------------------------------------------------------ args ----
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '')));
const includeArg = argv.find((a) => a.startsWith('--include='));
const includeList = includeArg ? includeArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

if (flags.has('list')) {
  console.log('Test groups (scripts/run-all-tests.mjs):\n');
  for (const [g, files] of Object.entries(GROUPS)) {
    console.log(`  ${g}${g === 'headless' ? '  (npm test default)' : g === 'manual' ? '  (explicit --include only)' : ''}`);
    for (const f of files) console.log(`    - ${f}`);
  }
  process.exit(0);
}

let selected;
if (includeList.length) {
  const unknown = includeList.filter((g) => !GROUPS[g]);
  if (unknown.length) { console.error(`Unknown group(s): ${unknown.join(', ')}. Valid: ${Object.keys(GROUPS).join(', ')}`); process.exit(2); }
  selected = includeList;
} else if (flags.has('all')) {
  selected = ['headless', 'e2e-local'];
} else {
  selected = ['headless'];
}

// --------------------------------------------------------- build handling ---
function newestTsMtime(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestTsMtime(p));
    else if (/\.(ts|tsx)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

async function runBuildElectron() {
  console.log('\n⚙  building dist-electron (npm run build:electron)…');
  const res = spawn('npm', ['run', 'build:electron'], { cwd: PROJ, stdio: 'inherit', shell: process.platform === 'win32' });
  await new Promise((res2, rej) => { res.on('exit', (c) => (c === 0 ? res2() : rej(new Error(`build:electron exited ${c}`)))); res.on('error', rej); });
}

const needsCompiled = ['headless', 'e2e-local', 'e2e-attach'].some((g) => selected.includes(g)) ||
  includeList.some((g) => ['manual', 'packaged'].includes(g));
const compiledEntry = path.join(PROJ, 'dist-electron', 'ai.js');

if (needsCompiled && (flags.has('rebuild') || !fs.existsSync(compiledEntry))) {
  await runBuildElectron();
} else if (needsCompiled && !flags.has('skip-build-check')) {
  const src = newestTsMtime(path.join(PROJ, 'electron'));
  const out = fs.statSync(compiledEntry).mtimeMs;
  if (src > out) {
    console.log('\nℹ  electron/*.ts is newer than dist-electron — rebuilding');
    await runBuildElectron();
  }
}

// ------------------------------------------------------------- utilities ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appRunningOnCdp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

function runScript(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PROJ, 'scripts', file)], {
      cwd: PROJ,
      stdio: 'inherit',
      env: process.env
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// ------------------------------------------------------------------ main ----
console.log(`\n🧪 OpenPlot AI test runner — groups: ${selected.join(', ')}`);
const t0 = Date.now();
const summary = [];
let failures = 0;

for (const group of selected) {
  for (const file of GROUPS[group]) {
    if (group === 'e2e-attach' && !(await appRunningOnCdp())) {
      console.log(`\n⏭  SKIP ${file} — no app running on :9222 (start the dev app first)`);
      summary.push([file, group, 'SKIP']);
      continue;
    }
    console.log(`\n▶  ${file}  (${group})`);
    const code = await runScript(file);
    const ok = code === 0;
    if (!ok) failures++;
    summary.push([file, group, ok ? 'PASS' : `FAIL (${code})`]);
  }
}

const mins = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n' + '─'.repeat(58));
console.log('  FILE'.padEnd(28) + 'GROUP'.padEnd(14) + 'RESULT');
for (const [file, group, result] of summary) {
  console.log(`  ${file.padEnd(28)}${group.padEnd(14)}${result}`);
}
console.log('─'.repeat(58));
const failed = summary.filter(([, , r]) => r.startsWith('FAIL')).length;
const skipped = summary.filter(([, , r]) => r === 'SKIP').length;
const passed = summary.length - failed - skipped;
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped — ${mins}s`);
console.log(failed === 0 ? '\n🟢 ALL SELECTED TESTS PASSED\n' : '\n🔴 SOME TESTS FAILED\n');
await sleep(100); // let libuv settle on Windows before exit
process.exit(failed === 0 ? 0 : 1);
