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
const OUT = process.env.OPENPLOT_SHOTS
  ? path.resolve(process.env.OPENPLOT_SHOTS)
  : path.join(PROJ, 'docs', 'review');

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
      // fromSurface:false works even when the OS window is hidden/backgrounded.
      // A throttled window still times a capture out now and then; one retry
      // keeps a flaky frame from failing a whole review (a real hang still
      // throws after the second attempt).
      let lastErr;
      // Two capture paths: `fromSurface:false` (works on a hidden window) and
      // `fromSurface:true` (composites the visible surface). When one stalls,
      // the other usually answers, so a flaky frame no longer fails the run.
      for (const fromSurface of [false, true, false]) {
        try {
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface });
          fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
          return;
        } catch (err) {
          lastErr = err;
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      throw lastErr;
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
    // Wait for the shell, not for one page's markup: the app opens on Home and
    // a slow first paint used to blow the whole seed budget.
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.app')"), 90000, 'app shell');
    // A fresh profile opens "What's new" over Home. Stamp it through the store
    // (markup-independent) so it cannot cover the screenshots — but only after
    // settings report a version, otherwise the stamp is '' and the modal opens
    // again the moment load() finishes.
    await waitUntil(() => cdp.evalJS("!!window.useSettings.getState().version"), 30000, 'settings loaded');
    await cdp.evalJS("window.useSettings.getState().set('lastSeenVersion', window.useSettings.getState().version)");
    await cdp.evalJS("window.useData.getState().navigate('home')");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'home cards');
    await sleep(300);
    await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll');return 1;})()");
    // dbCall resolves to an {ok,data} envelope — rows must be unwrapped via
    // .data or every downstream id becomes the string "undefined".
    const prov = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProvider',{name:'Mock Harbor',baseUrl:'http://127.0.0.1:${mockPort}/v1',apiKey:'sk-visual',enabled:true,models:['mock-visual'],kind:'openai'})).data;})()`);
    // Set the default model through the LIVE store (a raw dbCall after boot
    // leaves the in-memory settings empty and send() refuses to run).
    await cdp.evalJS("window.useSettings.getState().set('defaultModel','mock-visual')");
    const proj = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProject',{name:'Harbor Lights',description:'A fog-laden port city mystery',context:'Set in 1930s Mahakam; gas lamps, river barges, quiet corruption.',format:'novel',rating:'teen'})).data;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createStory',{projectId:'${proj.id}',kind:'character',title:'Sari Winata',content:'Harbor customs officer. Keeps a ledger of every lie she hears.',tags:['lead']});return 1;})()`);
    // Build multi-paragraph prose in Node and JSON-encode it: embedding real
    // newlines or escaped quotes in the evaluated expression is how this seed
    // used to die with a SyntaxError before any screenshot was taken.
    const chapterProse = [
      'The letter arrived on a Tuesday, folded inside a shipping manifest.',
      'Sari read it twice. The harbor outside her window was still asleep under a quilt of fog, and the cranes along Pier 7 stood like gallows in the grey light.',
      '“They found another one,” the note said. No signature. No date.'
    ].join('\n\n');
    const firstChapter = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createChapter',{projectId:'${proj.id}',title:'Chapter 1 — Low Tide',content:${JSON.stringify(chapterProse)},status:'draft'})).data;})()`);
    const dumpA = 'The harbor was quiet and foggy. Sari looked at the letter and felt afraid.';
    const dumpB = 'A paragraph the agent cut: the customs house smelled of wet rope and old tobacco, and nobody there remembered the last honest manifest.';
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addTextDump',{projectId:'${proj.id}',chapterId:'${firstChapter.id}',chapterTitle:'Chapter 1 — Low Tide',source:'writing',action:'rephrase',scope:'passage',original:${JSON.stringify(dumpA)},replacement:'The harbor slept under a quilt of fog. Sari read the letter twice.',startOffset:0,endOffset:80});return 1;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addTextDump',{projectId:'${proj.id}',chapterId:'${firstChapter.id}',chapterTitle:'Chapter 1 — Low Tide',source:'agent',action:'delete',scope:'chapter',original:${JSON.stringify(dumpB)},replacement:''});return 1;})()`);
    for (const [act, title, summary] of [[1,'The Body at Pier 7','A customs officer finds a ledger with impossible numbers.'],[2,'River Bargains','Sari trades silence for access; the city watches.'],[3,'High Water','The flood forces every secret into the open.']]) {
      await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createFlowBeat',{projectId:'${proj.id}',act:${act},title:${JSON.stringify(title)},summary:${JSON.stringify(summary)}});return 1;})()`);
    }
    const chat = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createChat',{title:'Plotting the ledger twist',project_id:'${proj.id}'})).data;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'user',content:'What if the ledger numbers are coordinates?'});return 1;})()`);
    // Seeded WITH tool detail so the screenshots exercise the persisted panels
    // (web research box + agent tool log) instead of empty transcript.
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'assistant',content:'Then the harbor itself becomes a cipher — every manifest a map. **Nice.**',model:'mock-visual',toolSteps:[{name:'web_search',kind:'web',detail:'5 results',ok:true},{name:'web_fetch',kind:'web',detail:'Port authority ledger · 12.4k chars',ok:true},{name:'create_story_entry',kind:'entry',detail:'Sari Winata',ok:true},{name:'create_chapter',kind:'chapter',detail:'Chapter 1 — Low Tide',ok:false}]});return 1;})()`);
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMemory',{content:'Prefers terse chapter endings.',source:'manual'});return 1;})()`);
    await cdp.evalJS("window.useData.getState().load()");
    await cdp.evalJS(`window.useData.getState().setActiveChat('${chat.id}')`);
    // Open both panels once the reply is on screen: a closed panel would hide
    // the very rows these screenshots exist to show.
    try {
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.search-log')"), 15000, 'search panel');
      await cdp.evalJS("document.querySelector('.search-log .sl-bar').click()");
      await cdp.evalJS("document.querySelector('.tool-log .tl-head')?.click()");
      await sleep(250);
    } catch { /* the modal pages still capture fine without it */ }
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
  // Both tool panels start folded; expand them so the shots show real rows.
  const openPanels = async () => {
    await sleep(250);
    await cdp.evalJS("document.querySelector('.search-log .sl-bar[aria-expanded=\"false\"]')?.click()");
    await cdp.evalJS("document.querySelector('.tool-log .tl-head[aria-expanded=\"false\"]')?.click()");
    // Payload: nothing focused, so a later capture is not waiting on a focused
    // control's focus ring / caret.
    await cdp.evalJS("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
    await sleep(250);
  };
  await run('pages', async () => {
    // Home is the landing screen in v1.2.5 — capture it before any chat opens.
    await nav('home');     await audit('home', '14-home.png');
    await nav('chat');     await openPanels(); await audit('chat', '01-chat.png');
    await nav('story');    await audit('story bible', '02-story.png');
    await nav('chapters'); await audit('chapters', '03-chapters.png');
    await nav('flow');     await audit('flow', '04-flow.png');
    await nav('projects'); await audit('projects', '05-projects.png');
    await nav('stats');    await audit('stats', '06-stats.png');
    await nav('write');    await audit('writing', '18-write.png');
    await nav('dump');     await audit('text dump', '19-dump.png');
    await nav('about');    await audit('about', '07-about.png');
  });

  await run('writing diff + Text Dump', async () => {
    await nav('write');
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.write-text')"), 20000, 'writing board');
    const before = await cdp.evalJS("window.inkwell.dbCall('countTextDumps').then(r=>r.data)");
    await cdp.evalJS("(function(){var el=document.querySelector('.write-text');el.focus();el.setSelectionRange(0,90);return 1;})()");
    await cdp.evalJS("[...document.querySelectorAll('.write-ai-actions button')].find(b=>/rephrase/i.test(b.textContent))?.click()");
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.write-diff')"), 30000, 'diff preview');
    const diffParts = await cdp.evalJS("document.querySelectorAll('.write-diff ins, .write-diff del').length");
    check('writing: AI result renders an inline diff', diffParts > 0, 'parts=' + diffParts);
    await cdp.shot('20-write-diff.png');
    await cdp.evalJS("[...document.querySelectorAll('.wr-actions button')].find(b=>/replace/i.test(b.textContent))?.click()");
    await waitUntil(async () => {
      const n = await cdp.evalJS("window.inkwell.dbCall('countTextDumps').then(r=>r.data)");
      return Number(n) === Number(before) + 1;
    }, 8000, 'text dump row from writing');
    check('writing: applying a rewrite stores the displaced text', true);
    await cdp.evalJS(`window.useData.getState().navigate('dump')`);
    await waitUntil(() => cdp.evalJS("document.querySelectorAll('.dump-row').length >= 3"), 10000, 'dump rows');
    await cdp.shot('21-dump-after-write.png');
  });

  await run('settings sections', async () => {
    await nav('settings');
    await sleep(400);
    for (const s of ['providers', 'appearance', 'styles', 'usage', 'memory', 'behavior', 'agentmd', 'skills', 'plugins', 'automations', 'mcp', 'data']) {
      await cdp.evalJS(`(function(){var btn=[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.toLowerCase().includes('${s.slice(0, 5)}'));if(btn)btn.click();return !!btn;})()`);
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
    // A leftover overlay from an earlier step would be audited as if it were
    // the page: dismiss anything floating before measuring contrast.
    await cdp.evalJS("(function(){for(let i=0;i<2;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 1;})()");
    await sleep(200);
    // Navigating back remounts the transcript, which folds the panels again.
    await openPanels();
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

  await run('light writing + dump', async () => {
    await cdp.evalJS(`window.useSettings.getState().set('theme', 'light-paper')`);
    await nav('write');
    await audit('writing · light-paper', '22-write-light.png');
    await nav('dump');
    await audit('text dump · light-paper', '23-dump-light.png');
    await cdp.evalJS(`window.useSettings.getState().set('theme', 'dark-classic')`);
  });

  // Overlays are audited on their own surface: a menu floating over the chat has
  // its own background, so a chip that passes on the page can fail in the menu.
  await run('overlay contrast', async () => {
    await nav('chat');
    await sleep(400);
    for (const th of ['dark-classic', 'midnight-ink', 'nord', 'sepia', 'light-paper']) {
      await cdp.evalJS(`window.useSettings.getState().set('theme', '${th}')`);
      await sleep(350);
      // Escape does not dismiss every overlay (the prompt menu has its own close
      // button), and an overlay left open would be measured by the next check.
      const closeAll = async () => {
        await cdp.evalJS("(function(){var b=[...document.querySelectorAll('.prompt-menu-head button')].pop();if(b)b.click();return 1;})()");
        await cdp.evalJS("(function(){for(let i=0;i<2;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 1;})()");
        await sleep(250);
      };

      // 1. Prompt library menu
      await cdp.evalJS("window.dispatchEvent(new CustomEvent('inkwell:open-prompts'))");
      await waitUntil(() => cdp.evalJS("!!document.querySelector('.prompt-menu')"), 5000, 'prompt menu overlay');
      await sleep(250);
      let issues = await cdp.evalJS(PROBE);
      check('overlay prompt-menu · ' + th, issues.length === 0, issues.slice(0, 3).join(' | '));
      if (th === 'nord') await cdp.shot('15-overlay-prompt-nord.png');
      await closeAll();

      // 2. Model switcher popover
      const modelOpened = await cdp.evalJS("(function(){var b=document.querySelector('.model-btn');if(b){b.click();return 1;}return 0;})()");
      if (modelOpened) {
        await sleep(300);
        issues = await cdp.evalJS(PROBE);
        check('overlay model-menu · ' + th, issues.length === 0, issues.slice(0, 3).join(' | '));
        if (th === 'light-paper') await cdp.shot('16-overlay-model-light.png');
        await closeAll();
      }

      // 3. Skills popover in the composer (its rows carry accent text)
      const skillsOpened = await cdp.evalJS("(function(){var b=document.querySelector('.ability-btn');if(b){b.click();return 1;}return 0;})()");
      if (skillsOpened) {
        await sleep(300);
        issues = await cdp.evalJS(PROBE);
        check('overlay skills-menu · ' + th, issues.length === 0, issues.slice(0, 3).join(' | '));
        await closeAll();
      }

      // 4. Command palette
      const paletteOpened = await cdp.evalJS("(function(){if(!window.__inkwellOpenPalette)return 0;window.__inkwellOpenPalette();return 1;})()");
      if (paletteOpened) {
        await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 5000, 'palette overlay');
        await sleep(250);
        issues = await cdp.evalJS(PROBE);
        check('overlay palette · ' + th, issues.length === 0, issues.slice(0, 3).join(' | '));
        if (th === 'sepia') await cdp.shot('17-overlay-palette-sepia.png');
        await closeAll();
      }
    }
    await cdp.evalJS("window.useSettings.getState().set('theme', 'dark-classic')");
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
  console.log(failures === 0 ? '\nVISUAL REVIEW CLEAN — screenshots in ' + OUT : '\n' + failures + ' VISUAL ISSUE(S) FOUND');
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
