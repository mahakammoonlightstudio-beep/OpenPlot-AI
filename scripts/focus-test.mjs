/**
 * Focus regression test (ASCII only).
 * Boots vite + electron (isolated APPDATA), connects via CDP and verifies the
 * keyboard-focus fixes:
 *   1. confirmDialog paths (delete + cancel) never leave focus on <body>
 *   2. typing works immediately after every dialog closes
 *   3. chapter History modal: open -> Escape -> focus rescued
 *   4. Tab-reachability: hidden chapter reorder buttons become visible on focus
 *   5. command palette open/close keeps typing alive
 * Run: node scripts/focus-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronExe = require('electron');
const PROJ = path.resolve(import.meta.dirname, '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS: ' + name);
  else { failures++; console.error('  FAIL: ' + name + ' ' + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch (e) { lastErr = String(e.message || e).slice(0, 120); }
    await sleep(250);
  }
  throw new Error('timeout: ' + label + (lastErr ? ' (last: ' + lastErr + ')' : ''));
}

// ---------- CDP ----------
async function connectCdp(port) {
  let list = [];
  for (let i = 0; i < 40; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch { /* not ready */ }
    const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
    if (page) break;
    await sleep(250);
  }
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('no page target after polling');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let msgId = 0;
  const pending = new Map();
  let dead = false;
  ws.onclose = () => {
    dead = true;
    for (const [, p] of pending) p.rej(new Error('CDP connection closed'));
    pending.clear();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error).slice(0, 200))) : p.res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    if (dead) return rej(new Error('CDP closed'));
    const id = ++msgId; pending.set(id, { res, rej });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { rej(e); }
  });
  return {
    send,
    async evalJS(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result?.value;
    },
    async typeText(text) {
      await send('Input.insertText', { text });
    },
    async pressKey(key, { code, vk, modifiers = 0 } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: code || key, windowsVirtualKeyCode: vk || 0, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code || key, windowsVirtualKeyCode: vk || 0, modifiers });
    },
    async click(selector) {
      const ok = await this.evalJS(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Error('click target not found: ' + selector);
    },
    close: () => { try { ws.close(); } catch { /* ignore */ } }
  };
}

const setReactInput = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;

// ---------- main ----------
(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: focus test timed out'); process.exit(2); }, 240000);
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('netstat -ano | findstr :5173 | findstr LISTENING', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(out.split('\\n').map((l) => l.trim().split(/\\s+/).pop()).filter(Boolean))];
    for (const pid of pids) { try { execSync('taskkill /F /PID ' + pid, { shell: 'cmd.exe' }); } catch { /* ignore */ } }
  } catch { /* nothing listening */ }
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch { /* none */ }

  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-focus-'));
  console.log('isolated APPDATA: ' + tmpAppData);

  const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9750 + Math.floor(Math.random() * 200);
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
  });
  let cleaningUp = false;
  electron.on('exit', () => { if (!cleaningUp) { console.error('ELECTRON EXITED early'); process.exit(3); } });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  const cdp = await connectCdp(cdpPort);
  console.log('CDP connected\\n');

  const focusIsSane = () => cdp.evalJS(`(() => {
    const ae = document.activeElement;
    const ok = ae && (ae.id === 'app-root' || document.body.contains(ae)) && ae !== document.body;
    return ok ? 'sane:' + (ae.id || ae.tagName) : 'FOCUS-LOST';
  })()`);
  const modalOpen = () => cdp.evalJS(`!!document.querySelector('.modal-overlay')`);
  const confirmModalOpen = () => cdp.evalJS(`!!document.querySelector('.modal .foot button.danger')`);

  try {
    // ---------- boot ----------
    // The renderer can still be mid-reload when CDP connects (execution
    // context destroyed) — retry until the page is ready for evaluation.
    await waitUntil(async () => {
      try { await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll');return 'fresh';})()"); return true; }
      catch { return false; }
    }, 30000, 'renderer ready for eval');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'welcome screen');
    check('boot: welcome screen', true);

    // ---------- Test A1: delete-chat confirm, then typing ----------
    await cdp.click('.sidebar-header button.primary');
    await sleep(1200);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.composer2 textarea')"), 20000, 'composer after new chat');
    check('A: chat opened', true);

    const trashBtn = '.nav-section .nav-item .actions button:nth-child(2)';
    await cdp.click(trashBtn);
    await waitUntil(confirmModalOpen, 10000, 'delete confirm modal');
    check('A: in-app confirm dialog appeared (no native dialog)', true);
    await cdp.click('.modal .foot button.danger'); // Delete
    await waitUntil(async () => !(await modalOpen()), 10000, 'confirm modal closed');
    await sleep(150);
    const f1 = await focusIsSane();
    check('A: focus sane after delete confirm', f1.startsWith('sane'), f1);
    // typing works right after: focus the sidebar search and type
    await cdp.evalJS(`document.querySelector('.sidebar-search input')?.focus()`);
    await cdp.typeText('focus');
    const searchVal = await cdp.evalJS(`document.querySelector('.sidebar-search input')?.value || ''`);
    check('A: typing works after delete confirm', searchVal === 'focus', 'value=' + JSON.stringify(searchVal));

    // ---------- Test A2: cancel path ----------
    await cdp.evalJS(`(() => { const el = document.querySelector('.sidebar-search input'); ${setReactInput}(el, ''); })()`);
    // A1 deleted the only chat — create a fresh one so the trash button exists.
    await cdp.click('.sidebar-header button.primary');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.composer2 textarea')"), 20000, 'composer after 2nd new chat');
    await cdp.click(trashBtn);
    await waitUntil(confirmModalOpen, 10000, 'delete confirm modal (2nd)');
    await cdp.click('.modal .foot button:not(.danger)'); // Cancel
    await waitUntil(async () => !(await modalOpen()), 10000, 'cancel modal closed');
    await sleep(150);
    const f2 = await focusIsSane();
    check('A: focus sane after cancel', f2.startsWith('sane'), f2);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.composer2 textarea')"), 10000, 'composer still there');
    await cdp.evalJS(`document.querySelector('.composer2 textarea').focus()`);
    await cdp.typeText('hello world');
    const compVal = await cdp.evalJS(`document.querySelector('.composer2 textarea')?.value || ''`);
    check('A: composer typing works after cancel', compVal === 'hello world', 'value=' + JSON.stringify(compVal));

    // ---------- Test B: chapters editor + History modal + Tab reachability ----------
    const chaptersNav = await cdp.evalJS(`(() => {
      const items = [...document.querySelectorAll('.nav-item')];
      const el = items.find((n) => n.textContent.trim() === 'Chapters');
      if (!el) return false; el.click(); return true;
    })()`);
    if (!chaptersNav) throw new Error('Chapters nav item not found');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.chapter-list')"), 15000, 'chapters view');
    await cdp.click('.chapter-list button.primary'); // New chapter
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.chapter-editor .head input')"), 15000, 'chapter editor');
    check('B: chapter created and editor open', true);

    // type into the chapter title (native setter so React sees it)
    await cdp.evalJS(`(() => { const el = document.querySelector('.chapter-editor .head input'); ${setReactInput}(el, 'Focus Chapter'); })()`);
    const titleVal = await cdp.evalJS(`document.querySelector('.chapter-editor .head input')?.value`);
    check('B: chapter title editable', titleVal === 'Focus Chapter', 'value=' + JSON.stringify(titleVal));

    // type into the content textarea with real typed input
    await cdp.evalJS(`document.querySelector('.chapter-editor textarea')?.focus()`);
    await cdp.typeText('The quick brown fox.');
    const contentVal = await cdp.evalJS(`document.querySelector('.chapter-editor textarea')?.value || ''`);
    check('B: chapter content typing works', contentVal.includes('quick brown fox'), 'value=' + JSON.stringify(contentVal));

    // History modal open -> Escape -> focus rescued
    const histBtn = await cdp.evalJS(`(() => {
      const btns = [...document.querySelectorAll('.chapter-editor .head button')];
      const el = btns.find((b) => b.textContent.trim() === 'History');
      if (!el) return false; el.click(); return true;
    })()`);
    if (!histBtn) throw new Error('History button not found');
    await waitUntil(() => cdp.evalJS(`!!document.querySelector('.ui-modal-card')`), 10000, 'history modal');
    check('B: history modal opened', true);
    // focus should be inside the modal now
    const fIn = await cdp.evalJS(`(() => { const c = document.querySelector('.ui-modal-card'); return c && c.contains(document.activeElement) ? 'inside' : 'outside:' + (document.activeElement?.tagName || 'null'); })()`);
    check('B: focus moved into modal', fIn === 'inside', fIn);
    await cdp.pressKey('Escape', { code: 'Escape', vk: 27 });
    await waitUntil(async () => !(await cdp.evalJS(`!!document.querySelector('.ui-modal-card')`)), 10000, 'history modal closed');
    await sleep(150);
    const f3 = await focusIsSane();
    check('B: focus rescued after modal close', f3.startsWith('sane'), f3);

    // Tab reachability: programmatically focus a hidden reorder button (what
    // Tab navigation lands on) — its container must become visible. A second
    // chapter is needed first: with a single chapter both reorder buttons are
    // disabled (top of list AND bottom of list).
    await cdp.click('.chapter-list button.primary');
    await waitUntil(() => cdp.evalJS(`document.querySelectorAll('.chapter-item').length >= 2`), 15000, 'second chapter');
    const reorderVisible = await cdp.evalJS(`(async () => {
      // skip disabled buttons — the first chapter's up-button is disabled and
      // cannot take focus; Tab navigation lands on the enabled one.
      const btn = document.querySelector('.chapter-item .reorder button:not(:disabled)');
      if (!btn) return 'NO-BUTTON';
      btn.focus();
      // the 0.12s opacity transition needs a beat before computed style settles
      await new Promise((r) => setTimeout(r, 250));
      const wrap = btn.closest('.reorder');
      const ae = document.activeElement;
      return (ae === btn && getComputedStyle(wrap).opacity === '1') ? 'VISIBLE' : 'HIDDEN';
    })()`);
    check('B: hidden reorder buttons become visible when focused', reorderVisible === 'VISIBLE', reorderVisible);

    // ---------- Test C: command palette ----------
    await cdp.pressKey('k', { code: 'KeyK', vk: 75, modifiers: 2 }); // Ctrl+K
    await waitUntil(() => cdp.evalJS(`!!document.querySelector('.palette-overlay')`), 10000, 'palette overlay');
    check('C: command palette opened', true);
    await sleep(120); // palette focuses its input after 30ms
    const palFocus = await cdp.evalJS(`(() => {
      const inp = document.querySelector('.palette input');
      return inp && document.activeElement === inp ? 'focused' : 'NOT:' + (document.activeElement?.tagName || 'null');
    })()`);
    check('C: palette input auto-focused', palFocus === 'focused', palFocus);
    await cdp.pressKey('Escape', { code: 'Escape', vk: 27 });
    let closed = false;
    try { await waitUntil(async () => !(await cdp.evalJS(`!!document.querySelector('.palette-overlay')`)), 4000, 'palette closed by Escape'); closed = true; } catch { /* fall through */ }
    if (!closed) {
      console.log('  NOTE: Escape did not close the palette — closing via overlay click');
      await cdp.evalJS(`document.querySelector('.palette-overlay')?.click()`);
      await waitUntil(async () => !(await cdp.evalJS(`!!document.querySelector('.palette-overlay')`)), 6000, 'palette closed by overlay click');
      failures++; console.error('  FAIL: Escape did not close the command palette');
    }
    await sleep(150);
    const f4 = await focusIsSane();
    check('C: focus sane after palette close', f4.startsWith('sane'), f4);
    await cdp.evalJS(`document.querySelector('.sidebar-search input')?.focus()`);
    await cdp.typeText('z');
    const searchVal2 = await cdp.evalJS(`document.querySelector('.sidebar-search input')?.value || ''`);
    check('C: typing works after palette close', searchVal2 === 'z', 'value=' + JSON.stringify(searchVal2));
  } catch (e) {
    failures++;
    console.error('FATAL: ' + String(e.message || e).slice(0, 400));
  } finally {
    cleaningUp = true;
    cdp.close();
    try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { shell: true }); } catch { /* ignore */ }
    try { vite.kill(); } catch { /* ignore */ }
  }

  console.log('\\n' + (failures === 0 ? 'ALL FOCUS TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})();
