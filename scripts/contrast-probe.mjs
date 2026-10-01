/**
 * One-off contrast probe: boots the app, switches to a light theme,
 * and dumps the worst-contrast elements with computed styles + ancestry.
 * Run: node scripts/contrast-probe.mjs
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
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch {}
    await sleep(250);
  }
  throw new Error('timeout: ' + label);
}

const server = await import('node:http').then((h) => {
  const s = h.createServer((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({data:[{id:'mock-x'}]})); return; }
    res.writeHead(404); res.end('{}');
  });
  return s;
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockPort = server.address().port;
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-probe-'));

const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite');
const cdpPort = 9600 + Math.floor(Math.random() * 90);
const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
  stdio: 'ignore', cwd: PROJ,
  env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData }
});
await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'cdp');

let list = [];
for (let i = 0; i < 40; i++) {
  try { list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json(); } catch {}
  if (list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))) break;
  await sleep(250);
}
const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};
// wait for the app UI, then switch theme via the REAL store path
// (dbCall bypasses React — data-theme would never change)
await waitUntil(() => evalJS("!!document.querySelector('.welcome-card, .sidebar')"), 30000, 'app UI');
await waitUntil(() => evalJS("!!window.useSettings"), 15000, 'useSettings hook');
await evalJS("window.useSettings.getState().set('theme','sepia')");
await sleep(1000);
await evalJS("window.useData && window.useData.getState().navigate('chat')").catch(() => {});
await sleep(600);

const report = await evalJS(`(() => {
  const theme = document.documentElement.getAttribute('data-theme');
  const lum = (rgb) => { const [r,g,b]=rgb.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*r+0.7152*g+0.0722*b; };
  const parse = (c) => { const m=c.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m?{rgb:[+m[1],+m[2],+m[3]],a:m[4]===undefined?1:+m[4]}:null; };
  const bgOf = (el) => { let n=el; while(n && n!==document.documentElement){ const c=parse(getComputedStyle(n).backgroundColor); if(c && c.a>0.6) return {bg:c.rgb, via:n.tagName+'.'+(n.className||'')}; n=n.parentElement; } return {bg:[11,13,18],via:'root'}; };
  const rows=[];
  for (const el of document.querySelectorAll('h1,h2,h3,label,button,.subtitle,.hint,.nav-item,.t,.k,.d,.stat-value')) {
    if (el.offsetParent===null) continue;
    const st=getComputedStyle(el);
    if (st.visibility==='hidden'||st.display==='none') continue;
    const text=(el.textContent||'').trim().slice(0,30); if(!text) continue;
    const fg=parse(st.color); if(!fg||fg.a<0.8) continue;
    const {bg,via}=bgOf(el);
    const L1=lum(fg.rgb),L2=lum(bg);
    const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    if (ratio<3) rows.push({text, ratio:+ratio.toFixed(2), color:st.color, bg:'rgb('+bg.join(',')+')', via, cls:String(el.className).slice(0,40)});
  }
  rows.sort((a,b)=>a.ratio-b.ratio);
  const btn = document.querySelector('.new-buttons button');
  const btnInfo = btn ? (function(){ const st=getComputedStyle(btn); const fg=parse(st.color); const {bg,via}=bgOf(btn); const L1=lum(fg.rgb),L2=lum(bg); return {text:btn.textContent.trim(), ratio:+((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)).toFixed(2), color:st.color, bg:'rgb('+bg.join(',')+')', via, cls:String(btn.className)}; })() : null;
  return { theme, vars: { text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(), panel: getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() }, btnInfo, worst: rows.slice(0, 12) };
})()`);
console.log(JSON.stringify(report, null, 1));

ws.close();
try { electron.kill(); } catch {}
try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { shell: true }); } catch {}
try { vite.kill(); } catch {}
try { server.close(); } catch {}
process.exit(0);
