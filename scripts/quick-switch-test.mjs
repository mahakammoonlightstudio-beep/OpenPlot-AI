/**
 * Quick switch GUI test (ASCII only).
 * Boots vite + electron (isolated profile) and drives Ctrl+P:
 *   1. switch mode shows only chats and projects, with project/workspace hints
 *   2. an Agent session opens in the Agent workspace, not Chat
 *   3. score order matches visual order while searching
 *   4. current chat/project lead the empty list and are marked
 *   5. every chat is searchable, including one older than the recent 30
 *   6. Ctrl+K still opens the full command list
 * Run: node scripts/quick-switch-test.mjs
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
  const findAppPage = () => list.find((t) => t.type === 'page' && /^http:\/\/localhost:5173/.test(t.url));
  for (let i = 0; i < 80; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch { /* not ready */ }
    if (findAppPage()) break;
    await sleep(250);
  }
  const page = findAppPage();
  if (!page) throw new Error('no app page target after polling');
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
    async pressKey(key, { code, vk, modifiers = 0 } = {}) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code: code || key,
        windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code: code || key,
        windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers
      });
    },
    close: () => { try { ws.close(); } catch { /* ignore */ } }
  };
}

const setReactInput = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;
const openSwitch = (cdp) => cdp.pressKey('p', { code: 'KeyP', vk: 80, modifiers: 2 });
const typeQuery = (cdp, text) => cdp.evalJS(`(function(){var i=document.querySelector('.palette input');${setReactInput}(i,${JSON.stringify(text)});})()`);
const pressEnter = (cdp) => cdp.evalJS("document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
const readPalette = (cdp) => cdp.evalJS(`(() => ({
  placeholder: document.querySelector('.palette input')?.placeholder || '',
  groups: [...document.querySelectorAll('.palette-group')].map((e) => e.textContent.trim()),
  items: [...document.querySelectorAll('.palette-item')].map((e) => ({
    label: e.querySelector('.plabel')?.textContent.trim() || '',
    hint: e.querySelector('.phint')?.textContent.trim() || '',
    active: e.classList.contains('active')
  })),
  empty: document.querySelector('.palette-empty')?.textContent.trim() || ''
}))()`);

// ---------- main ----------
(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: quick-switch test timed out'); process.exit(2); }, 300000);
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('netstat -ano | findstr :5173 | findstr LISTENING', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p || '')))];
    for (const pid of pids) { try { execSync('taskkill /F /PID ' + pid, { shell: 'cmd.exe' }); } catch { /* ignore */ } }
  } catch { /* nothing listening */ }

  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-switch-'));
  console.log('isolated APPDATA: ' + tmpAppData + '\n');

  const vite = spawn(process.execPath, [path.join(PROJ, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'], { stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 90000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9650 + Math.floor(Math.random() * 200);
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '--user-data-dir=' + tmpAppData, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
  });
  let cleaningUp = false;
  electron.on('exit', (code) => {
    if (!cleaningUp) { console.error('ELECTRON EXITED early code=' + code); process.exit(3); }
  });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  const cdp = await connectCdp(cdpPort);
  console.log('CDP connected\n');

  const run = async (label, fn) => {
    console.log('[' + label + ']');
    try { await fn(); } catch (e) { failures++; console.error('  FAIL: ' + label + ' threw: ' + String(e.message || e).slice(0, 300)); }
  };

  try {
    let ids;

    await run('seed chats and projects', async () => {
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card, .page')"), 60000, 'app shell');
      ids = await cdp.evalJS(`(async () => {
        await window.inkwell.dbCall('resetAll');
        const mk = async (op, payload) => {
          const r = await window.inkwell.dbCall(op, payload);
          if (!r || r.ok === false) throw new Error(op + ': ' + (r && r.error));
          return r.data;
        };
        const a = await mk('createProject', { name: 'Novel Alpha' });
        const b = await mk('createProject', { name: 'Novel Beta' });
        const c1 = await mk('createChat', { title: 'Opening scene', project_id: a.id, workspace: 'chat' });
        const c2 = await mk('createChat', { title: 'Agent research', project_id: b.id, workspace: 'agent' });
        const c3 = await mk('createChat', { title: 'Loose thoughts', project_id: null, workspace: 'chat' });
        await window.useSettings.getState().load();
        await window.useData.getState().load();
        return { a: a.id, b: b.id, c1: c1.id, c2: c2.id, c3: c3.id };
      })()`);
      check('two projects and three chats seeded', !!(ids?.a && ids?.b && ids?.c1 && ids?.c2 && ids?.c3), JSON.stringify(ids));

      // Fresh profile: dismiss What's New so the palette is the only overlay.
      const dismissed = await cdp.evalJS(`(() => {
        const b = [...document.querySelectorAll('.ui-modal-card button')].find((x) => /start writing|mulai menulis|start/i.test(x.textContent || ''));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (dismissed) await waitUntil(async () => !(await cdp.evalJS("!!document.querySelector('.ui-modal-card')")), 5000, 'whats-new closed');
    });

    await run('Ctrl+P opens switch-only palette', async () => {
      await openSwitch(cdp);
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 10000, 'palette open');
      await sleep(150);
      const p = await readPalette(cdp);
      check('placeholder names chats and projects', p.placeholder === 'Switch to a chat or project…', p.placeholder);
      check('only chats and projects are grouped', JSON.stringify(p.groups) === JSON.stringify(['Recent chats', 'Projects']), JSON.stringify(p.groups));
      const labels = p.items.map((x) => x.label);
      check('empty switch lists every chat and project',
        ['Opening scene', 'Agent research', 'Loose thoughts', 'Novel Alpha', 'Novel Beta'].every((l) => labels.includes(l)),
        labels.join('|'));
      const agent = p.items.find((x) => x.label === 'Agent research');
      check('chat hint names its project and workspace', agent?.hint === 'Novel Beta · Agent', agent?.hint || 'missing');
      const alpha = p.items.find((x) => x.label === 'Novel Alpha');
      check('project hint shows its chat count', alpha?.hint === '1 chat', alpha?.hint || 'missing');
    });

    await run('search opens an Agent session in Agent', async () => {
      await typeQuery(cdp, 'Agent research');
      await sleep(250);
      const p = await readPalette(cdp);
      check('search narrows to the Agent chat', p.items.length === 1 && p.items[0].label === 'Agent research', JSON.stringify(p.items));
      await pressEnter(cdp);
      await waitUntil(async () => (await cdp.evalJS("window.useData.getState().activeChatId")) === ids.c2, 8000, 'agent chat selected');
      const state = await cdp.evalJS("({ route: window.useData.getState().route, id: window.useData.getState().activeChatId })");
      check('Agent chat lands on the Agent route', state?.route === 'agent' && state?.id === ids.c2, JSON.stringify(state));
    });

    await run('project search is score-first', async () => {
      await openSwitch(cdp);
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 10000, 'palette open');
      await typeQuery(cdp, 'Novel Beta');
      await sleep(250);
      const p = await readPalette(cdp);
      check('project ranks first and is highlighted', p.items[0]?.label === 'Novel Beta' && p.items[0]?.active === true, JSON.stringify(p.items.map((x) => x.label + (x.active ? '*' : ''))));
      await pressEnter(cdp);
      await waitUntil(async () => (await cdp.evalJS("window.useData.getState().route")) === 'projects', 8000, 'projects route');
      const id = await cdp.evalJS("window.useData.getState().activeProjectId");
      check('selected project becomes active', id === ids.b, String(id));
    });

    await run('current items lead and are marked', async () => {
      await openSwitch(cdp);
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 10000, 'palette open');
      await sleep(150);
      const p = await readPalette(cdp);
      check('active chat leads the list', p.items[0]?.label === 'Agent research', p.items.map((x) => x.label).join('|'));
      const chat = p.items.find((x) => x.label === 'Agent research');
      check('active chat is marked current', /Current/.test(chat?.hint || ''), chat?.hint || 'missing');
      const proj = p.items.find((x) => x.label === 'Novel Beta');
      check('active project is marked current', proj?.hint === 'Current', proj?.hint || 'missing');
      await cdp.evalJS("document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await waitUntil(async () => !(await cdp.evalJS("!!document.querySelector('.palette-overlay')")), 5000, 'palette closed');
    });

    await run('every chat is searchable, not only recent 30', async () => {
      const total = await cdp.evalJS(`(async () => {
        for (let i = 0; i < 32; i++) {
          const r = await window.inkwell.dbCall('createChat', { title: 'Filler ' + i });
          if (!r || r.ok === false) throw new Error('filler ' + i + ': ' + (r && r.error));
        }
        await window.useData.getState().load();
        return window.useData.getState().chats.length;
      })()`);
      check('library has more than 30 chats', total > 30, String(total));
      await openSwitch(cdp);
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 10000, 'palette open');
      await typeQuery(cdp, 'Opening scene');
      await sleep(250);
      const p = await readPalette(cdp);
      check('old chat is still found by search', p.items.some((x) => x.label === 'Opening scene'), JSON.stringify(p.items.map((x) => x.label)));
      await pressEnter(cdp);
      await waitUntil(async () => (await cdp.evalJS("window.useData.getState().activeChatId")) === ids.c1, 8000, 'old chat selected');
      const state = await cdp.evalJS("({ route: window.useData.getState().route, id: window.useData.getState().activeChatId })");
      check('old chat opens on the Chat route', state?.route === 'chat' && state?.id === ids.c1, JSON.stringify(state));
    });

    await run('empty switch result + Ctrl+K still commands', async () => {
      await openSwitch(cdp);
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 10000, 'palette open');
      await typeQuery(cdp, 'zzzz-no-match');
      await sleep(250);
      const empty = await cdp.evalJS("document.querySelector('.palette-empty')?.textContent.trim() || ''");
      check('no-match copy is switch-specific', empty === 'No chats or projects found', empty);
      await cdp.evalJS("document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await waitUntil(async () => !(await cdp.evalJS("!!document.querySelector('.palette-overlay')")), 5000, 'palette closed');
      await cdp.pressKey('k', { code: 'KeyK', vk: 75, modifiers: 2 });
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 10000, 'command palette open');
      await sleep(150);
      const p = await readPalette(cdp);
      check('Ctrl+K restores the full command list', p.groups.includes('Actions') && p.placeholder === 'Type a command…', JSON.stringify(p.groups) + ' | ' + p.placeholder);
    });
  } catch (e) {
    failures++;
    console.error('FATAL: ' + String(e.message || e).slice(0, 400));
  } finally {
    cleaningUp = true;
    cdp.close();
    try { spawn('taskkill', ['/F', '/PID', String(electron.pid), '/T']); } catch { /* ignore */ }
    try { vite.kill(); } catch { /* ignore */ }
    await sleep(600);
    try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  clearTimeout(watchdog);
  console.log('\n' + (failures === 0 ? 'ALL QUICK-SWITCH TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})();
