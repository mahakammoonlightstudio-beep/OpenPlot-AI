/**
 * Real-app XSS test.
 *
 * The renderer prints model output as HTML, so markdown is the main injection
 * surface. Instead of trusting a unit test of the sanitizer, this boots the
 * actual app (vite + electron, isolated data dir), writes hostile messages
 * straight into the database, opens the chat, and then asks the live DOM what
 * survived.
 *
 * A canary on `window.__xss` catches anything that executes; the DOM scan
 * catches what would execute on the next interaction (javascript: hrefs, inline
 * handlers, iframes, style attributes).
 *
 * Run: node scripts/xss-test.mjs   (needs a display; not part of `npm test`)
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
const check = (name, ok, extra = '') => {
  if (ok) console.log('  PASS: ' + name);
  else { failures++; console.error('  FAIL: ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch (e) { last = String(e.message || e).slice(0, 140); }
    await sleep(250);
  }
  throw new Error('timeout: ' + label + (last ? ' (last: ' + last + ')' : ''));
}

async function connectCdp(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (!msg.id || !pending.has(msg.id)) return;
    const { res, rej, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);
    msg.error ? rej(new Error(JSON.stringify(msg.error).slice(0, 200))) : res(msg.result);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(mid, { res, rej, timer });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Runtime.enable').catch(() => {});
  return {
    async evalJS(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 240));
      return r.result?.value;
    },
    close: () => { try { ws.close(); } catch { /* already gone */ } }
  };
}

const HOSTILE = [
  '<script>window.__xss = 1</script>',
  '<img src=x onerror="window.__xss = 2">',
  '[click me](javascript:window.__xss = 3)',
  '<iframe src="javascript:window.__xss = 4"></iframe>',
  '<svg onload="window.__xss = 5"></svg>',
  '<a href="https://example.com/ok" style="position:fixed;inset:0">legit link</a>',
  '<div style="background:url(javascript:window.__xss=7)">styled</div>'
];

(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: xss test timed out'); process.exit(2); }, 240000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-xss-'));
  const vite = spawn('npx', ['vite', '--port', '5179', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  let electron;
  let cdp;
  try {
    await waitUntil(async () => { try { return (await fetch('http://localhost:5179/')).ok; } catch { return false; } }, 60000, 'vite ready');
    console.log('vite ready');

    const cdpPort = 9950 + Math.floor(Math.random() * 40);
    electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
      env: {
        ...process.env, INKWELL_DEV: '1', APPDATA: dataDir, OPENPLOT_DATA_DIR: dataDir,
        // This harness serves Vite on its own port; main must load that origin.
        OPENPLOT_DEV_URL: 'http://localhost:5179'
      }
    });
    await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
    cdp = await connectCdp(cdpPort);
    console.log('CDP connected\n');

    await waitUntil(() => cdp.evalJS("!!document.querySelector('.app')"), 90000, 'app shell');
    await waitUntil(() => cdp.evalJS("!!window.useSettings.getState().version"), 30000, 'settings loaded');
    await cdp.evalJS("window.useSettings.getState().set('lastSeenVersion', window.useSettings.getState().version)");
    await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll');return 1;})()");

    // A provider must exist or the composer refuses to render a chat view.
    await cdp.evalJS("(async()=>{await window.inkwell.dbCall('createProvider',{name:'Probe',baseUrl:'http://127.0.0.1:9/v1',apiKey:'sk-probe',enabled:true,models:['probe-model'],kind:'openai'});return 1;})()");
    await cdp.evalJS("window.useSettings.getState().set('defaultModel','probe-model')");

    // One user turn + one assistant reply per hostile payload, plus a tool step
    // whose detail is hostile too (React text nodes must escape it). The reply
    // carries parent_id like a real answer, so the transcript groups it.
    const chat = await cdp.evalJS("(async()=>{return (await window.inkwell.dbCall('createChat',{title:'XSS probe'})).data;})()");
    for (const payload of HOSTILE) {
      const user = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'user',content:'probe'}))[0] || (await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'user',content:'probe'}));})()`);
      const parentId = (user && (user.id || user.data?.id)) || null;
      await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'assistant',content:${JSON.stringify(payload)},model:'probe-model',parentId:${JSON.stringify(parentId)},toolSteps:[{name:'create_story_entry',kind:'entry',detail:${JSON.stringify(payload)},ok:true}]});return 1;})()`);
    }
    await cdp.evalJS("window.useData.getState().load()");
    await cdp.evalJS(`window.useData.getState().setActiveChat('${chat.id}')`);
    await cdp.evalJS("window.useData.getState().navigate('chat')");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 20000, 'composer');
    await waitUntil(() => cdp.evalJS("document.querySelectorAll('.msg.assistant .content').length >= " + HOSTILE.length), 20000, 'hostile replies rendered');
    // Tool detail only exists in the DOM while its panel is open, so expand every
    // panel before auditing what it renders.
    await cdp.evalJS("document.querySelectorAll('.tool-log .tl-head[aria-expanded=\"false\"]').forEach((b) => b.click())");
    await sleep(400);

    // ---- canary: did ANY of it execute? ----
    check('no injected script executed', (await cdp.evalJS('window.__xss === undefined')) === true,
      'canary=' + String(await cdp.evalJS('window.__xss')));

    const audit = JSON.parse(await cdp.evalJS(`(() => {
      const out = { script: 0, handlers: 0, jsHrefs: 0, iframes: 0, inlineStyle: 0, svgHandler: 0, links: [], escapedDetail: 0, detailImgs: 0 };
      const root = document.querySelector('.chat-root') || document.body;
      out.script = root.querySelectorAll('script').length;
      out.iframes = root.querySelectorAll('iframe, object, embed').length;
      const ALLOWED = ['target', 'rel', 'href', 'class', 'data-code', 'src', 'alt'];
      for (const el of root.querySelectorAll('.msg .content *')) {
        for (const attr of el.attributes) {
          const name = attr.name.toLowerCase();
          const value = String(attr.value || '').toLowerCase();
          if (name.startsWith('on')) out.handlers++;
          if (name === 'style') out.inlineStyle++;
          if (/^(href|src|xlink:href|srcset|formaction)$/.test(name) && value.replace(/[\\s\\u0000-\\u001f]/g, '').startsWith('javascript:')) out.jsHrefs++;
          if (!ALLOWED.includes(name) && !name.startsWith('data-') && !name.startsWith('aria-')) out.handlers++;
        }
        if (el.tagName === 'A') out.links.push({ href: el.getAttribute('href'), target: el.getAttribute('target'), rel: el.getAttribute('rel') });
      }
      // Tool-step details are rendered as text, so a payload must appear escaped.
      for (const row of root.querySelectorAll('.tool-log .tl-name')) {
        if (row.textContent.includes('<')) out.escapedDetail++;
        if (row.querySelector('img, script')) out.detailImgs++;
      }
      return JSON.stringify(out);
    })()`));

    check('no <script> survived in message HTML', audit.script === 0, 'count=' + audit.script);
    check('no event handlers or unknown attributes survived', audit.handlers === 0, 'count=' + audit.handlers);
    check('no javascript: URL survived', audit.jsHrefs === 0, 'count=' + audit.jsHrefs);
    check('no iframe/object/embed survived', audit.iframes === 0, 'count=' + audit.iframes);
    check('inline style attributes stripped', audit.inlineStyle === 0, 'count=' + audit.inlineStyle);
    const legit = audit.links.find((l) => (l.href || '').includes('example.com/ok'));
    check('legit external link kept and hardened',
      !!legit && legit.target === '_blank' && /noopener/.test(legit.rel || ''),
      JSON.stringify(legit));
    check('hostile tool detail is escaped text, not markup', audit.detailImgs === 0 && audit.escapedDetail > 0,
      `escaped=${audit.escapedDetail} imgs=${audit.detailImgs}`);
  } catch (err) {
    // Diagnostics on failure: which view is open and how many bubbles exist.
    const dbg = await cdp?.evalJS(`JSON.stringify({route:window.useData.getState().route,active:window.useData.getState().activeChatId,msgs:document.querySelectorAll('.msg').length,content:document.querySelectorAll('.msg .content').length,body:(document.body.innerText||'').slice(0,160)})`).catch(() => 'no-state');
    check('xss test completed', false, (String(err && err.message || err).slice(0, 160) + ' | ' + dbg));
  } finally {
    clearTimeout(watchdog);
    try { cdp?.close(); } catch { /* ignore */ }
    try { electron?.kill(); } catch { /* ignore */ }
    try { vite.kill(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failures === 0 ? 'XSS TEST PASSED' : failures + ' XSS CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
