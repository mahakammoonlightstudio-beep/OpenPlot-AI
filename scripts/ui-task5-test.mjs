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
      const replies = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
      const reply = 'GUI reply ' + (replies[reqBodies.length - 1] || 'n' + reqBodies.length);
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
      }, 120); // slow enough to observe the streaming state from CDP
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
  // Page domain must be enabled or Page.captureScreenshot never replies.
  await send('Page.enable').catch(() => {});
  // UI_SHOTS=1 keeps PNGs of the real window in .tmp-shots/ for review.
  const SHOTS = process.env.UI_SHOTS === '1' ? path.join(PROJ, '.tmp-shots') : null;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  return {
    send,
    async shot(file) {
      if (!SHOTS) return;
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false });
      fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    },
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

      // Fresh profile → the "What's new" card covers the composer and the
      // screenshots. Dismiss it so the shots show the real UI.
      const dismissed = await cdp.evalJS(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /start writing|mulai menulis/i.test(x.textContent));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (dismissed) await waitUntil(async () => !(await cdp.evalJS(`!!document.querySelector('.ui-modal-card')`)), 5000, 'whats-new closed');
      check('whats-new card dismissed for a clean composer', dismissed === true);
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

      const bar = await cdp.evalJS(`(() => {
        const b = document.querySelector('.comp-modes');
        if (!b) return null;
        return {
          insideBar: !!b.closest('.comp-box'),
          agent: !!b.querySelector('.agent-toggle'),
          agentOn: b.querySelector('.agent-toggle')?.getAttribute('aria-pressed') || '',
          modes: [...b.querySelectorAll('.mode-btn')].map((x) => x.textContent.trim() + (x.classList.contains('on') ? '*' : '')),
          thinking: !!b.querySelector('.think-btn'),
          skills: b.querySelector('.ability-btn')?.textContent.trim() || '',
          disclaimer: document.querySelector('.composer-disclaimer')?.textContent.trim() || ''
        };
      })()`);
      check('agent, modes, thinking and skills sit inside the chat bar', bar?.insideBar === true, JSON.stringify(bar));
      check('agent mode starts off', bar?.agentOn === 'false', bar?.agentOn);
      check('three chat modes, write active by default', bar?.modes?.length === 3 && bar.modes.some((m) => /^Write\*/.test(m)), JSON.stringify(bar?.modes));
      check('thinking control is in the bar', bar?.thinking === true);
      check('skills are off by default', /\(0\)/.test(bar?.skills || ''), bar?.skills);
      check('disclaimer sits under the bar', /AI can be wrong/i.test(bar?.disclaimer || ''), bar?.disclaimer);
      await cdp.shot('00-composer-modes.png');

      // Plan is persisted on the chat row, not just painted in the UI.
      await cdp.evalJS(`[...document.querySelectorAll('.comp-modes .mode-btn')].find((b) => /plan/i.test(b.textContent)).click()`);
      await sleep(500);
      const planState = await cdp.evalJS(`(async () => {
        const cs = await window.inkwell.dbCall('listChats').then((r) => r.data);
        return { mode: cs[0].chat_mode, on: document.querySelector('.comp-modes .mode-btn.on')?.textContent.trim() || '' };
      })()`);
      check('choosing Plan writes chat_mode=plan', planState?.mode === 'plan' && /Plan/.test(planState?.on || ''), JSON.stringify(planState));

      await cdp.evalJS(`document.querySelector('.comp-modes .agent-toggle').click()`);
      await sleep(500);
      const agentState = await cdp.evalJS(`(async () => {
        const cs = await window.inkwell.dbCall('listChats').then((r) => r.data);
        return { on: cs[0].agent_mode, pressed: document.querySelector('.comp-modes .agent-toggle')?.getAttribute('aria-pressed') };
      })()`);
      check('agent mode toggles on and is stored', agentState?.on === 1 && agentState?.pressed === 'true', JSON.stringify(agentState));
      await cdp.shot('00b-agent-on.png');

      // "/skill" is skill search now, not the prompt library.
      await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta, '/skill');})()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.prompt-menu .skill-cmd')`), 5000, 'skill menu');
      const skillMenu = await cdp.evalJS(`document.querySelector('.prompt-menu')?.textContent || ''`);
      check('typing /skill lists the shipped skills', /Dialogue Coach/.test(skillMenu), skillMenu.slice(0, 120));
      await cdp.shot('00c-skill-menu.png');
      await cdp.evalJS(`[...document.querySelectorAll('.prompt-menu .skill-cmd')].find((b) => /Dialogue Coach/.test(b.textContent)).click()`);
      await sleep(600);
      const skillOn = await cdp.evalJS(`(async () => {
        const cs = await window.inkwell.dbCall('listChats').then((r) => r.data);
        return { ids: JSON.parse(cs[0].skills_on || '[]'), input: document.querySelector('.comp-box textarea').value, label: document.querySelector('.comp-modes .ability-btn')?.textContent || '' };
      })()`);
      check('/skill/<name> switches the skill on for the chat', Array.isArray(skillOn?.ids) && skillOn.ids.includes('skill-dialogue'), JSON.stringify(skillOn));
      check('/skill clears the draft and shows one active skill', skillOn?.input === '' && /\(1\)/.test(skillOn?.label || ''), JSON.stringify(skillOn));
      await cdp.shot('00d-skill-on.png');

      // The popover still lists every skill and links to Settings.
      await cdp.evalJS(`document.querySelector('.comp-modes .ability-btn').click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.ui-popover')`), 5000, 'skills popover');
      const skills = await cdp.evalJS(`(document.querySelector('.ui-popover')?.textContent || '') + '|' + !!document.querySelector('.skills-manage')`);
      check('skills popover lists the shipped skills', /Beta Reader/.test(skills) && /Continuity Guardian/.test(skills), skills.slice(0, 80));
      check('skills popover links to Settings', /\|true$/.test(skills));
      await cdp.pressKey('Escape', { code: 'Escape', vk: 27 });

      // Leave the chat in its normal state for the rest of the suite.
      await cdp.evalJS(`[...document.querySelectorAll('.comp-modes .mode-btn')].find((b) => /write/i.test(b.textContent)).click()`);
      await cdp.evalJS(`document.querySelector('.comp-modes .agent-toggle').click()`);
      await sleep(300);
    });

    await run('draft token estimate + context meter', async () => {
      // The /skill step above deliberately emptied the draft, so seed one.
      await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta, 'Hello world, this is a draft.');})()`);
      await sleep(200);
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

      // v1.2.5 keeps the bar faintly visible on purpose (the variant arrows
      // are navigation, not a secret) and only brightens it on hover/focus,
      // so "quiet" means clearly dimmed rather than fully transparent.
      const opacityBefore = Number(await cdp.evalJS(`getComputedStyle(document.querySelector('.msg.assistant .actions')).opacity`));
      await cdp.evalJS(`[...document.querySelectorAll('.msg.assistant .actions button')].find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || '')).focus()`);
      // The brightening is a 150ms transition; poll instead of assuming an
      // exact frame, and report the last value if it never settles at 1.
      let opacityAfter = 0;
      for (let i = 0; i < 40 && opacityAfter !== 1; i++) {
        await sleep(50);
        opacityAfter = Number(await cdp.evalJS(`getComputedStyle(document.querySelector('.msg.assistant .actions')).opacity`));
      }
      check('action bar is quiet until focused', opacityBefore > 0 && opacityBefore < 0.75, String(opacityBefore));
      check('action bar appears for keyboard users', opacityAfter === 1, String(opacityAfter));
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
        text: document.querySelector('.msg.assistant .content').textContent,
        nav: document.querySelector('.msg.assistant .variant-nav .vn-count')?.textContent || ''
      })`);
      check('one bubble per turn — the old reply is hidden, not appended', shape.users === 1 && shape.assistants === 1, JSON.stringify(shape));
      check('regenerated text is the fresh answer', shape.text.includes('GUI reply two'), shape.text);
      // v1.2.5: the previous answer is kept as a variant instead of deleted.
      check('variant arrows appear after regenerating', shape.nav === '2/2', shape.nav);

      await cdp.evalJS(`document.querySelector('.msg.assistant .variant-nav .vn-btn')?.click()`);
      await sleep(300);
      const restored = await cdp.evalJS(`({
        text: document.querySelector('.msg.assistant .content').textContent,
        nav: document.querySelector('.msg.assistant .variant-nav .vn-count')?.textContent || '',
        users: document.querySelectorAll('.msg.user').length
      })`);
      check('previous variant can be shown again', restored.text.includes('GUI reply one') && restored.nav === '1/2', JSON.stringify(restored));
      check('switching variants does not duplicate the user turn', restored.users === 1, String(restored.users));

      const lastSent = reqBodies[reqBodies.length - 1].messages.slice(-1)[0];
      check('regeneration resends the same user turn', lastSent?.role === 'user' && lastSent?.content === 'Hello GUI', JSON.stringify(lastSent).slice(0, 120));

      const rows = await cdp.evalJS(`(async () => {
        const cs = await window.inkwell.dbCall('listChats').then((r) => r.data);
        const ms = await window.inkwell.dbCall('getMessages', { chatId: cs[0].id }).then((r) => r.data);
        return ms.map((m) => m.role).join(',');
      })()`);
      check('DB keeps both replies as variants of one turn', rows === 'user,assistant,assistant', rows);
    });

    await run('variants across turns + reload', async () => {
      // Second turn -> reply three.
      await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta, 'Second GUI');})()`);
      await cdp.evalJS(`document.querySelector('.send-btn').click()`);
      await waitUntil(() => cdp.evalJS(`document.querySelectorAll('.msg.assistant').length === 2 && !document.querySelector('.msg.assistant.streaming')`), 30000, 'second reply');
      await sleep(300);

      const fresh = await cdp.evalJS(`(() => {
        const ms = [...document.querySelectorAll('.msg.assistant')];
        return { count: ms.length, first: ms[0].querySelector('.content').textContent, nav: ms[1].querySelector('.variant-nav') ? 'shown' : 'none' };
      })()`);
      check('a second turn renders as its own bubble', fresh.count === 2, JSON.stringify(fresh));
      check('the first turn keeps its chosen variant', fresh.first.includes('GUI reply one'), fresh.first);
      check('a single reply shows no variant arrows', fresh.nav === 'none', fresh.nav);

      // Regenerate the LAST turn twice -> three answers for that turn only.
      for (const want of ['GUI reply four', 'GUI reply five']) {
        const before = reqBodies.length;
        await cdp.evalJS(`(() => { const m = document.querySelectorAll('.msg.assistant')[1]; [...m.querySelectorAll('.actions button')].find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || '')).click(); })()`);
        await waitUntil(async () => reqBodies.length > before, 15000, 'variant request');
        await waitUntil(() => cdp.evalJS(`(document.querySelectorAll('.msg.assistant')[1]?.textContent || '').includes('${want}')`), 30000, want);
        // The next click needs the finished bubble (the streaming one has no
        // action bar), so wait for the turn to settle before going again.
        await waitUntil(() => cdp.evalJS(`!document.querySelector('.msg.assistant.streaming')`), 30000, 'variant stream end');
      }
      await sleep(300);

      const shape = await cdp.evalJS(`(() => {
        const ms = [...document.querySelectorAll('.msg.assistant')];
        return {
          count: ms.length,
          nav: ms[1].querySelector('.variant-nav .vn-count')?.textContent || '',
          text: ms[1].querySelector('.content').textContent,
          firstNav: ms[0].querySelector('.variant-nav .vn-count')?.textContent || ''
        };
      })()`);
      check('three answers still render as one bubble', shape.count === 2, JSON.stringify(shape));
      check('newest variant is active after regenerating', shape.nav === '3/3' && shape.text.includes('GUI reply five'), JSON.stringify(shape));
      check('an untouched turn keeps its own variant list', shape.firstNav === '1/2', shape.firstNav);

      await cdp.evalJS(`document.querySelectorAll('.msg.assistant')[1].querySelector('.variant-nav .vn-btn').click()`);
      await sleep(300);
      const prev = await cdp.evalJS(`(() => {
        const m = document.querySelectorAll('.msg.assistant')[1];
        return { text: m.querySelector('.content').textContent, nav: m.querySelector('.variant-nav .vn-count')?.textContent || '' };
      })()`);
      check('older variant can be shown again', prev.text.includes('GUI reply four') && prev.nav === '2/3', JSON.stringify(prev));

      // Reload the transcript from the DB (chat switch) and flip again: the
      // parent link has to survive the round-trip or arrows die after a restart.
      await cdp.evalJS(`(async () => {
        const st = window.useData.getState();
        const id = st.activeChatId;
        st.setActiveChat(null);
        await new Promise((r) => setTimeout(r, 250));
        st.setActiveChat(id);
      })()`);
      await waitUntil(() => cdp.evalJS(`document.querySelectorAll('.msg.assistant').length === 2 && !!document.querySelector('.msg.assistant .variant-nav')`), 15000, 'variants after reload');
      const after = await cdp.evalJS(`(() => {
        const ms = [...document.querySelectorAll('.msg.assistant')];
        return { nav: ms[1].querySelector('.variant-nav .vn-count')?.textContent || '', firstNav: ms[0].querySelector('.variant-nav .vn-count')?.textContent || '' };
      })()`);
      check('variants survive reloading the chat', after.nav === '3/3', JSON.stringify(after));
      await cdp.evalJS(`document.querySelectorAll('.msg.assistant')[1].querySelector('.variant-nav .vn-btn').click()`);
      await sleep(300);
      const reloaded = await cdp.evalJS(`document.querySelectorAll('.msg.assistant')[1].querySelector('.content').textContent`);
      check('arrows still switch after reload', reloaded.includes('GUI reply four'), reloaded);

      // Regenerating an EARLIER turn keeps its variants and drops the turns
      // that followed it (documented "regenerate from here" behavior).
      const before = reqBodies.length;
      await cdp.evalJS(`(() => { const m = document.querySelectorAll('.msg.assistant')[0]; [...m.querySelectorAll('.actions button')].find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || '')).click(); })()`);
      await waitUntil(async () => reqBodies.length > before, 15000, 'early-turn request');
      await waitUntil(() => cdp.evalJS(`document.querySelectorAll('.msg.assistant').length === 1 && !document.querySelector('.msg.assistant.streaming')`), 30000, 'truncated transcript');
      await sleep(300);
      const truncated = await cdp.evalJS(`(() => {
        const ms = [...document.querySelectorAll('.msg.assistant')];
        return { count: ms.length, nav: ms[0].querySelector('.variant-nav .vn-count')?.textContent || '', text: ms[0].querySelector('.content').textContent };
      })()`);
      check('regenerating an early turn drops the later turns', truncated.count === 1, JSON.stringify(truncated));
      check('the early turn gains the new answer as its newest variant', truncated.nav === '3/3' && truncated.text.includes('GUI reply six'), JSON.stringify(truncated));
    });

    await run('edit forks a prompt version, restart count resets', async () => {
      await cdp.shot('01-before-edit.png');

      // Three restarts already exist on this turn. Those belong to the ANSWER
      // axis; the prompt was never edited, so it has no arrows yet.
      const beforeEdit = await cdp.evalJS(`(() => ({
        userText: document.querySelector('.msg.user .content').textContent.trim(),
        userNav: document.querySelector('.msg.user .variant-nav') ? 'shown' : 'none',
        aiNav: document.querySelector('.msg.assistant .variant-nav .vn-count')?.textContent || ''
      }))()`);
      check('an unedited prompt has no prompt arrows', beforeEdit.userNav === 'none', JSON.stringify(beforeEdit));
      check('restarts are counted on the reply only', beforeEdit.aiNav === '3/3', JSON.stringify(beforeEdit));

      // Pencil on the user bubble -> rewrite the text -> Save & resend.
      await cdp.evalJS(`[...document.querySelectorAll('.msg.user .actions button')][1].click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.edit-box textarea')`), 8000, 'edit box');
      await cdp.evalJS(`(function(){var ta=document.querySelector('.edit-box textarea');${setReactArea}(ta, 'ide cerita bukan bikin project bro?');})()`);
      await sleep(150);
      await cdp.evalJS(`document.querySelector('.edit-box .edit-actions .primary').click()`);

      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.msg.assistant.streaming')`), 10000, 'streaming reply');
      const during = await cdp.evalJS(`(() => ({
        assistants: document.querySelectorAll('.msg.assistant').length,
        streaming: document.querySelectorAll('.msg.assistant.streaming').length,
        users: document.querySelectorAll('.msg.user').length,
        userText: document.querySelector('.msg.user .content').textContent,
        stale: /GUI reply/.test(document.querySelector('.messages').textContent)
      }))()`);
      await cdp.shot('02-edit-streaming.png');
      check('the old answers are hidden while the new version streams', during.assistants === 1 && during.streaming === 1, JSON.stringify(during));
      check('no stale reply leaks in during the resend', during.stale === false, JSON.stringify(during));
      check('the new prompt version is on screen immediately', during.userText.trim() === 'ide cerita bukan bikin project bro?', during.userText);

      await waitUntil(() => cdp.evalJS(`!document.querySelector('.msg.assistant.streaming') && !!document.querySelector('.msg.user .variant-nav')`), 30000, 'new version settled');
      await sleep(300);
      const done = await cdp.evalJS(`(() => {
        const ms = [...document.querySelectorAll('.msg.assistant')];
        return {
          users: document.querySelectorAll('.msg.user').length,
          assistants: ms.length,
          userText: document.querySelector('.msg.user .content').textContent.trim(),
          userNav: document.querySelector('.msg.user .variant-nav .vn-count')?.textContent || '',
          aiNav: ms[0]?.querySelector('.variant-nav') ? 'shown' : 'none',
          text: ms[0]?.querySelector('.content').textContent || ''
        };
      })()`);
      await cdp.shot('03-edit-done.png');
      check('the edit keeps one prompt bubble', done.users === 1, JSON.stringify(done));
      check('the prompt now carries its own version arrows', done.userNav === '2/2', JSON.stringify(done));
      check('the new version starts with ONE answer (restart count reset)', done.aiNav === 'none', JSON.stringify(done));
      check('the new answer is rendered', done.text.includes('GUI reply seven'), JSON.stringify(done));

      // Prompt arrow back: the ORIGINAL text and its three answers survive.
      await cdp.evalJS(`document.querySelector('.msg.user .variant-nav .vn-btn').click()`);
      await sleep(300);
      const first = await cdp.evalJS(`(() => {
        const m = document.querySelector('.msg.assistant');
        return {
          userText: document.querySelector('.msg.user .content').textContent.trim(),
          userNav: document.querySelector('.msg.user .variant-nav .vn-count')?.textContent || '',
          aiNav: m?.querySelector('.variant-nav .vn-count')?.textContent || '',
          text: m?.querySelector('.content').textContent || ''
        };
      })()`);
      await cdp.shot('04-prompt-version-one.png');
      check('the original prompt is still there', first.userText === 'Hello GUI', JSON.stringify(first));
      check('its own answers were never reset', first.aiNav === '3/3', JSON.stringify(first));
      check('its own answer text is back', first.text.includes('GUI reply six'), JSON.stringify(first));

      // A restart inside version 1 must not touch version 2 at all.
      const before = reqBodies.length;
      await cdp.evalJS(`(() => { const m = document.querySelector('.msg.assistant'); [...m.querySelectorAll('.actions button')].find((x) => /regenerate from here/i.test(x.getAttribute('aria-label') || '')).click(); })()`);
      await waitUntil(async () => reqBodies.length > before, 15000, 'v1 restart request');
      await waitUntil(() => cdp.evalJS(`!document.querySelector('.msg.assistant.streaming')`), 30000, 'v1 restart end');
      await sleep(300);
      const v1 = await cdp.evalJS(`(() => ({
        aiNav: document.querySelector('.msg.assistant .variant-nav .vn-count')?.textContent || '',
        userNav: document.querySelector('.msg.user .variant-nav .vn-count')?.textContent || '',
        users: document.querySelectorAll('.msg.user').length
      }))()`);
      check("a restart only grows that version's answer list", v1.aiNav === '4/4', JSON.stringify(v1));
      check('the prompt axis is unaffected by a restart', v1.userNav === '1/2' && v1.users === 1, JSON.stringify(v1));

      // Back to version 2: still exactly one answer, untouched.
      await cdp.evalJS(`document.querySelectorAll('.msg.user .variant-nav .vn-btn')[1].click()`);
      await sleep(300);
      const second = await cdp.evalJS(`(() => ({
        userText: document.querySelector('.msg.user .content').textContent.trim(),
        userNav: document.querySelector('.msg.user .variant-nav .vn-count')?.textContent || '',
        aiNav: document.querySelector('.msg.assistant .variant-nav') ? 'shown' : 'none',
        text: document.querySelector('.msg.assistant .content').textContent
      }))()`);
      await cdp.shot('05-prompt-version-two.png');
      check('version 2 keeps its own single answer', second.userText === 'ide cerita bukan bikin project bro?' && second.userNav === '2/2' && second.aiNav === 'none', JSON.stringify(second));
      check('version 2 text is untouched by the restart on version 1', second.text.includes('GUI reply seven'), JSON.stringify(second));

      const stored = await cdp.evalJS(`(async () => {
        const cs = await window.inkwell.dbCall('listChats').then((r) => r.data);
        const ms = await window.inkwell.dbCall('getMessages', { chatId: cs[0].id }).then((r) => r.data);
        const users = ms.filter((m) => m.role === 'user');
        return {
          users: users.map((m) => m.content),
          linked: users.length === 2 && users[1].parent_id === users[0].id,
          replies: ms.filter((m) => m.role === 'assistant').length
        };
      })()`);
      check('both prompt versions are stored and linked', stored.linked === true && stored.users[0] === 'Hello GUI', JSON.stringify(stored));
      check('every answer is still stored', stored.replies === 5, JSON.stringify(stored));
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

    // Narrow-window About (Settings → About). A card that pushes the pane
    // sideways is a real bug that no typecheck can see, so this measures the
    // rendered rectangles and keeps a screenshot of the actual window.
    await run('about: narrow window, nothing overflows', async () => {
      await cdp.evalJS(`window.useData.getState().navigate('settings')`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.settings-nav')`), 15000, 'settings nav');
      await cdp.evalJS(`[...document.querySelectorAll('.settings-nav button')].find((b) => /about/i.test(b.textContent))?.click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.about-settings .about-grid')`), 10000, 'about section');

      for (const width of [820, 560]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false });
        await sleep(450);
        const box = await cdp.evalJS(`(() => {
          const pane = document.querySelector('.settings-content');
          const escapes = [...document.querySelectorAll('.about-settings *')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); })
            .map((el) => (typeof el.className === 'string' && el.className) || el.tagName)
            .slice(0, 6);
          return {
            innerW: window.innerWidth,
            docW: document.documentElement.scrollWidth,
            paneW: pane ? pane.clientWidth : 0,
            paneScrollW: pane ? pane.scrollWidth : 0,
            escapes
          };
        })()`);
        check(`about fits at ${width}px (nothing escapes the window)`, box.escapes.length === 0 && box.docW <= box.innerW + 1, JSON.stringify(box));
        check(`about pane does not scroll sideways at ${width}px`, box.paneScrollW <= box.paneW + 1, JSON.stringify(box));
        await cdp.shot(`05-about-${width}.png`);
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    });

    // The sidebar About page renders from a different component (AboutView),
    // so it needs the same measurement — a fix in Settings → About does not
    // reach it.
    await run('about page: narrow window, nothing clips', async () => {
      await cdp.evalJS(`[...document.querySelectorAll('.nav-item, .sidebar-footer button')].find((b) => /about/i.test(b.textContent))?.click()`);
      await waitUntil(() => cdp.evalJS(`!!document.querySelector('.about-page')`), 15000, 'about page');
      for (const width of [820, 560]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false });
        await sleep(450);
        const box = await cdp.evalJS(`(() => {
          const page = document.querySelector('.about-page');
          const escapes = [...document.querySelectorAll('.about-page *')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); })
            .map((el) => (typeof el.className === 'string' && el.className) || el.tagName)
            .slice(0, 8);
          return {
            innerW: window.innerWidth,
            docW: document.documentElement.scrollWidth,
            pageW: page ? page.clientWidth : 0,
            pageScrollW: page ? page.scrollWidth : 0,
            escapes
          };
        })()`);
        check(`about page fits at ${width}px (nothing escapes the window)`, box.escapes.length === 0 && box.docW <= box.innerW + 1, JSON.stringify(box));
        check(`about page does not scroll sideways at ${width}px`, box.pageScrollW <= box.pageW + 1, JSON.stringify(box));
        await cdp.shot(`06-about-page-${width}.png`);
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
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
