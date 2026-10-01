/**
 * Test the real provider key through the INSTALLED app's real UI:
 * launches the production build against the real profile, opens
 * Settings → Providers, and clicks Validate and Test on the user's
 * provider card — exactly what a user does. Verifies the app survives
 * and the key/model list work. Never prints the key itself.
 * Run: node scripts/test-key-installed.mjs
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'openplot-ai', 'OpenPlot AI.exe');
const profile = path.join(os.homedir(), 'AppData', 'Roaming', 'OpenPlot AI');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Hard watchdog: the harness must always exit (a killed process loses its
  // piped output, so hanging forever = zero diagnostics).
  setTimeout(() => { console.error('WATCHDOG: harness timed out'); try { execSync('taskkill /F /IM "OpenPlot AI.exe" /T', { shell: 'cmd.exe' }); } catch {} process.exit(2); }, 150000);
  try { execSync('taskkill /F /IM "OpenPlot AI.exe" /T', { shell: 'cmd.exe' }); } catch {}
  await sleep(1200);

  const port = 9530;
  const child = spawn(exe, ['--remote-debugging-port=' + String(port)], { stdio: 'ignore' });
  let exited = null;
  child.on('exit', (c) => { exited = c; });

  let list = null;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); break; } catch { await sleep(500); }
  }
  let failures = 0;
  const check = (name, cond, detail = '') => {
    if (cond) console.log('  PASS: ' + name);
    else { failures++; console.error('  FAIL: ' + name + ' ' + detail); }
  };
  try {
    if (!list) throw new Error('CDP never came up');
    const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), 15000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    const call = (method, params) => new Promise((res, rej) => {
      const mid = ++id;
      const t = setTimeout(() => { pending.delete(mid); rej(new Error('timeout ' + method)); }, 30000);
      pending.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evalJS = async (expr) => {
      const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 200));
      return r.result?.value;
    };

    // Wait for full boot.
    let booted = null;
    for (let i = 0; i < 40; i++) {
      try { booted = await evalJS(`!!document.querySelector('.welcome-card, .nav-item, .page')`); } catch {}
      if (booted) break;
      await sleep(700);
    }
    check('app booted', !!booted && !exited);

    // Open Settings → Providers.
    await evalJS(`window.useData.getState().navigate('settings')`);
    await sleep(800);

    // Find the apinex provider card (JS expression, not CSS selector).
    const cardExpr = `(function(){var cards=[...document.querySelectorAll('.provider-card')];return cards.findIndex(function(c){var inp=c.querySelector('.head input:not([type=checkbox])');return inp && inp.value==='apinex';});})()`;
    const idx = await evalJS(cardExpr);
    check('apinex card found', typeof idx === 'number' && idx >= 0, 'idx=' + idx);
    if (typeof idx !== 'number' || idx < 0) throw new Error('card not found');
    const cardAt = `(function(){var c=[...document.querySelectorAll('.provider-card')][${idx}];return c||null;})()`;

    // 1) Validate — the exact button from the original crash report.
    await evalJS(`(function(){var c=${cardAt}; if(!c) return false; var b=c.querySelector('.key-validation button'); if(!b) return false; b.click(); return true;})()`);
    // Validate does a live network call — poll for the result up to ~25s.
    let valText = null;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      try { valText = await evalJS(`(function(){var c=${cardAt}; if(!c) return null; var el=c.querySelector('.key-validation .key-result'); return el?el.textContent.trim():null;})()`); } catch {}
      if (valText) break;
    }
    console.log('  validate says:', valText);
    check('Validate: app alive', exited === null);
    check('Validate: key accepted', !!valText && /accepted/i.test(valText), valText || 'no result text');

    // 2) Test — persist + fetchModels. Toasts auto-dismiss in ~3s, so poll
    // the DOM fast instead of hooking the store (useUi is not exposed in
    // production builds — only useData is).
    const modelsBefore = await evalJS(`(function(){var c=${cardAt}; if(!c) return ''; return [...c.querySelectorAll('.model-tag')].map(function(t){return t.textContent;}).join('|');})()`);
    await evalJS(`(function(){var c=${cardAt}; if(!c) return false; var b=[...c.querySelectorAll('.head button')].find(function(b){return /test/i.test(b.textContent);}); if(!b) return false; b.click(); return true;})()`);
    let seenToasts = [];
    const isResult = (t) => /\d+\s*model|test (ok|failed)|gagal|berhasil/i.test(t);
    let modelsAfter = modelsBefore;
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      try {
        const snap = await evalJS(`JSON.stringify([...document.querySelectorAll('.toast')].map(function(t){return t.textContent;}))`);
        const arr = JSON.parse(snap || '[]');
        for (const t of arr) if (!seenToasts.includes(t)) seenToasts.push(t);
        // "Fetching…" is the in-progress toast — keep waiting for the RESULT.
        if (seenToasts.some(isResult)) break;
      } catch {}
    }
    console.log('  toasts seen:', JSON.stringify(seenToasts));
    modelsAfter = await evalJS(`(function(){var c=${cardAt}; if(!c) return ''; return [...c.querySelectorAll('.model-tag')].map(function(t){return t.textContent;}).join('|');})()`);
    console.log('  models: before=' + modelsBefore.split('|').filter(Boolean).length + ' after=' + modelsAfter.split('|').filter(Boolean).length);
    check('Test: app alive', exited === null);
    check('Test: success toast', seenToasts.some((t) => isResult(t) && !/fail|gagal/i.test(t)), JSON.stringify(seenToasts));
    check('Test: model list intact', modelsAfter.split('|').filter(Boolean).length >= 35);

    const toasts = await evalJS(`[...document.querySelectorAll('.toast')].map(function(t){return t.textContent;}).join(' | ').slice(0,200)`);
    console.log('  toasts:', toasts || '(none)');

    ws.close();
  } catch (e) {
    failures++;
    console.error('HARNESS ERROR: ' + String(e.message || e).slice(0, 300));
    if (exited !== null) console.error('electron exited, code=' + exited);
  } finally {
    try { child.kill(); } catch {}
    await sleep(1000);
    try { execSync('taskkill /F /IM "OpenPlot AI.exe" /T', { shell: 'cmd.exe' }); } catch {}
  }
  console.log(failures === 0 ? 'REAL-UI KEY TEST OK' : 'REAL-UI KEY TEST FAILED');
  process.exit(failures ? 1 : 0);
})();
