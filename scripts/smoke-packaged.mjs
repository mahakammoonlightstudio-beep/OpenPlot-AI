/**
 * Smoke-test the PACKAGED app (release/win-unpacked) in production mode:
 * boots it with an isolated OPENPLOT_DATA_DIR and verifies the renderer and
 * the DB IPC bridge are alive. Run after `npm run dist:win`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = path.resolve('release/win-unpacked/OpenPlot AI.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-smoke-'));
  const port = 9450 + Math.floor(Math.random() * 40);
  const child = spawn(exe, ['--remote-debugging-port=' + port], {
    stdio: 'ignore',
    env: { ...process.env, OPENPLOT_DATA_DIR: tmp }
  });
  let ok = false;
  try {
    let list = null;
    for (let i = 0; i < 60; i++) {
      try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); break; } catch { await sleep(500); }
    }
    if (!list) throw new Error('CDP endpoint never came up');
    const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    let id = 0;
    const call = (method, params) => new Promise((res, rej) => {
      const mid = ++id;
      const t = setTimeout(() => rej(new Error('timeout ' + method)), 20000);
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === mid) { clearTimeout(t); ws.removeEventListener('message', on); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    // React needs a moment to mount in the packaged build — poll, don't race.
    let val = null;
    for (let i = 0; i < 40; i++) {
      const r = await call('Runtime.evaluate', {
        expression: `(async()=>{ return { hasBridge: !!window.inkwell, db: !!(await window.inkwell.dbCall('getAllSettings')).ok, ui: !!document.querySelector('.page, .welcome-card') }; })()`,
        awaitPromise: true, returnByValue: true
      });
      val = r.result?.value;
      if (val?.ui) break;
      await sleep(750);
    }
    ok = val?.hasBridge && val?.db && val?.ui;
    console.log('smoke result:', JSON.stringify(val));
    ws.close();
  } catch (e) {
    console.error('SMOKE FAIL: ' + String(e.message || e));
  } finally {
    try { child.kill(); } catch {}
    await sleep(800);
    try { spawn('taskkill', ['/F', '/IM', 'OpenPlot AI.exe'], { shell: true }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
  process.exit(ok ? 0 : 1);
})();
