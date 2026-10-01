/**
 * Visual review (ASCII only).
 * Boots vite + electron (isolated APPDATA), seeds realistic data, then:
 *  - screenshots every page and several themes into docs/review/
 *  - runs real layout checks per page: console errors, missing render,
 *    horizontal overflow, low-contrast text (WCAG-ish, computed styles)
 *  - exercises the new Prompt Library shortcut (event + palette entry)
 * Run: node scripts/visual-review.mjs
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
const OUT = path.join(PROJ, 'docs', 'review');

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

// ---------- mock OpenAI SSE provider (text only) ----------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-visual' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const words = ['The', ' harbor', ' sleeps', ' under', ' a', ' quilt', ' of', ' fog.'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) { write({ choices: [{ delta: { content: words[i] }, finish_reason: null }] }); i++; }
        else { write({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); clearInterval(timer); res.end(); }
      }, 30);
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

// ---------- CDP ----------
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
    // Per-command timeout: a hung CDP command (e.g. screenshot on a throttled
    // window) used to freeze the whole harness until the watchdog.
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP timeout: ' + method)); }, 25000);
    pending.set(id, {
      res: (v) => { clearTimeout(timer); res(v); },
      rej: (e) => { clearTimeout(timer); rej(e); }
    });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); rej(e); }
  });
  // Page domain must be enabled or Page.captureScreenshot never replies.
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
    async shot(file) {
      // fromSurface:false works even when the OS window is hidden/backgrounded
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false });
      fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    },
    close: () => { try { ws.close(); } catch {} }
  };
}

const setReactArea = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;

// ---------- layout + contrast probe ----------
// NOTE: the color parser MUST capture the alpha channel — rgba(0,0,0,0) is
// the default transparent background, and treating it as opaque black made
// every dark-on-light theme look like a 1.7:1 contrast failure.
const PROBE = `(() => {
  const issues = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) issues.push('page h-overflow: ' + (de.scrollWidth - de.clientWidth) + 'px');
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (c) => {
    const m = (c || '').match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.6) return { rgb: c.rgb, via: n.tagName + '.' + String(n.className).slice(0, 30) };
      n = n.parentElement;
    }
    return { rgb: [11, 13, 18], via: 'root' };
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('h1,h2,h3,label,button,.subtitle,.hint,.stat-value,.nav-item,.t,.k,.d')) {
    if (el.offsetParent === null) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const text = (el.textContent || '').trim().slice(0, 40);
    if (!text) continue;
    const fg = parse(st.color);
    if (!fg || fg.a < 0.8) continue;
    const { rgb: bg, via } = bgOf(el);
    const L1 = lum(fg.rgb), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 2.6 && !seen.has(text)) {
      seen.add(text);
      issues.push('contrast ' + ratio.toFixed(2) + ': "' + text + '" [color=' + st.color + ', bg=' + via + ', cls=' + String(el.className).slice(0, 30) + ']');
    }
  }
  return issues;
})()`;

(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: visual review timed out'); process.exit(2); }, 300000);
  fs.mkdirSync(OUT, { recursive: true });
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('netstat -ano | findstr :5173 | findstr LISTENING', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p)))];
    for (const pid of pids) { try { execSync('taskkill /F /PID ' + pid, { shell: 'cmd.exe' }); } catch {} }
  } catch { /* nothing listening */ }
  try { execSync('taskkill /F /IM electron.exe /T', { shell: 'cmd.exe' }); } catch { /* none */ }
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-visual-'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mockPort = server.address().port;
  console.log('mock provider: http://127.0.0.1:' + mockPort + '/v1');
  console.log('screenshots → ' + OUT + '\n');

  const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');
  console.log('vite ready');

  const cdpPort = 9700 + Math.floor(Math.random() * 200);
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJ,
    // OPENPLOT_DATA_DIR is what actually isolates the DB on Windows — Electron
    // ignores an APPDATA override there. Without it this harness's resetAll
    // seeds/wipes the USER'S REAL database (this really happened once).
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData, ELECTRON_ENABLE_LOGGING: '1' }
  });
  let consoleErrors = [];
  electron.stderr.on('data', (d) => {
    const s = d.toString();
    if (/ERROR:CONSOLE\(\d+\)/.test(s) && !/Autofill|Download the React DevTools|Electron Security Warning/.test(s)) {
      consoleErrors.push(s.slice(0, 220));
    }
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
  const audit = async (name, file) => {
    await sleep(600);
    const issues = await cdp.evalJS(PROBE);
    check(name + ': no overflow/contrast issues', issues.length === 0, issues.slice(0, 3).join(' | '));
    await cdp.shot(file);
  };

  // ---------- seed ----------
  await run('seed realistic data', async () => {
    // The CDP connection can be ready before the React bundle finishes —
    // wait for real UI instead of assuming.
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'welcome screen');
    await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll');return 1;})()");
    // dbCall resolves to an {ok,data} envelope — rows must be unwrapped via
    // .data or every downstream id becomes the string "undefined".
    const prov = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProvider',{name:'Mock Harbor',baseUrl:'http://127.0.0.1:${mockPort}/v1',apiKey:'sk-visual',enabled:true,models:['mock-visual'],kind:'openai'})).data;})()`);
    // Set the default model through the LIVE store (a raw dbCall after boot
    // leaves the in-memory settings empty and send() refuses to run).
    await cdp.evalJS("window.useSettings.getState().set('defaultModel','mock-visual')");
    const proj = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProject',{name:'Harbor Lights',description:'A fog-laden port city mystery',context:'Set in 1930s Mahakam; gas lamps, river barges, quiet corruption.',format:'novel',rating:'teen'})).data;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createStory',{projectId:'${proj.id}',kind:'character',title:'Sari Winata',content:'Harbor customs officer. Keeps a ledger of every lie she hears.',tags:['lead']});return 1;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createChapter',{projectId:'${proj.id}',title:'Chapter 1 — Low Tide',content:'The letter arrived on a Tuesday, folded inside a shipping manifest.',status:'draft'});return 1;})()`);
    for (const [act, title, summary] of [[1,'The Body at Pier 7','A customs officer finds a ledger with impossible numbers.'],[2,'River Bargains','Sari trades silence for access; the city watches.'],[3,'High Water','The flood forces every secret into the open.']]) {
      await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createFlowBeat',{projectId:'${proj.id}',act:${act},title:${JSON.stringify(title)},summary:${JSON.stringify(summary)}});return 1;})()`);
    }
    const chat = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createChat',{title:'Plotting the ledger twist',project_id:'${proj.id}'})).data;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'user',content:'What if the ledger numbers are coordinates?'});return 1;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'assistant',content:'Then the harbor itself becomes a cipher — every manifest a map. **Nice.**',model:'mock-visual'});return 1;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMemory',{content:'Prefers terse chapter endings.',source:'manual'});return 1;})()`);
    await cdp.evalJS("window.useData.getState().load()");
    await cdp.evalJS(`window.useData.getState().setActiveChat('${chat.id}')`);
    await cdp.evalJS(`window.useData.getState().setActiveProject('${proj.id}')`);
    // React needs a render tick after setActiveChat before the composer exists
    try {
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 15000, 'composer after chat open');
    } catch (e) {
      const dbg = await cdp.evalJS("JSON.stringify({route:window.useData.getState().route,active:window.useData.getState().activeChatId,n:window.useData.getState().chats.length,ids:window.useData.getState().chats.map(c=>c.id).slice(0,3),welcome:!!document.querySelector('.welcome-hero'),composer:!!document.querySelector('.comp-box'),toasts:[...document.querySelectorAll('.toast')].map(t=>t.textContent)})");
      console.log('  debug state: ' + dbg);
      throw e;
    }
    // one streamed exchange so the chat page has live-looking content
    await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'Describe the fog.');})()`);
    await cdp.evalJS("document.querySelector('.send-btn').click()");
    await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.msg.assistant')].length >= 2"), 30000, 'streamed reply');
  });

  // ---------- per-page screenshots + audits ----------
  const nav = (route) => cdp.evalJS(`window.useData.getState().navigate('${route}')`);
  await run('pages', async () => {
    await nav('chat');     await audit('chat', '01-chat.png');
    await nav('story');    await audit('story bible', '02-story.png');
    await nav('chapters'); await audit('chapters', '03-chapters.png');
    await nav('flow');     await audit('flow', '04-flow.png');
    await nav('projects'); await audit('projects', '05-projects.png');
    await nav('stats');    await audit('stats', '06-stats.png');
    await nav('about');    await audit('about', '07-about.png');
  });

  await run('settings sections', async () => {
    await nav('settings');
    await sleep(400);
    for (const s of ['providers', 'appearance', 'styles', 'usage', 'memory', 'behavior', 'agentmd', 'skills', 'plugins', 'automations', 'mcp', 'data']) {
      await cdp.evalJS(`[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.toLowerCase().includes('${s.slice(0, 5)}')).click()`);
      await sleep(350);
      const issues = await cdp.evalJS(PROBE);
      check('settings/' + s + ': clean', issues.length === 0, issues.slice(0, 3).join(' | '));
      if (s === 'providers' || s === 'appearance' || s === 'styles' || s === 'usage' || s === 'data') await cdp.shot('08-settings-' + s + '.png');
    }
  });

  await run('new features (styles / tokens / pin / zen)', async () => {
    // Token chip: the streamed reply was saved with estimated tokens.
    await nav('chat');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 15000, 'composer back');
    check('token chip on messages', (await cdp.evalJS("!!document.querySelector('.tok-chip')")) === true);
    // Reply style picker: opens, lists builtins, picking one persists.
    check('style button in composer', (await cdp.evalJS("!!document.querySelector('.style-btn')")) === true);
    await cdp.evalJS("document.querySelector('.style-btn').click()");
    await sleep(300);
    const hasBuiltin = await cdp.evalJS("[...document.querySelectorAll('.ui-popover .ui-menu-item')].some(e=>/concise/i.test(e.textContent))");
    check('style popover lists builtins', hasBuiltin === true);
    await cdp.shot('12-style-picker.png');
    await cdp.evalJS("[...document.querySelectorAll('.ui-popover .ui-menu-item')].find(e=>/concise/i.test(e.textContent))?.click()");
    await sleep(300);
    check('picked style persisted', /concise/i.test(String(await cdp.evalJS("window.useSettings.getState().defaultStyleId || ''"))) === true);
    // Pinned chat: flip via DB, reload, expect it ordered first.
    const chatId = await cdp.evalJS("window.useData.getState().activeChatId");
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('updateChat',{id:'${chatId}',pinned:true});await window.useData.getState().reloadChatRelated();return 1;})()`);
    await sleep(400);
    const firstPinned = await cdp.evalJS("Number(window.useData.getState().chats[0]?.pinned)===1");
    check('pinned chat sorts first', firstPinned === true);
    // Zen mode: toggle adds the class, focus dims chrome via CSS.
    await cdp.evalJS("document.querySelector('.chat-header button[aria-label*=" + JSON.stringify('Zen') + "], .chat-header button[title*=Zen]')?.click()");
    await sleep(300);
    check('zen mode toggles', (await cdp.evalJS("!!document.querySelector('.chat-root.zen')")) === true);
    await cdp.shot('13-zen-mode.png');
    await cdp.evalJS("document.querySelector('.chat-header button[aria-label*=" + JSON.stringify('Zen') + "], .chat-header button[title*=Zen]')?.click()");
    await sleep(200);
    // Settings → Styles shows the six builtins.
    await nav('settings');
    await sleep(300);
    await cdp.evalJS("[...document.querySelectorAll('.settings-nav button')].find(b=>/style/i.test(b.textContent)).click()");
    await sleep(400);
    const builtinRows = await cdp.evalJS("document.querySelectorAll('.style-row').length");
    check('styles section lists builtins', builtinRows >= 6, 'rows=' + builtinRows);
  });

  await run('prompt library shortcut', async () => {
    // The listener lives in the Composer — a chat must be open first.
    await cdp.evalJS(`window.useData.getState().navigate('chat')`);
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 15000, 'composer for shortcut');
    await cdp.evalJS("window.dispatchEvent(new CustomEvent('inkwell:open-prompts'))");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.prompt-menu')"), 5000, 'prompt menu via shortcut');
    check('event shortcut opens library (draft-safe)', true);
    const seedKept = await cdp.evalJS("document.querySelector('.comp-box textarea').value.startsWith('/')");
    check('empty composer seeded with /', seedKept === true);
    await cdp.shot('09-prompt-menu.png');
    await cdp.evalJS("(function(){var b=[...document.querySelectorAll('.prompt-menu-head button')].pop();b.click();})()");
    // palette lists the new command
    await cdp.evalJS("window.__inkwellOpenPalette()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 5000, 'palette open');
    await cdp.evalJS("(function(){var i=document.querySelector('.palette input');var p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;p.call(i,'prompt');i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await sleep(300);
    const found = await cdp.evalJS("[...document.querySelectorAll('.palette-item .plabel')].some(e=>/prompt library/i.test(e.textContent))");
    check('palette lists Prompt Library (Ctrl+/)', found === true);
    await cdp.shot('10-palette-prompt.png');
    await cdp.evalJS("(function(){document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));})()");
  });

  await run('themes', async () => {
    await nav('chat');
    await sleep(400);
    for (const th of ['midnight-ink', 'nord', 'sepia', 'light-paper']) {
      // (window.useSettings exposed by src/main.tsx for test harnesses)
      await cdp.evalJS(`window.useSettings.getState().set('theme', '${th}')`);
      await sleep(450);
      const issues = await cdp.evalJS(PROBE);
      check('theme ' + th + ': clean', issues.length === 0, issues.slice(0, 3).join(' | '));
      await cdp.shot('11-theme-' + th + '.png');
    }
    await cdp.evalJS(`window.useSettings.getState().set('theme', 'dark-classic')`);
  });

  // ---------- verdict ----------
  if (consoleErrors.length) {
    check('no renderer console errors', false, consoleErrors.slice(0, 3).join(' || '));
  } else {
    check('no renderer console errors', true);
  }

  cleaningUp = true;
  cdp.close();
  console.log('\ncleanup: killing processes...');
  try { electron.kill(); } catch {}
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { shell: true }); } catch {}
  try { vite.kill(); } catch {}
  try { server.close(); } catch {}
  clearTimeout(watchdog);
  console.log(failures === 0 ? '\nVISUAL REVIEW CLEAN — screenshots in docs/review/' : '\n' + failures + ' VISUAL ISSUE(S) FOUND');
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
