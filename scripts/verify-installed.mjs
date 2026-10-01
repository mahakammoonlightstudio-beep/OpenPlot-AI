/**
 * Verify the INSTALLED production app against the real profile.
 * Reads the actual CDP port from the profile's DevToolsActivePort file
 * (more reliable than assuming the flag value survives).
 * Run: node scripts/verify-installed.mjs
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'openplot-ai', 'OpenPlot AI.exe');
const profile = path.join(os.homedir(), 'AppData', 'Roaming', 'OpenPlot AI');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try { execSync('taskkill /F /IM "OpenPlot AI.exe" /T', { shell: 'cmd.exe' }); } catch {}
  await sleep(1200);

  const port = 9520;
  const child = spawn(exe, ['--remote-debugging-port=' + String(port)], { stdio: 'ignore' });

  // Resolve the ACTUAL port: prefer the DevToolsActivePort file if it appears.
  let cdpPort = port;
  for (let i = 0; i < 40; i++) {
    try {
      const txt = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8');
      const p = parseInt(txt.split('\n')[0].trim(), 10);
      if (Number.isFinite(p) && p > 0) { cdpPort = p; break; }
    } catch { await sleep(500); }
  }
  console.log('cdp port:', cdpPort);

  let list = null;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json(); break; } catch { await sleep(500); }
  }
  let ok = false;
  try {
    if (!list) throw new Error('CDP never came up on port ' + cdpPort);
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
    const evalJS = async (expr) => {
      for (let i = 0; i < 30; i++) {
        try {
          const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result?.value) return r.result.value;
        } catch { /* context not ready */ }
        await sleep(700);
      }
      return null;
    };
    const info = await evalJS(`(async()=>{ if(!window.inkwell) return null; const i=await window.inkwell.appInfo(); return { version:i.version, encryption:i.encryption }; })()`);
    const provs = await evalJS(`(async()=>{ if(!window.inkwell) return null; const r=await window.inkwell.dbCall('listProviders'); return (r.data||[]).map(p=>({ name:p.name, baseUrl:p.base_url||p.baseUrl, keyLen:(p.api_key||p.apiKey||'').length })); })()`);
    const ui = await evalJS(`!!document.querySelector('.page, .welcome-card')`);
    console.log('app info :', JSON.stringify(info));
    console.log('providers:', JSON.stringify(provs));
    console.log('ui mounted:', ui);
    ok = !!(info && String(info.version).startsWith('1.1.1') && ui && Array.isArray(provs) && provs.length > 0);
    ws.close();
  } catch (e) {
    console.error('VERIFY FAIL: ' + String(e.message || e));
  } finally {
    try { child.kill(); } catch {}
    await sleep(1000);
    try { execSync('taskkill /F /IM "OpenPlot AI.exe" /T', { shell: 'cmd.exe' }); } catch {}
  }
  console.log(ok ? 'INSTALLED APP VERIFY OK' : 'INSTALLED APP VERIFY FAILED');
  process.exit(ok ? 0 : 1);
})();
