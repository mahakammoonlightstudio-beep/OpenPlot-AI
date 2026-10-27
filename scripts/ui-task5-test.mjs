/**
 * Task 5 GUI regression test (ASCII only).
 * Boots vite + electron (isolated APPDATA) against a mock SSE provider and
 * drives the real window over CDP:
 *   1. welcome screen cards + model health strip
 *   2. composer ability row (tools / thinking / skills popover)
 *   3. draft token estimate and header context meter (bar + warn state)
 *   4. drop overlay, pointer-events passthrough and a real file drop
 *   5. message action bar (keyboard focus) and regenerate-from-here
 * Run: node scripts/ui-task5-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    sleep(ms).then(() => { throw new Error('eval timeout after ' + ms + 'ms: ' + label); })
  ]);
}

// ---------- mock OpenAI SSE provider ----------
const reqBodies = [];
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-gui' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      reqBodies.push(JSON.parse(body));
      const reply = reqBodies.length === 1 ? 'GUI reply one' : 'GUI reply two';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const words = reply.split(' ');
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          write({ choices: [{ delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: null }] });
          i++;
        } else {
          write({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          clearInterval(timer);
          res.end();
        }
      }, 25);
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

// ---------- CDP ----------
async function connectCdp(port) {
  let list = [];
  // Electron briefly exposes an about:blank page target before the renderer
  // navigates; binding to it makes every query return null. Wait for the dev
  // server URL explicitly.
  const findAppPage = () => list.find((t) => t.type === 'page' && /^http:\/\/localhost:5173/.test(t.url));
  for (let i = 0; i < 80; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch { /* not ready */ }
    if (findAppPage()) break;
    await sleep(250);
  }
  const page = findAppPage();
  if (!page) throw new Error('no app page target after polling: ' + JSON.stringify(list.map((t) => t.url)));
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
      const r = await withTimeout(
        send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }),
        15000, expr.slice(0, 80)
      );
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result?.value;
    },
    async pressKey(key, { code, vk } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: code || key, windowsVirtualKeyCode: vk || 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code || key, windowsVirtualKeyCode: vk || 0 });
    },
    close: () => { try { ws.close(); } catch { /* ignore */ } }
  };
}

const setReactArea = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;

// ---------- main ----------
(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: Task 5 GUI test timed out'); process.exit(2); }, 240000);
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('netstat -ano | findstr :5173 | findstr LISTENING', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p)))];
    for (const pid of pids) { try { execSync('taskkill /F /PID ' + pid, { shell: 'cmd.exe' }); } catch { /* ignore */ } }
  } catch { /* nothing listening */ }
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch { /* none */ }

  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-task5-'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mockPort = server.address().port;
  console.log('mock provider: http://127.0.0.1:' + mockPort + '/v1');
  console.log('isolated APPDATA: ' + tmpAppData + '\n');

  // Spawn the vite binary directly: killing an `npx` wrapper leaves the node
  // server orphaned and the next run silently reuses a stale dev server.
  const vite = spawn(process.execPath, [path.join(PROJ, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'], { stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 90000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9400 + Math.floor(Math.random() * 300);
  // Windows resolves %APPDATA% through the known-folder API and ignores the
  // env override, so every run used to share one Chromium profile (and its
  // persisted route). --user-data-dir makes the isolation real.
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '--user-data-dir=' + tmpAppData, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
  });
  let cleaningUp = false;
  electron.on('exit', (code) => {
    if (!cleaningUp) { console.error('ELECTRON EXITED code=' + code); process.exit(3); }
  });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  const cdp = await connectCdp(cdpPort);
  console.log('CDP connected\n');

  const run = async (label, fn) => {
    console.log('[' + label + ']');
    try { await fn(); } catch (e) { failures++; console.error('  FAIL: ' + label + ' threw: ' + String(e.message || e).slice(0, 300)); }
  };

  try {
    // ---------- boot, seed provider + model override, refresh stores ----------
    await run('boot + seed profile', async () => {
      try {
        await waitUntil(() => cdp.evalJS(`!!document.querySelector('.welcome-card')`), 60000, 'app shell');
      } catch (e) {
        const text = await cdp.evalJS(`document.body.innerText.slice(0, 200)`);
        throw new Error(e.message + ' body=' + JSON.stringify(text));
      }
      check('app shell rendered the welcome screen', true);

      const providerId = await cdp.evalJS(`(async () => {
        await window.inkwell.dbCall('resetAll');
        const r = await window.inkwell.dbCall('createProvider', {
          name: 'GUI Mock', baseUrl: 'http://127.0.0.1:${mockPort}/v1',
          apiKey: 'sk-test', models: ['mock-gui'], kind: 'openai'
        });
        const p = (r && r.data) ? r.data : r;
        await window.inkwell.dbCall('setSetting', { key: 'defaultModel', value: JSON.stringify('mock-gui') });
        // A 2K window makes the meter deterministic and small enough that a long
        // draft crosses the 80% warn threshold.
        await window.inkwell.dbCall('setSetting', {
          key: 'modelOverrides',
          value: JSON.stringify({ [p.id + '::mock-gui']: { context: 2000 } })
        });
        return p.id;
      })()`);
      check('provider seeded', typeof providerId === 'string' && providerId.length > 0, String(providerId));
      const persisted = await cdp.evalJS(`window.inkwell.dbCall('getAllSettings').then((r) => r.data)`);
      check('model + window persisted', persisted?.defaultModel === '"mock-gui"' && /2000/.test(persisted?.modelOverrides || ''), JSON.stringify(persisted).slice(0, 140));
      // main.tsx exposes the stores for CDP tests; refreshing them is far more
      // reliable than reloading the window mid-run.
      const state = await cdp.evalJS(`(async () => {
        await window.useSettings.getState().load();
        await window.useData.getState().load();
        return {
          model: window.useSettings.getState().defaultModel,
          providers: window.useData.getState().providers.length,
          chats: window.useData.getState().chats.length
        };
      })()`);
      check('stores refreshed from the seeded DB', state?.model === 'mock-gui' && state?.providers === 1 && state?.chats === 0, JSON.stringify(state));
    });

    await run('welcome screen', async () => {
      await waitUntil(() => cdp.evalJS(`document.querySelectorAll('.welcome-card').length === 4`), 30000, 'welcome screen');
      await waitUntil(() => cdp.evalJS(`/mock-gui/.test(document.querySelector('.welcome-health')?.textContent || '')`), 15000, 'model health');
      const cards = await cdp.evalJS(`document.querySelectorAll('.welcome-card').length`);
      check('four quick-start cards', cards === 4, 'count=' + cards);
      const primary = await cdp.evalJS(`document.querySelectorAll('.welcome-card.primary').length`);
      check('no connect-first card when a model is connected', primary === 0, 'primary=' + primary);
      const health = await cdp.evalJS(`document.querySelector('.welcome-health')?.textContent || ''`);
      check('welcome health strip names the model', /mock-gui/.test(health), health);
    });

    await run('open chat from card + ability row', async () => {
      await cdp.evalJS(`document.querySelectorAll('.welcome-card')[0].click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.comp-box textarea')`), 15000, 'composer');
      await waitUntil(() => cdp.evalJS(`document.querySelector('.comp-box textarea').value.trim().length > 10`), 8000, 'prefilled draft');
      const draft = await cdp.evalJS(`document.querySelector('.comp-box textarea').value`);
      check('card starts a draft prompt', String(draft).trim().length > 10, String(draft).slice(0, 40));

      const row = await cdp.evalJS(`(() => {
        const r = document.querySelector('.comp-hints.ability-row');
        if (!r) return null;
        return {
          tools: !!r.querySelector('.ability-toggle'),
          thinking: !!r.querySelector('.think-btn'),
          skills: r.querySelector('.ability-btn')?.textContent || ''
        };
      })()`);
      check('ability row renders', !!row);
      check('ability row has tools toggle', row && row.tools === true);
      check('ability row has thinking control', row && row.thinking === true);
      check('ability row shows skill count', /\(\d+\)/.test(row?.skills || ''), row?.skills);

      const before = await cdp.evalJS(`document.querySelector('.ability-toggle').className`);
      await cdp.evalJS(`document.querySelector('.ability-toggle input').click()`);
      await sleep(150);
      const after = await cdp.evalJS(`document.querySelector('.ability-toggle').className`);
      check('tools toggle flips its on state', before !== after, before + ' -> ' + after);
      await cdp.evalJS(`document.querySelector('.ability-toggle input').click()`);

      await cdp.evalJS(`document.querySelector('.ability-btn').click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.ui-popover')`), 5000, 'skills popover');
      const skills = await cdp.evalJS(`(document.querySelector('.ui-popover')?.textContent || '') + '|' + !!document.querySelector('.skills-manage')`);
      check('skills popover explains the empty state', /no skills|belum ada skill/i.test(skills), skills.slice(0, 80));
      check('skills popover links to Settings', /\|true$/.test(skills));
      await cdp.pressKey('Escape', { code: 'Escape', vk: 27 });
    });

    await run('draft token estimate + context meter', async () => {
      const est = await cdp.evalJS(`document.querySelector('.composer-words')?.textContent || ''`);
      check('draft shows a token estimate', /~\d[\d.,]*\s*tok/.test(est), est);
      check('draft also shows a word count', /words|kata/.test(est), est);

      const caps = await cdp.evalJS(`(() => {
        const c = document.querySelector('.chat-caps');
        if (!c) return null;
        return {
          model: c.querySelector('.cc-model')?.textContent || '',
          dots: c.querySelectorAll('.cap-dot').length,
          meter: c.querySelector('.ctx-meter')?.textContent || '',
          bar: !!c.querySelector('.ctx-meter .cm-bar')
        };
      })()`);
      check('header capability strip renders', !!caps);
      check('header names model and provider', /mock-gui/.test(caps?.model || ''), caps?.model);
      check('three capability dots', caps?.dots === 3, 'dots=' + caps?.dots);
      check('meter shows used / window', /\/\s*2(\.0)?k/i.test(caps?.meter || ''), caps?.meter);
      check('meter draws a bar when the window is known', caps?.bar === true);

      // 8,000 chars ~= 2,000 tokens, i.e. 100% of the seeded 2K window.
      await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta, ${JSON.stringify('x'.repeat(8000))});})()`);
      await sleep(250);
      const warn = await cdp.evalJS(`(() => {
        const m = document.querySelector('.ctx-meter');
        const fill = m?.querySelector('.cm-fill');
        return { warn: m?.classList.contains('warn') || false, width: fill ? fill.style.width : '', text: m?.textContent || '' };
      })()`);
      check('meter warns past 80%', warn.warn === true, warn.text);
      check('meter bar fills to the estimate', warn.width === '100%', warn.width);
      await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta, '');})()`);
    });

    await run('send + message actions', async () => {
      await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta, 'Hello GUI');})()`);
      await cdp.evalJS(`document.querySelector('.send-btn').click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.msg.assistant .content') && !document.querySelector('.msg.assistant.streaming')`), 30000, 'assistant reply');
      await sleep(400);
      const content = await cdp.evalJS(`document.querySelector('.msg.assistant .content').textContent`);
      check('mock reply rendered', content.includes('GUI reply one'), content);

      const meta = await cdp.evalJS(`(() => {
        const m = document.querySelector('.msg.assistant');
        return { time: m.querySelector('.msg-time')?.textContent || '', actions: m.querySelectorAll('.actions button').length };
      })()`);
      check('assistant meta shows a relative timestamp', meta.time.trim().length > 0, meta.time);
      check('assistant actions include regenerate', meta.actions >= 4, 'buttons=' + meta.actions);

      const regen = await cdp.evalJS(`(() => {
        const b = [...document.querySelectorAll('.msg.assistant .actions button')]
          .find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || ''));
        return b ? { label: b.getAttribute('aria-label'), title: b.title } : null;
      })()`);
      check('regenerate button is labelled', !!regen, JSON.stringify(regen));
      check('regenerate label matches its tooltip', regen?.label === regen?.title, JSON.stringify(regen));

      const opacityBefore = await cdp.evalJS(`getComputedStyle(document.querySelector('.msg.assistant .actions')).opacity`);
      await cdp.evalJS(`[...document.querySelectorAll('.msg.assistant .actions button')].find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || '')).focus()`);
      await sleep(300);
      const opacityAfter = await cdp.evalJS(`getComputedStyle(document.querySelector('.msg.assistant .actions')).opacity`);
      check('action bar is quiet until focused', opacityBefore === '0', opacityBefore);
      check('action bar appears for keyboard users', opacityAfter === '1', opacityAfter);
    });

    await run('regenerate from here', async () => {
      const before = reqBodies.length;
      await cdp.evalJS(`[...document.querySelectorAll('.msg.assistant .actions button')].find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || '')).click()`);
      await waitUntil(async () => reqBodies.length > before, 15000, 'regeneration request');
      await waitUntil(async () => {
        const c = await cdp.evalJS(`document.querySelector('.msg.assistant .content')?.textContent || ''`);
        return c.includes('GUI reply two');
      }, 30000, 'regenerated reply');

      const shape = await cdp.evalJS(`({
        users: document.querySelectorAll('.msg.user').length,
        assistants: document.querySelectorAll('.msg.assistant').length,
        text: document.querySelector('.msg.assistant .content').textContent
      })`);
      check('old reply replaced, not appended', shape.users === 1 && shape.assistants === 1, JSON.stringify(shape));
      check('regenerated text is the fresh answer', shape.text.includes('GUI reply two'), shape.text);

      const lastSent = reqBodies[reqBodies.length - 1].messages.slice(-1)[0];
      check('regeneration resends the same user turn', lastSent?.role === 'user' && lastSent?.content === 'Hello GUI', JSON.stringify(lastSent).slice(0, 120));

      const rows = await cdp.evalJS(`(async () => {
        const cs = await window.inkwell.dbCall('listChats').then((r) => r.data);
        const ms = await window.inkwell.dbCall('getMessages', { chatId: cs[0].id }).then((r) => r.data);
        return ms.map((m) => m.role).join(',');
      })()`);
      check('DB holds exactly one user + one assistant row', rows === 'user,assistant', rows);
    });

    await run('drop overlay + file drop', async () => {
      await cdp.evalJS(`(function(){
        const el = document.querySelector('.messages');
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      })()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.drop-overlay')`), 5000, 'drop overlay');
      const overlay = await cdp.evalJS(`(() => {
        const o = document.querySelector('.drop-overlay');
        return { text: o.textContent, pe: getComputedStyle(o).pointerEvents };
      })()`);
      check('overlay names what can be dropped', /drop files|jatuhkan file/i.test(overlay.text), overlay.text.slice(0, 60));
      check('overlay lets the drop event through', overlay.pe === 'none', overlay.pe);

      await cdp.evalJS(`(function(){
        const dt = new DataTransfer();
        dt.items.add(new File(['# Scene\\nA quiet room.'], 'scene.md', { type: 'text/markdown' }));
        const el = document.querySelector('.messages');
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      })()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.attach-cards .file-card')`), 8000, 'attachment card');
      const name = await cdp.evalJS(`document.querySelector('.attach-cards .fc-name')?.textContent || ''`);
      check('dropped file becomes an attachment', name === 'scene.md', name);
      check('overlay closes after the drop', !(await cdp.evalJS(`!!document.querySelector('.drop-overlay')`)));

      await cdp.evalJS(`document.querySelector('.attach-cards .fc-x').click()`);
      await waitUntil(async () => !(await cdp.evalJS(`!!document.querySelector('.attach-cards')`)), 5000, 'attachment removed');
      check('attachment can be removed again', true);
    });
  } catch (e) {
    failures++;
    console.error('FATAL: ' + String(e.message || e).slice(0, 400));
  } finally {
    cleaningUp = true;
    cdp.close();
    try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { shell: true }); } catch { /* ignore */ }
    try { vite.kill(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    clearTimeout(watchdog);
  }

  console.log('\n' + (failures === 0 ? 'ALL TASK 5 GUI CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
})();
