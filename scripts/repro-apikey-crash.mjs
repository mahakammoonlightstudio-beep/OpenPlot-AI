/**
 * Repro: app closes instantly when clicking Validate/Test/Save after entering
 * a real API key on a local (or unreachable) provider.
 *
 * What this does:
 *  1. Boots the app with an isolated APPDATA (no real user data touched).
 *  2. Seeds a provider pointed at a CLOSED local port (connection refused —
 *     the classic "local provider isn't running" case).
 *  3. Drives the real Settings UI via CDP: types a real-looking key into the
 *     API key field, then clicks Validate, Test, and Save.
 *  4. Watches the electron process: an uncaught exception in the main process
 *     kills the app outright — the repro fails the moment that happens.
 *
 * Run: node scripts/repro-apikey-crash.mjs
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
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    sleep(ms).then(() => { throw new Error('eval timeout after ' + ms + 'ms: ' + label); })
  ]);
}

// A closed port on 127.0.0.1 — connecting yields ECONNREFUSED immediately,
// which is exactly what happens when the local provider isn't running.
const CLOSED_PORT = 9753;
const EVIL_PORT = 9754;

// An "evil" local endpoint: answers /v1/models with an endless body (no
// content-length, never ends). Localhost throughput is GB/s, and the app used
// to buffer the whole body — the suspected 0xc0000409 heap-OOM crash.
import http from 'node:http';
const evil = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = JSON.stringify({ data: [{ id: 'x'.repeat(200000) }] }).slice(0, 200000);
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      for (let i = 0; i < 32; i++) res.write(chunk);
    }, 5);
    req.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(404); res.end('{}');
});

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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error).slice(0, 200))) : p.res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP timeout: ' + method)); }, 25000);
    pending.set(id, {
      res: (v) => { clearTimeout(timer); res(v); },
      rej: (e) => { clearTimeout(timer); rej(e); }
    });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); rej(e); }
  });
  await send('Page.enable').catch(() => {});
  return {
    async evalJS(expr) {
      const r = await withTimeout(
        send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }),
        20000, expr.slice(0, 80)
      );
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result?.value;
    },
    close: () => { try { ws.close(); } catch {} }
  };
}

// Typing via the native value setter so React picks it up (same trick the
// visual harness uses for textareas).
const SET_INPUT = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;

(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: repro timed out'); process.exit(2); }, 180000);

  const { execSync } = await import('node:child_process');
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch { /* none */ }

  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-repro-'));

  const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9900 + Math.floor(Math.random() * 60);
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    // NOTE: OPENPLOT_DATA_DIR is what actually isolates the DB on Windows —
    // Electron ignores an APPDATA override there. Never run this without it:
    // the repro writes test providers into whatever DB it opens.
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
  });

  let exited = null;
  let stderrTail = [];
  electron.stdout.on('data', (d) => stderrTail.push(d.toString()));
  electron.stderr.on('data', (d) => stderrTail.push(d.toString()));
  electron.on('exit', (code) => { exited = { code }; });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  const cdp = await connectCdp(cdpPort);
  console.log('CDP connected');

  const alive = () => !exited;
  // JS expression returning the LAST provider card (the one we seeded), or null.
  const card = `(function(){var c=[...document.querySelectorAll('.provider-card')];return c.length?c[c.length-1]:null;})()`;

  await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));
  try {
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'welcome screen');
    console.log('app up — seeding closed-port provider');

    await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProvider',{name:'Local Llama',baseUrl:'http://127.0.0.1:${CLOSED_PORT}/v1',apiKey:'',enabled:true,models:[],kind:'auto'})).data;})()`);
    await cdp.evalJS("(async()=>{await window.useData.getState().load();return 1;})()");

    // Open Settings -> Providers
    await cdp.evalJS("window.useData.getState().navigate('settings')");
    await sleep(500);

    // 1) Type a real-looking key into the API key field
    await cdp.evalJS(`(function(){var c=${card}; if(!c) return false; var el=c.querySelector('.grid input[type=password]'); if(!el) return false; (${SET_INPUT})(el,'sk-proj-REALKEY1234567890abcdef'); return true;})()`);
    await sleep(300);
    check('A1 typing key: app alive', alive());

    // 2) Click Validate (KeyValidation -> ipc ai:validateKey)
    await cdp.evalJS(`(function(){var c=${card}; if(!c) return false; var b=c.querySelector('.key-validation button'); if(!b) return false; b.click(); return true;})()`);
    await sleep(1800);
    check('A2 Validate click: app alive', alive());
    const valResult = await cdp.evalJS(`(function(){var c=${card}; if(!c) return null; var el=c.querySelector('.key-validation .key-result'); return el?el.textContent.trim():null;})()`);
    console.log('  validate result:', valResult);

    // 3) Click Test (persist -> fetchModels via ai:models)
    await cdp.evalJS(`(function(){var c=${card}; if(!c) return false; var b=[...c.querySelectorAll('.head button')].find(function(b){return /test/i.test(b.textContent);}); if(!b) return false; b.click(); return true;})()`);
    await sleep(1800);
    check('A3 Test click: app alive', alive());

    // 4) Click Save (persist -> updateProvider)
    await cdp.evalJS(`(function(){var c=${card}; if(!c) return false; var rows=c.querySelectorAll('.row'); if(!rows.length) return false; var b=[...rows[rows.length-1].querySelectorAll('button')].find(function(b){return b.textContent.trim().length>0;}); if(!b) return false; b.click(); return true;})()`);
    await sleep(800);
    check('A4 Save click: app alive', alive());

    // ---------- scenario C: evil local server (endless response) ----------
    console.log('scenario C: evil local server (endless /v1/models body)');
    await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProvider',{name:'Evil Local',baseUrl:'http://127.0.0.1:${EVIL_PORT}/v1',apiKey:'sk-proj-REALKEY1234567890abcdef',enabled:true,models:[],kind:'openai'})).data;})()`);
    await cdp.evalJS("(async()=>{await window.useData.getState().load();return 1;})()");
    await cdp.evalJS("(function(){var c=[...document.querySelectorAll('.provider-card')];var el=c.length?c[c.length-1]:null;if(!el)return false;var b=[...el.querySelectorAll('.head button')].find(function(b){return /test/i.test(b.textContent);});if(!b)return false;b.click();return true;})()");
    // Give the OOM a moment to happen if the bug is present.
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      if (!alive()) break;
    }
    check('C1 Test vs endless response: app alive', alive());
    if (alive()) {
      const toast = await cdp.evalJS("(function(){var t=[...document.querySelectorAll('.toast')].map(function(x){return x.textContent;});return t.join(' | ').slice(0,200);})()");
      console.log('  toasts after test:', toast || '(none)');
    }

    // ---------- scenario B: direct IPC, no UI (worst case) ----------
    await cdp.evalJS(`(async()=>{ var r=(await window.inkwell.dbCall('listProviders')).data; var p=r.find(function(x){return x.name==='Local Llama';});
      await window.inkwell.validateKey(Object.assign({},p,{kind:'auto'}));
      await window.inkwell.fetchModels(Object.assign({},p,{kind:'auto'}));
      await window.inkwell.dbCall('updateProvider',{id:p.id, name:p.name, baseUrl:p.baseUrl, apiKey:'sk-proj-REALKEY1234567890abcdef', enabled:true, models:p.models, kind:'auto'});
      return 'ipc-ok'; })()`);
    await sleep(600);
    check('B1 direct IPC: app alive', alive());

    if (failures === 0) console.log('\nREPRO RESULT: no crash reproduced — app survived all steps');
    else console.log('\nREPRO RESULT: crash reproduced (or harness error) — see FAIL lines above');
  } catch (e) {
    failures++;
    console.error('HARNESS ERROR: ' + String(e.message || e).slice(0, 400));
    if (exited) console.error('electron exited during run, code=' + exited.code);
  } finally {
    try { cdp.close(); } catch {}
    try { evil.close(); } catch {}
    electron.kill();
    await sleep(400);
  }

  const log = stderrTail.join('');
  const interesting = log.split('\n').filter((l) => /error|exception|crash|refused/i.test(l)).slice(0, 12);
  console.log('\n--- electron console (filtered) ---');
  for (const l of interesting) console.log('  ' + l.slice(0, 220));

  try { vite.kill(); } catch {}
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch {}
  clearTimeout(watchdog);
  process.exit(failures ? 1 : 0);
})();
