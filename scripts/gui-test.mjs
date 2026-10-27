/**
 * GUI end-to-end test (ASCII only).
 * Boots vite + electron (isolated APPDATA), connects via CDP, drives the real UI:
 * streaming chat + agent tool use, project modal, rename, command palette,
 * Prompt Library (/ menu, custom prompts CRUD, save-composer-text).
 * Run: node scripts/gui-test.mjs
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
const seenBodies = [];
let seenToolRound = false; // one tool-call round per test run
// The capability probe measures the context window with an echo ladder: each
// rung asks for this marker back. Echoing it makes every rung pass, so the
// card has a deterministic number (~131k) to display.
const PROBE_MARKER = 'XQ7MARKER42';
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-gui' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    console.log('  [mock] POST /chat/completions');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seenBodies.push(parsed);
      // Content-based trigger: the tool round happens ONLY for the chat whose
      // last user message asks to remember something — verifications and other
      // chats can no longer steal the one-shot tool round by accident.
      const lastUser = [...(parsed.messages || [])].reverse().find((m) => m.role === 'user');
      const isMemoryChat = !!lastUser && /remember/i.test(lastUser.content || '');
      // Non-streaming probe (verifyModel): delay so the test can Stop the
      // sweep mid-flight and the abort path is genuinely exercised.
      if (parsed.stream === false) {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
          } catch { /* client aborted — socket already gone */ }
        }, 3000);
        return;
      }
      // Context-ladder rung: echo the marker verbatim. The probe reads these
      // bodies as plain JSON (it sets no `stream`), so answer in the shape it
      // asked for — an SSE body here would make JSON.parse throw and end the
      // ladder at the first rung.
      if ((lastUser?.content || '').includes(PROBE_MARKER)) {
        if (parsed.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: PROBE_MARKER } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: PROBE_MARKER }, finish_reason: 'stop' }] }));
        }
        return;
      }
      const round = seenBodies.length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (isMemoryChat && !seenToolRound) {
        seenToolRound = true;
        write({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_gui_1', type: 'function', function: { name: 'save_memory', arguments: '' } }] }, finish_reason: null }] });
        write({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"content":"GUI test memory"}' } }] }, finish_reason: null }] });
        write({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const words = ['Streaming', ' works', ' in', ' the', ' real', ' GUI', '!'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) { write({ choices: [{ delta: { content: words[i] }, finish_reason: null }] }); i++; }
          else { write({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); clearInterval(timer); res.end(); }
        }, 50);
        res.on('close', () => clearInterval(timer));
      }
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

// ---------- CDP with proper lifecycle handling ----------
async function connectCdp(port) {
  // The /json/list endpoint can briefly return an empty target list while the
  // renderer is still booting, and an about:blank page target exists before the
  // window navigates — binding to it makes every query return null. Poll until
  // the dev-server URL is actually loaded.
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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
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
    async evalJS(expr) {
      const r = await withTimeout(
        send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }),
        15000, expr.slice(0, 80)
      );
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result?.value;
    },
    close: () => { try { ws.close(); } catch {} }
  };
}

const setReactInput = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;
const plaintextHit = (idx) => idx === -1 ? '' : 'PLAINTEXT KEY FOUND in DB file';
const setReactArea = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;
const setReactSelect = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('change',{bubbles:true}));})`;

// ---------- main ----------
(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: GUI test timed out'); process.exit(2); }, 240000);
  // kill leftovers from previous runs (stale vite/electron cause HMR reloads
  // and stale CDP targets mid-test)
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('netstat -ano | findstr :5173 | findstr LISTENING', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p)))];
    for (const pid of pids) { try { execSync('taskkill /F /PID ' + pid, { shell: 'cmd.exe' }); console.log('killed leftover vite pid ' + pid); } catch {} }
  } catch { /* nothing listening */ }
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); console.log('killed leftover electron'); } catch { /* none */ }
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-gui-'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mockPort = server.address().port;
  console.log('mock provider: http://127.0.0.1:' + mockPort + '/v1');
  console.log('isolated APPDATA: ' + tmpAppData + '\n');

  // Spawn the vite binary directly: killing an `npx` wrapper leaves the node
  // server orphaned and the next run silently reuses a stale dev server.
  const vite = spawn(process.execPath, [path.join(PROJ, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'], { stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9300 + Math.floor(Math.random() * 400);
  // Windows resolves %APPDATA% through the known-folder API and ignores the
  // env override, so every run used to share one Chromium profile (and its
  // persisted route). --user-data-dir makes the isolation real.
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '--user-data-dir=' + tmpAppData, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
  });
  let elOut = '';
  electron.stdout.on('data', (d) => { elOut += d; if (elOut.length > 4000) elOut = elOut.slice(-2000); });
  electron.stderr.on('data', (d) => { elOut += d; if (elOut.length > 4000) elOut = elOut.slice(-2000); });
  electron.on('exit', (code) => {
    if (!cleaningUp) { console.error('ELECTRON EXITED code=' + code + '\n' + elOut.slice(-1500)); process.exit(3); }
  });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  const cdp = await connectCdp(cdpPort);
  console.log('CDP connected\n');
  let cleaningUp = false;

  const run = async (label, fn) => {
    console.log('[' + label + ']');
    try { await fn(); } catch (e) { failures++; console.error('  FAIL: ' + label + ' threw: ' + String(e.message || e).slice(0, 300)); }
  };

  await run('boot', async () => {
    // fail fast if this instance is somehow contaminated
    const counts = await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll');return 'fresh';})()");
    check('isolated DB confirmed (' + counts + ')', counts === 'fresh');
    try {
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'welcome screen');
    } catch (e) {
      const diag = await cdp.evalJS(`(async () => ({
        route: window.useData?.getState().route,
        chats: window.useData?.getState().chats.length,
        activeChatId: window.useData?.getState().activeChatId,
        welcomePage: !!document.querySelector('.welcome-page'),
        settings: !!document.querySelector('.settings-content'),
        position: localStorage.getItem('openplot.position.v1'),
        dataPath: (await window.inkwell.appInfo()).dataPath,
        text: document.body.innerText.slice(0, 160)
      }))()`);
      console.error('  boot diag: ' + JSON.stringify(diag));
      throw e;
    }
    check('welcome screen rendered', true);
    // With no provider configured the FIRST card is "Connect a model" (it
    // opens Settings), so pick a quick-start card that actually opens a chat.
    const started = await cdp.evalJS("(function(){var c=document.querySelector('.welcome-card:not(.primary)');if(!c)return false;c.click();return true;})()");
    if (!started) throw new Error('no quick-start card available');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.chat-header .title')"), 15000, 'chat view');
    check('chat opened via welcome card', true);
  });

  await run('send without provider shows error toast', async () => {
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'Hello');})()`);
    await cdp.evalJS("document.querySelector('.send-btn').click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.toast')"), 8000, 'toast');
    const toast = await cdp.evalJS("document.querySelector('.toast').textContent");
    check('no-provider/no-model toast shown', /provider|model/i.test(toast), toast);
  });

  await run('open settings via palette', async () => {
    await cdp.evalJS("window.__inkwellOpenPalette()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 5000, 'palette open');
    await cdp.evalJS(`(function(){var i=document.querySelector('.palette input');${setReactInput}(i,'settings');})()`);
    await sleep(200);
    await cdp.evalJS("document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.settings-content')"), 10000, 'settings page');
    const btns = await cdp.evalJS("[...document.querySelectorAll('.settings-content h1')].map(h=>h.textContent).join('|')");
    console.log('  settings section: ' + btns);
  });

  await run('settings: add provider via UI', async () => {
    // The presets card ALSO has a primary "Add" button (disabled until a
    // preset is picked) — target the enabled "Add provider" button only.
    const added = await cdp.evalJS("(function(){var bs=[...document.querySelectorAll('.settings-content button.primary')].filter(b=>!b.disabled);var b=bs.find(x=>/add provider/i.test(x.textContent))||bs.find(x=>/^add/i.test(x.textContent.trim()));if(!b)return false;b.click();return true;})()");
    if (!added) {
      const all = await cdp.evalJS("[...document.querySelectorAll('.settings-content button')].map(b=>b.textContent+'('+(b.disabled?'off':'on')+')').join('|')");
      throw new Error('Add button not found; buttons: ' + all);
    }
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.provider-card')"), 10000, 'provider card');
    // Fill the form and press Test in ONE task: every discrete input event is
    // flushed before the click, so the handler cannot run with a stale (empty)
    // provider object. Splitting these into separate CDP calls used to drop the
    // typed key now and then, which surfaced three checks downstream as a
    // confusing "key decrypts" failure.
    const configured = await cdp.evalJS(`(function(){
      var c = document.querySelector('.provider-card');
      var head = c.querySelector('.head input[type=text], .head input:not([type])');
      var ins = c.querySelectorAll('.grid input');
      ${setReactInput}(head, 'Mock');
      ${setReactInput}(ins[0], 'http://127.0.0.1:${mockPort}/v1');
      ${setReactInput}(ins[1], 'sk-test');
      var test = [...c.querySelectorAll('.head button')].find(function(b){ return /test/i.test(b.textContent); });
      if (!test) return 'no-test-button';
      test.click();
      return 'clicked';
    })()`);
    check('provider form filled and tested', configured === 'clicked', String(configured));
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.model-tag')].some(m=>m.textContent.includes('mock-gui'))"), 20000, 'models fetched');
    check('models fetched into UI (mock-gui)', true);
    // The key must be in the row the app reads — assert it here, next to the
    // step that writes it, instead of three checks later.
    await waitUntil(() => cdp.evalJS("window.inkwell.dbCall('listProviders').then(rs=>rs.data.some(p=>(p.api_key??p.apiKey)==='sk-test'))"), 15000, 'provider key persisted');
    check('typed api key persisted with the provider', true);

    // Smart configuration card (v1.2.3 Task 2 UI). Nothing has probed mock-gui
    // yet, so every row that needs evidence must read "unknown" rather than a
    // plausible number.
    const card = await cdp.evalJS(`(function(){
      var c = document.querySelector('.provider-card .caps-card');
      if (!c) return null;
      var dd = c.querySelector('dd');
      return {
        rows: [...c.querySelectorAll('dt')].map(function(d){ return d.textContent.trim(); }).join('|'),
        context: dd ? dd.textContent.trim() : '',
        buttons: [...c.querySelectorAll('button')].map(function(b){ return b.textContent.trim(); }).join('|'),
        summary: c.querySelector('.caps-summary') ? c.querySelector('.caps-summary').textContent.trim() : ''
      };
    })()`);
    check('model card renders the four capability rows',
      !!card && card.rows === 'Context|Max output|Reasoning|Prompt cache', JSON.stringify(card));
    check('model card says unknown before any probe',
      !!card && card.context === 'unknown' && /Context window unknown/.test(card.summary) && !/~\d/.test(card.summary),
      JSON.stringify(card));
    check('model card offers Verify', !!card && /Verify/.test(card.buttons), JSON.stringify(card));
  });

  await run('settings: grouped nav, models table, search, advanced mode', async () => {
    const groups = await cdp.evalJS("[...document.querySelectorAll('.settings-group-label')].map(function(g){return g.textContent.trim();}).join('|')");
    check('nav is grouped by area', /AI/.test(groups) && /Chat/.test(groups), groups);

    // Models section: the mock provider's model must be listed even though
    // nothing has probed it yet.
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(function(b){return /^models$/i.test(b.textContent.trim());}).click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.model-table')"), 10000, 'models table');
    const row = await cdp.evalJS(`(function(){
      var r = document.querySelector('.model-table tbody tr');
      if (!r) return null;
      return {
        model: r.querySelector('code') ? r.querySelector('code').textContent.trim() : '',
        provider: r.querySelector('small') ? r.querySelector('small').textContent.trim() : '',
        cells: [...r.querySelectorAll('td')].map(function(td){ return td.textContent.trim(); })
      };
    })()`);
    check('models table lists the connected model', !!row && row.model === 'mock-gui' && row.provider === 'Mock', JSON.stringify(row));
    check('models table says unknown before a probe', !!row && /—/.test(row.cells[1]), JSON.stringify(row));
    check('models table offers Set as default', !!row && /Set as default/i.test(row.cells[row.cells.length - 1]), JSON.stringify(row));

    // Global settings search: type, get grouped hits, Enter jumps to a control.
    await cdp.evalJS(`(function(){var i=document.querySelector('.settings-search input');${setReactInput}(i,'cache');})()`);
    await waitUntil(() => cdp.evalJS("document.querySelectorAll('.settings-result').length > 0"), 8000, 'settings search results');
    const hits = await cdp.evalJS("[...document.querySelectorAll('.settings-result')].map(function(b){return b.getAttribute('data-id');}).join('|')");
    check('settings search finds the cache controls',
      /set-model-table/.test(hits) || /set-usage-totals/.test(hits), hits);
    await cdp.evalJS("document.querySelector('.settings-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await waitUntil(() => cdp.evalJS("!document.querySelector('.settings-search input').value"), 5000, 'search cleared');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.flash')"), 5000, 'target flashed');
    check('Enter opens and highlights the matched control', true);

    // Simple → Advanced reveals the Extend group and the sampling controls.
    check('simple mode hides the Extend group',
      !(await cdp.evalJS("[...document.querySelectorAll('.settings-group-label')].some(function(g){return /extend/i.test(g.textContent);})")));
    await cdp.evalJS("document.querySelector('.settings-mode-toggle').click()");
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.settings-group-label')].some(function(g){return /extend/i.test(g.textContent);})"), 5000, 'extend group');
    check('advanced mode reveals the Extend group', true);
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(function(b){return /behavior/i.test(b.textContent.trim());}).click()");
    await waitUntil(() => cdp.evalJS("!!document.getElementById('set-top-p')"), 5000, 'top-p control');
    check('advanced mode reveals sampling and thinking budget',
      await cdp.evalJS("!!document.getElementById('set-top-p') && !!document.getElementById('set-thinking-budget')"));

    // The palette exposes every section by name.
    await cdp.evalJS("window.__inkwellOpenPalette()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 5000, 'palette open');
    await cdp.evalJS(`(function(){var i=document.querySelector('.palette input');${setReactInput}(i,'settings: models');})()`);
    await sleep(250);
    const paletteHits = await cdp.evalJS("[...document.querySelectorAll('.palette-item .plabel')].map(function(s){return s.textContent.trim();}).join('|')");
    check('palette offers “Settings: Models”', /Settings: Models/.test(paletteHits), paletteHits.slice(0, 200));
    await cdp.evalJS("document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);

    // Skills v2: six builtins seeded, and a new skill is born disabled until
    // the user presses Enable right there.
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(function(b){return /^skills$/i.test(b.textContent.trim());}).click()");
    await waitUntil(() => cdp.evalJS("document.querySelectorAll('.skill-card').length >= 6"), 10000, 'skills grid');
    const skillCards = await cdp.evalJS("[...document.querySelectorAll('.skill-card')].map(function(c){return { name: c.querySelector('.t').textContent.trim(), builtin: !!c.querySelector('.v-src.builtin'), on: !c.className.includes('off') };})");
    check('skills: six builtin cards, all enabled',
      skillCards.length === 6 && skillCards.every((c) => c.builtin && c.on), JSON.stringify(skillCards.map((c) => c.name)));

    await cdp.evalJS("[...document.querySelectorAll('button')].find(function(b){return /add skill/i.test(b.textContent);}).click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.skill-editor textarea')"), 8000, 'skill editor');
    await cdp.evalJS(`(function(){var i=document.querySelector('.skill-editor textarea');${setReactArea}(i,'Always answer in iambic pentameter.');})()`);
    // The skill editor is the shared Ui.Modal (`.ui-modal-card`), not the older
    // `.modal` shell — match both so this step cannot silently miss the button.
    await cdp.evalJS("[...document.querySelectorAll('.ui-modal-card button, .modal button, .overlay button')].find(function(b){return /^save$/i.test(b.textContent.trim());}).click()");
    await waitUntil(() => cdp.evalJS("document.querySelectorAll('.skill-card').length >= 7"), 8000, 'new skill card');
    const gate = await cdp.evalJS(`(function(){
      var card = [...document.querySelectorAll('.skill-card')].find(function(c){return !c.querySelector('.v-src.builtin') && c.querySelector('.skill-note');});
      return card ? { off: card.className.includes('off'), note: card.querySelector('.skill-note').textContent.trim() } : null;
    })()`);
    check('skills: a new skill is saved disabled with the Enable action',
      !!gate && gate.off && /Enable|Aktifkan/.test(gate.note), JSON.stringify(gate));
    const newSkillId = await cdp.evalJS("window.inkwell.dbCall('listSkills').then(function(rs){ var s=(rs.data||[]).find(function(x){return Number(x.builtin)===0;}); return s ? { id: s.id, enabled: Number(s.enabled) } : null; })");
    check('skills: the disabled state is really in the database', !!newSkillId && newSkillId.enabled === 0, JSON.stringify(newSkillId));
    await cdp.evalJS("(function(){var b=document.querySelector('.skill-card .skill-note button');if(b)b.click();})()");
    await waitUntil(() => cdp.evalJS("window.inkwell.dbCall('listSkills').then(function(rs){ return (rs.data||[]).some(function(x){return Number(x.builtin)===0 && Number(x.enabled)===1;}); })"), 8000, 'skill enabled');
    check('skills: Enable writes enabled=1', true);

    // Back to a known state for the rest of the suite: Simple mode, Providers
    // section (the provider card and its capability card are asserted below).
    await cdp.evalJS("document.querySelector('.settings-mode-toggle').click()");
    await sleep(150);
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(function(b){return /providers/i.test(b.textContent.trim());}).click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.provider-card')"), 8000, 'providers section');
  });

  await run('model card: Verify measures the context window', async () => {
    // End-to-end click: Verify → IPC probe (tools + SSE + echo ladder) → main
    // process registry → store reload → re-render. The card must trade
    // "unknown" for the measured number without a page reload.
    const clicked = await cdp.evalJS(`(function(){
      var c = document.querySelector('.provider-card .caps-card');
      if (!c) return false;
      var b = [...c.querySelectorAll('button')].find(function(x){ return /verif/i.test(x.textContent); });
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('card Verify button clicked', clicked === true);
    await waitUntil(() => cdp.evalJS(`(function(){
      var c = document.querySelector('.provider-card .caps-card');
      if (!c) return false;
      var dd = c.querySelectorAll('dd')[0];
      return !!dd && /~\\d/.test(dd.textContent);
    })()`), 45000, 'context window on the card');
    const after = await cdp.evalJS(`(function(){
      var c = document.querySelector('.provider-card .caps-card');
      var dds = c.querySelectorAll('dd');
      return {
        context: dds[0] ? dds[0].textContent.trim() : '',
        cache: dds[3] ? dds[3].textContent.trim() : '',
        summary: c.querySelector('.caps-summary') ? c.querySelector('.caps-summary').textContent.trim() : '',
        buttons: [...c.querySelectorAll('button')].map(function(b){ return b.textContent.trim(); }).join('|')
      };
    })()`);
    check('card shows the probed context window', /^~131(\.\d)?k tok$/.test(after.context), JSON.stringify(after));
    check('a local endpoint reports no prompt cache', /not available/.test(after.cache), JSON.stringify(after));
    check('card summary states the measured window',
      /Context window 131072 tokens/.test(after.summary), JSON.stringify(after));
    check('Verify becomes Verify again, Apply appears',
      /Verify again/.test(after.buttons) && /Apply smart/.test(after.buttons), JSON.stringify(after));
    // The evidence lives in the main process, not only in React state.
    const persisted = await cdp.evalJS(`window.inkwell.dbCall('getAllSettings',{}).then(function(r){
      var rows = (r && r.data) || r || {};
      var raw = rows['modelCaps'];
      if (!raw) return 0;
      var map = JSON.parse(raw);
      var rec = map[Object.keys(map)[0]];
      return rec && rec.caps ? rec.caps.contextTokens : 0;
    })`);
    check('probe result persisted in settings.modelCaps', Number(persisted) === 131072, String(persisted));
  });

  await run('api key encrypted at rest', async () => {
    // appInfo must report the OS credential vault is in use
    const enc = await cdp.evalJS("window.inkwell.appInfo().then(i=>i.encryption===true)");
    check('safeStorage reported available', enc === true, String(enc));
    // DB writes are debounced (~400ms) — force a flush by touching a row,
    // then give the persist timer room to fire before scanning the file.
    await cdp.evalJS("window.inkwell.dbCall('setSetting',{key:'__flush',value:'1'})");
    await sleep(900);
    // The raw DB file must NOT contain the plaintext key we just saved.
    // (Mock key 'sk-test' is distinctive enough to scan for.)
    const dbPath = await cdp.evalJS("window.inkwell.appInfo().then(i=>i.dataPath)");
    const raw = fs.readFileSync(path.join(String(dbPath), 'openplot.db'));
    const plainIdx = raw.indexOf(Buffer.from('sk-test', 'utf8'));
    check('raw DB file contains NO plaintext api key', plainIdx === -1, plaintextHit(plainIdx));
    // The app itself must still read the key back correctly (decrypted).
    // Raw dbCall rows use snake_case api_key; the store normalizes to apiKey.
    // Report the stored shape on failure: an empty key means the UI never
    // persisted what was typed, while `enc:v1:` here means decrypt returned ''.
    const stored = await cdp.evalJS("window.inkwell.dbCall('listProviders').then(function(rs){ return JSON.stringify((rs.data||[]).map(function(p){ var k=p.api_key??p.apiKey??''; return { name:p.name, keyLen:String(k).length, ciphertext:String(k).indexOf('enc:v1:')===0 }; })); })");
    const keyRoundtrip = await cdp.evalJS("window.inkwell.dbCall('listProviders').then(rs=>rs.data.some(p=>(p.api_key??p.apiKey)==='sk-test'))");
    check('key decrypts correctly for the app', keyRoundtrip === true, stored);
  });

  await run('encryption badge shown in Data section', async () => {
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(b=>/data/i.test(b.textContent)).click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.enc-badge')"), 5000, 'enc badge');
    const on = await cdp.evalJS("document.querySelector('.enc-badge').className.includes('on')");
    check('badge shows protected state', on === true);
  });

  await run('per-provider verify button', async () => {
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(b=>/providers/i.test(b.textContent)).click()");
    await sleep(300);
    // One provider card exists with one model; the bolt button triggers a
    // single-provider sweep whose probe the mock delays by 3s.
    const clicked = await cdp.evalJS("(function(){var card=document.querySelector('.provider-card');var b=card.querySelector('button[aria-label]');var found=[...card.querySelectorAll('.head button')].find(x=>x.querySelector('svg') && !x.className.includes('danger') && x.className.includes('small'));if(!found)return false;found.click();return true;})()");
    check('per-provider verify clicked', clicked === true);
    // While it runs, the global Stop button must appear (same sweep pipeline)
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.settings-content button')].some(b=>/stop verification/i.test(b.textContent))"), 5000, 'stop appears');
    check('global Stop active during provider sweep', true);
    await cdp.evalJS("[...document.querySelectorAll('.settings-content button')].find(b=>/stop verification/i.test(b.textContent)).click()");
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.settings-content button')].some(b=>/verify all/i.test(b.textContent))"), 5000, 'restored');
    check('sweep cancelled cleanly', true);
  });

  await run('stop verification mid-sweep', async () => {
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(b=>/providers/i.test(b.textContent)).click()");
    await sleep(300);
    // Sweep = 1 model whose probe the mock delays by 3s → definitely in flight
    await cdp.evalJS("[...document.querySelectorAll('.settings-content button')].find(b=>/verify all models|verify all/i.test(b.textContent)).click()");
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.settings-content button')].some(b=>/stop verification/i.test(b.textContent))"), 5000, 'stop button appears');
    check('Stop button replaces Verify all while running', true);
    await cdp.evalJS("[...document.querySelectorAll('.settings-content button')].find(b=>/stop verification/i.test(b.textContent)).click()");
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.settings-content button')].some(b=>/verify all/i.test(b.textContent))"), 5000, 'verify all restored');
    check('Verify all restored after stop', true);
  });

  await run('set default model', async () => {
    // The default-model picker lives in Settings → Models now; its option values
    // are `providerId::model`, so pick the option by its visible model id.
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(function(b){return /^models$/i.test(b.textContent.trim());}).click()");
    await waitUntil(() => cdp.evalJS("!!document.getElementById('set-default-model')"), 8000, 'models section');
    const s = await cdp.evalJS(`(function(){
      var sel = document.getElementById('set-default-model').querySelector('select');
      if (!sel) return 'no-select';
      var opt = [...sel.options].find(function(o){ return o.textContent.trim() === 'mock-gui'; });
      if (!opt) return 'no-option';
      var set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
      set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      return 'set:' + opt.value;
    })()`);
    check('default model select set to mock-gui', typeof s === 'string' && s.startsWith('set:'), String(s));
  });

  await run('new chat via command palette', async () => {
    await cdp.evalJS("window.__inkwellOpenPalette()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 5000, 'palette open');
    await cdp.evalJS(`(function(){var i=document.querySelector('.palette input');${setReactInput}(i,'new chat');})()`);
    await sleep(200);
    await cdp.evalJS("document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await sleep(800);
    const route = await cdp.evalJS("document.querySelector('.comp-box') ? 'chat' : 'other'");
    check('navigated to chat route', route === 'chat');
    const modelBtn = await cdp.evalJS("document.querySelector('.model-btn') ? document.querySelector('.model-btn').textContent.trim() : 'NONE'");
    check('composer model button shows mock-gui', modelBtn.includes('mock-gui'), modelBtn);
  });

  await run('chat with streaming + agent tool use', async () => {
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'Please remember I like tea');})()`);
    await cdp.evalJS("document.querySelector('.send-btn').click()");
    try {
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.msg.assistant')"), 30000, 'assistant bubble');
    } catch (e) {
      const toasts = await cdp.evalJS("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join('|')");
      const roles = await cdp.evalJS("window.inkwell.dbCall('listChats').then(async r=>{var ms=await window.inkwell.dbCall('getMessages',{chatId:r.data[0].id});return ms.data.map(m=>m.role+':'+m.content.slice(0,30)).join(' || ')})").catch((e2) => 'dbdump-fail: ' + e2.message);
      console.log('  toasts: ' + toasts);
      console.log('  db messages: ' + roles);
      console.log('  mock hits: ' + seenBodies.length);
      console.log('  electron log tail:\n' + elOut.split('\n').filter(l => /error|Error|INFO:CONSOLE/.test(l)).slice(-8).join('\n'));
      throw e;
    }
    await sleep(800);
    const content = await cdp.evalJS("[...document.querySelectorAll('.msg.assistant .content')].map(e=>e.textContent).join('|')");
    check('final streamed text correct', content.includes('Streaming works in the real GUI!'), content);
    const chips = await cdp.evalJS("[...document.querySelectorAll('.tool-chip .tname')].map(e=>e.textContent).join(',')");
    check('tool chip (save_memory) rendered', chips.includes('save_memory'), chips);
    const mems = await cdp.evalJS("window.inkwell.dbCall('listMemories').then(r=>r.data.map(m=>m.content).join('|'))");
    check('tool actually wrote memory to DB', /GUI test memory/.test(mems), mems);
    const roles = await cdp.evalJS("(async()=>{var cs=await window.inkwell.dbCall('listChats').then(r=>r.data);var ms=await window.inkwell.dbCall('getMessages',{chatId:cs[0].id}).then(r=>r.data);return ms.map(m=>m.role).join(',')})()");
    check('user+assistant persisted in DB', roles === 'user,assistant', roles);
  });

  await run('prompt library: slash menu opens and inserts', async () => {
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'/critique');})()`);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.prompt-menu')"), 5000, 'prompt menu open');
    const items = await cdp.evalJS("[...document.querySelectorAll('.prompt-item .pi-label')].map(e=>e.textContent).join('|')");
    check('slash text filters menu', /critique/i.test(items), items);
    // click the first visible item
    await cdp.evalJS("[...document.querySelectorAll('.prompt-item')].find(b=>/critique/i.test(b.textContent)).click()");
    await sleep(400);
    const val = await cdp.evalJS("document.querySelector('.comp-box textarea').value");
    check('template inserted into textarea', /Critique the chapter|Critique/i.test(val), val.slice(0, 60));
    check('menu closed after insert', !(await cdp.evalJS("!!document.querySelector('.prompt-menu')")));
    // clear the composer
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'');})()`);
  });

  await run('prompt library: create custom prompt', async () => {
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'/');})()`);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.prompt-menu')"), 5000, 'prompt menu open');
    // open the editor via the + button in the menu head
    await cdp.evalJS("document.querySelector('.prompt-menu-head button').click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.ui-modal-card')"), 5000, 'prompt editor modal');
    // fill: name, template (category defaults to craft)
    const modal = await cdp.evalJS(`(function(){
      var card=document.querySelector('.ui-modal-card');
      var inputs=card.querySelectorAll('input, textarea');
      var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(inputs[0],'My GUI prompt');
      inputs[0].dispatchEvent(new Event('input',{bubbles:true}));
      var aset=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      aset.call(inputs[1],'Summarize {topic} in three bullets.');
      inputs[1].dispatchEvent(new Event('input',{bubbles:true}));
      return inputs.length;
    })()`);
    await cdp.evalJS("[...document.querySelectorAll('.ui-modal-foot button')].find(b=>b.className.includes('primary')).click()");
    await sleep(700);
    const stored = await cdp.evalJS("window.inkwell.dbCall('listPrompts').then(r=>r.data.map(p=>p.title+'::'+p.template).join('|'))");
    check('custom prompt persisted to DB', /My GUI prompt/.test(stored), stored);
    // menu should re-render with a "Mine" chip and the new prompt first
    const mine = await cdp.evalJS("(function(){var chips=[...document.querySelectorAll('.prompt-menu-cats .chip')];var c=chips.find(x=>/Mine|Milikku/.test(x.textContent));return c?c.textContent:'NO_MINE_CHIP';})()");
    check('Mine chip visible with count', /1/.test(mine), mine);
    const firstLabel = await cdp.evalJS("document.querySelector('.prompt-item .pi-label') ? document.querySelector('.prompt-item .pi-label').textContent : 'NONE'");
    check('custom prompt listed first', firstLabel === 'My GUI prompt', firstLabel);
    // insert it and verify placeholder seeding: '/my' both matches the label
    // (filter) and becomes the seed text for the first {placeholder}
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'/my');})()`);
    await sleep(300);
    await cdp.evalJS("document.querySelector('.prompt-item').click()");
    await sleep(400);
    const seeded = await cdp.evalJS("document.querySelector('.comp-box textarea').value");
    check('placeholder replaced by slash seed', /Summarize my in three bullets/.test(seeded), seeded.slice(0, 80));
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'');})()`);
  });

  await run('prompt library: edit + delete custom prompt', async () => {
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'/');})()`);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.prompt-menu')"), 5000, 'prompt menu open');
    // hover the custom row → edit pencil appears → click it
    await cdp.evalJS("(function(){var row=document.querySelector('.prompt-item-row');row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));row.querySelector('.prompt-edit-btn').click();})()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.ui-modal-card')"), 5000, 'edit modal');
    await cdp.evalJS(`(function(){var card=document.querySelector('.ui-modal-card');var inp=card.querySelector('input');var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(inp,'My GUI prompt v2');inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await cdp.evalJS("[...document.querySelectorAll('.ui-modal-foot button')].find(b=>b.className.includes('primary')).click()");
    await sleep(700);
    const stored = await cdp.evalJS("window.inkwell.dbCall('listPrompts').then(r=>r.data.map(p=>p.title).join('|'))");
    check('prompt renamed in DB', /My GUI prompt v2/.test(stored), stored);
    // now delete it from the editor
    await cdp.evalJS("(function(){var row=document.querySelector('.prompt-item-row');row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));row.querySelector('.prompt-edit-btn').click();})()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.ui-modal-card')"), 5000, 'edit modal 2');
    await cdp.evalJS("[...document.querySelectorAll('.ui-modal-foot button')].find(b=>b.className.includes('danger')).click()");
    await sleep(700);
    const after = await cdp.evalJS("window.inkwell.dbCall('listPrompts').then(r=>r.data.length)");
    check('prompt deleted from DB', after === 0, String(after));
    await cdp.evalJS("(function(){var b=document.querySelector('.prompt-menu-head button[aria-label=Close], .prompt-menu-head button.small.ghost:last-child');if(b)b.click();})()");
  });

  await run('save composer text as prompt', async () => {
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'Always answer as a grumpy editor');})()`);
    // open the + ADD panel and click "Save as prompt"
    await cdp.evalJS("document.querySelector('.round-btn').click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.add-row')"), 5000, 'add panel');
    await cdp.evalJS("[...document.querySelectorAll('.add-row')].find(b=>/Save as prompt|Simpan sebagai prompt/.test(b.textContent)).click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.ui-modal-card')"), 5000, 'prompt editor');
    const prefilled = await cdp.evalJS("document.querySelector('.ui-modal-card textarea').value");
    check('editor pre-filled with composer text', prefilled.includes('grumpy editor'), prefilled.slice(0, 60));
    await cdp.evalJS(`(function(){var card=document.querySelector('.ui-modal-card');var inp=card.querySelector('input');var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(inp,'Grumpy editor');inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await cdp.evalJS("[...document.querySelectorAll('.ui-modal-foot button')].find(b=>b.className.includes('primary')).click()");
    await sleep(700);
    const stored = await cdp.evalJS("window.inkwell.dbCall('listPrompts').then(r=>r.data.map(p=>p.title+'::'+p.category).join('|'))");
    check('composer text saved as prompt', /Grumpy editor/.test(stored), stored);
  });

  await run('about page: encryption badge + dynamic version', async () => {
    await cdp.evalJS("[...document.querySelectorAll('.nav-item, .sidebar-footer button')].find(b=>/about/i.test(b.textContent)).click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.about-page .enc-badge')"), 5000, 'about enc badge');
    const on = await cdp.evalJS("document.querySelector('.about-page .enc-badge').className.includes('on')");
    check('About badge shows protected state', on === true);
    const pill = await cdp.evalJS("document.querySelector('.version-pill') ? document.querySelector('.version-pill').textContent : 'NONE'");
    check('version pill is dynamic (v + number)', /^v\d/.test(pill), pill);
  });

  await run('modal: new project (textPrompt)', async () => {
    await cdp.evalJS("document.querySelectorAll('.new-buttons button')[1].click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.modal input')"), 5000, 'modal open');
    check('textPrompt modal opened (prompt() replacement works)', true);
    await cdp.evalJS(`(function(){var i=document.querySelector('.modal input');${setReactInput}(i,'Test Project');})()`);
    await cdp.evalJS("document.querySelector('.modal .foot button.primary').click()");
    await sleep(800);
    const shown = await cdp.evalJS("[...document.querySelectorAll('.story-item .t')].some(e=>e.textContent==='Test Project')");
    check('project created and shown', shown);
  });

  await run('modal: rename chat', async () => {
    // The app uses SVG icons (no emoji text) — find the row by its Rename button
    const clicked = await cdp.evalJS("(function(){var it=[...document.querySelectorAll('.nav-item')].find(function(n){return n.querySelector('button[title=\"Rename\"]');});if(!it)return 'noitem';it.querySelector('button[title=\"Rename\"]').click();return 'ok';})()");
    if (clicked !== 'ok') throw new Error('rename button not reachable: ' + clicked);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.modal input')"), 5000, 'rename modal');
    await cdp.evalJS(`(function(){var i=document.querySelector('.modal input');${setReactInput}(i,'Renamed chat');})()`);
    await cdp.evalJS("document.querySelector('.modal .foot button.primary').click()");
    await sleep(600);
    const titles = await cdp.evalJS("window.inkwell.dbCall('listChats').then(r=>r.data.map(c=>c.title).join('|'))");
    check('chat renamed in DB', titles.includes('Renamed chat'), titles);
  });

  cleaningUp = true;
  cdp.close();
  console.log('\ncleanup: killing processes...');
  try { electron.kill(); } catch {}
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { shell: true }); } catch {}
  try { vite.kill(); } catch {}
  try { server.close(); } catch {}
  clearTimeout(watchdog);
  console.log(failures === 0 ? '\nALL GUI TESTS PASSED' : '\n' + failures + ' GUI TEST(S) FAILED');
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
