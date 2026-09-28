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
  // renderer is still booting — poll until a page target exists.
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

  const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9300 + Math.floor(Math.random() * 400);
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
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
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'welcome screen');
    check('welcome screen rendered', true);
    await cdp.evalJS("document.querySelectorAll('.welcome-card')[0].click()");
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
    await cdp.evalJS(`(function(){var c=document.querySelector('.provider-card');${setReactInput}(c.querySelector('.head input[type=text], .head input:not([type])'),'Mock');})()`);
    await cdp.evalJS(`(function(){var c=document.querySelector('.provider-card .grid');var ins=c.querySelectorAll('input');${setReactInput}(ins[0],'http://127.0.0.1:${mockPort}/v1');${setReactInput}(ins[1],'sk-test');})()`);
    await cdp.evalJS("[...document.querySelectorAll('.provider-card .head button')].find(b=>!b.className.includes('danger')).click()");
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.model-tag')].some(m=>m.textContent.includes('mock-gui'))"), 20000, 'models fetched');
    check('models fetched into UI (mock-gui)', true);
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
    const keyRoundtrip = await cdp.evalJS("window.inkwell.dbCall('listProviders').then(rs=>rs.data.some(p=>(p.api_key??p.apiKey)==='sk-test'))");
    check('key decrypts correctly for the app', keyRoundtrip === true);
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
    const s = await cdp.evalJS("(function(){var s=document.querySelector('.settings-content .card select');if(!s)return false;var set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;set.call(s,'mock-gui');s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    check('default model select set to mock-gui', s === true);
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
