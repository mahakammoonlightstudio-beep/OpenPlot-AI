/**
 * Validate the user's real provider key through the fixed app — safely:
 *  1. Copies the real profile DB into a temp dir (the real DB is never opened).
 *  2. Boots the app with OPENPLOT_DATA_DIR pointing at the copy.
 *  3. Calls the same IPC the Settings UI uses: validateKey + fetchModels.
 * The API key is DPAPI-encrypted at rest and is only ever decrypted inside
 * the main process — this script never sees it.
 *
 * Run: node scripts/test-apinex-key.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronExe = require('electron');
const PROJ = path.resolve(import.meta.dirname, '..');

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
  return Promise.race([p, sleep(ms).then(() => { throw new Error('eval timeout: ' + label); })]);
}

async function connectCdp(port) {
  let list = [];
  for (let i = 0; i < 40; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch {}
    const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
    if (page) break;
    await sleep(250);
  }
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('no page target');
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
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP timeout: ' + method)); }, 30000);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); rej(e); }
  });
  return {
    async evalJS(expr) {
      const r = await withTimeout(send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), 25000, expr.slice(0, 60));
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result?.value;
    },
    close: () => { try { ws.close(); } catch {} }
  };
}

(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 150000);

  // 1. Copy the real DB into an isolated dir — the original is never touched.
  const realDb = path.join(os.homedir(), 'AppData', 'Roaming', 'OpenPlot AI', 'openplot.db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-keytest-'));
  fs.copyFileSync(realDb, path.join(tmp, 'openplot.db'));
  console.log('DB copied to ' + tmp + ' (original untouched)');

  const { execSync } = await import('node:child_process');
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch {}

  const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');

  const cdpPort = 9960 + Math.floor(Math.random() * 30);
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', OPENPLOT_DATA_DIR: tmp }
  });
  let exited = null;
  let elog = [];
  electron.stdout.on('data', (d) => elog.push(d.toString()));
  electron.stderr.on('data', (d) => elog.push(d.toString()));
  electron.on('exit', (code) => { exited = code; });

  try {
    await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP');
    const cdp = await connectCdp(cdpPort);
    // Wait for the app to fully boot before touching IPC.
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card, .nav-item, .page')"), 40000, 'app booted');

    // 2. Validate + list models via the same IPC the UI uses.
    const result = await cdp.evalJS(`(async()=>{
      var provs=(await window.inkwell.dbCall('listProviders')).data;
      var names=provs.map(function(x){return x.name;});
      var raw=provs.find(function(x){return x.name==='apinex';});
      if(!raw) return {error:'provider apinex not found', providerNames: names};
      // listProviders returns raw DB rows (snake_case) — the renderer normally
      // normalizes them via normProvider before calling these IPCs.
      var p={ id: raw.id, name: raw.name,
        baseUrl: raw.baseUrl || raw.base_url || '',
        apiKey: raw.apiKey || raw.api_key || '',
        enabled: true, models: [], kind: raw.kind || 'auto' };
      var v=await window.inkwell.validateKey(p);
      var m=await window.inkwell.fetchModels(p);
      return {
        keyOk: v.ok && v.data ? v.data.ok : false,
        keyMethod: v.ok && v.data ? v.data.method : 'error',
        keyMessage: v.ok && v.data ? v.data.message : (v.error||'unknown'),
        modelsOk: m.ok,
        modelCount: m.ok ? m.data.length : 0,
        modelsErr: m.ok ? '' : (m.error||'').slice(0,200)
      };
    })()`);
    console.log('RESULT: ' + JSON.stringify(result, null, 2));

    cdp.close();
  } catch (e) {
    console.error('HARNESS ERROR: ' + String(e.message || e).slice(0, 400));
    if (exited !== null) console.error('electron exited, code=' + exited);
    process.exitCode = 1;
  } finally {
    const interesting = elog.join('').split('\n').filter((l) => /error|exception|crash|gone|uncaught/i.test(l)).slice(0, 10);
    if (interesting.length) {
      console.log('--- electron console (filtered) ---');
      for (const l of interesting) console.log('  ' + l.slice(0, 240));
    }
    try { electron.kill(); } catch {}
    await sleep(500);
    try { vite.kill(); } catch {}
    try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    clearTimeout(watchdog);
  }
})();
