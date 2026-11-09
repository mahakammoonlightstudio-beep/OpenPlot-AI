/**
 * Progress screenshots for v1.2.5 (ASCII only).
 *
 * Boots the real app (vite + electron, isolated APPDATA), seeds a realistic
 * "Harbor Lights" demo workspace through the same mock OpenAI provider the
 * visual-review harness uses, then captures the curated 1.2.5 highlights into
 * preview-1.2.5/ as PNG.
 *
 * Deliberately NON-destructive: unlike visual-review.mjs this script
 * NEVER runs taskkill on electron.exe /IM — if a dev session is open it must
 * survive. It reuses a vite that already listens on 5173 (dev server serves
 * current source), or starts one when none is up.
 *
 * Run: node scripts/progress-shots.mjs
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
const OUT = path.join(PROJ, 'preview-1.2.5');

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
// Plain text rounds stream a short word-wrapped reply (same cadence as the
// visual-review harness). A user message containing USE_TOOLS parks the run
// into a scripted agent sequence: read Story Bible -> create lore entry ->
// save a memory, then a normal streamed reply. create_story_entry needs no
// projectId: the run ctx already pins the active (seeded) project.
const WORDS = ['The', ' ledger', ' reads', ' like', ' coordinates', '.', ' Three', ' piers', ',',
  ' one', ' tide', ' chart', ' —', ' and', ' a', ' man', ' who', ' never', ' signed', ' the', ' manifest', '.'];
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
      const parsed = JSON.parse(body || '{}');
      const msgs = parsed.messages || [];
      const last = msgs[msgs.length - 1] || {};
      const sse = (frames) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const toolFrame = (name, args) => [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' } ] }
      ];
      const wordFrame = () => WORDS.map((w, i) => ({ choices: [{ delta: { content: w }, finish_reason: i === WORDS.length - 1 ? 'stop' : null }] }));

      if (!agentSeq.length && last.role === 'user' && /use the tools/i.test(String(last.content))) {
        agentSeq = [
          () => toolFrame('read_story_bible', {}),
          () => toolFrame('create_story_entry', { kind: 'lore', title: 'The Harbor Ledger', content: 'A customs ledger whose freight totals form coordinates. Kept unsigned on the shelf past Pier 7.', tags: ['mystery'] }),
          () => toolFrame('add_memory', { content: 'The ledger numbers are coordinates — check them against the tide charts.', source: 'chat' })
        ];
      }
      if (agentSeq.length && (last.role === 'user' || last.role === 'tool')) {
        sse(agentSeq.shift()());
        return;
      }
      if (parsed.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
        return;
      }
      sse(wordFrame());
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});
let agentSeq = [];
let electronPid = 0; // set at spawn; the FATAL path kills ONLY this tree

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
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false });
      fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    },
    raw: send,
    close: () => { try { ws.close(); } catch {} }
  };
}

const setReactArea = `(function(el,val){var p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');p.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));})`;

(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: progress shots timed out'); process.exit(2); }, 300000);
  fs.mkdirSync(OUT, { recursive: true });

  // Reuse the vite dev server when one is already up on IPv4 (a dev session
  // must survive), otherwise start a private one. Chromium resolves localhost
  // 127.0.0.1-first, so an IPv4-listening vite is what the app needs; ::1-only
  // servers (a common dev-session shape) get their own sibling on IPv4 — TCP
  // port numbers are per address family, so both can share :5173.
  let vite = null;
  let ipv4Up = false;
  try { ipv4Up = (await fetch('http://127.0.0.1:5173/')).ok; } catch { /* IPv4 free */ }
  if (ipv4Up) {
    console.log('reusing vite on http://127.0.0.1:5173 (already running — not touched)');
  } else {
    vite = spawn('npx', ['vite', '--port', '5173', '--strictPort', '--host', '127.0.0.1'], { shell: true, stdio: 'ignore', cwd: PROJ });
    await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:5173/')).ok; } catch { return false; } }, 60000, 'vite ready (IPv4)');
    console.log('vite ready (own, IPv4)');
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mockPort = server.address().port;
  console.log('mock provider: http://127.0.0.1:' + mockPort + '/v1');
  console.log('screenshots -> ' + OUT + '\n');

  const cdpPort = 10400 + Math.floor(Math.random() * 300);
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-progress-'));
  const electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '.'], {
    stdio: ['ignore', 'ignore', 'pipe'], cwd: PROJ,
    // OPENPLOT_DATA_DIR fully isolates the DB from the user's real workspace.
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData }
  });
  electronPid = electron.pid || 0;
  let consoleErrors = [];
  electron.stderr.on('data', (d) => {
    const s = d.toString();
    if (/ERROR:CONSOLE\(\d+\)/.test(s) && !/Autofill|Download the React DevTools|Electron Security Warning/.test(s)) {
      consoleErrors.push(s.slice(0, 200));
    }
  });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  const cdp = await connectCdp(cdpPort);
  console.log('CDP connected\n');

  // Backgrounded Electron windows get Chromium-throttled (timers crawl, paint
  // stalls, awaits starve the evalPromise). The user's own app is in front, so
  // this instance will live in the background — activate it via CDP at every
  // critical moment instead of fighting async flakes.
  const wake = async () => {
    try { await cdp.raw('Page.bringToFront'); } catch { /* best effort */ }
    try { await cdp.raw('Page.setWebLifecycleState', { state: 'active' }); } catch { /* may refuse */ }
  };
  await wake();

  const nav = (route) => (async () => {
    await wake();
    await cdp.evalJS(`window.useData.getState().navigate('${route}')`);
  })();
  // captureScreenshot can hang on a throttled/backgrounded window (the
  // visual-review harness hit the same thing). Poke the renderer (a cheap
  // evaluate wakes painting) and retry the capture instead of dying on it.
  async function capture(file) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await wake();
        await withTimeout(cdp.evalJS('document.title'), 8000, 'wake poke');
        const r = await Promise.race([
          cdp.raw('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false }),
          sleep(14000).then(() => { throw new Error('capture slow (attempt ' + attempt + '), retrying'); })
        ]);
        fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
        return;
      } catch (e) {
        lastErr = e;
        await sleep(700 * attempt);
      }
    }
    throw lastErr;
  }
  async function shot(name, file, waitSel) {
    if (waitSel) await waitUntil(() => cdp.evalJS(`!!document.querySelector(${JSON.stringify(waitSel)})`), 30000, file + ' selector');
    await sleep(500);
    await capture(file);
    console.log('  [' + name + '] ' + file);
  }
  const settingsSection = async (label) => {
    await wake();
    const info = await cdp.evalJS(`(function(){
      var bs=[...document.querySelectorAll('.settings-nav button')];
      var b=bs.find(x=>x.textContent.toLowerCase().includes('${label}'));
      if(b)b.click();
      var act=[...document.querySelectorAll('.settings-nav button.active')].map(x=>x.textContent.trim());
      return JSON.stringify({n:bs.length,hit:!!b,active:act.slice(0,2)});
    })()`);
    console.log('    section<' + label + '> ' + info);
    await sleep(450);
  };

  // ---------- seed ----------
  console.log('seed Harbor Lights workspace');
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.app')"), 90000, 'app shell');
  await waitUntil(() => cdp.evalJS("!!window.useSettings.getState().version"), 30000, 'settings loaded');
  // Stamp the "What's new" modal away (markup-independent); the About card stays.
  await cdp.evalJS("window.useSettings.getState().set('lastSeenVersion', window.useSettings.getState().version)");
  await cdp.evalJS("window.useData.getState().navigate('home')");
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.welcome-card')"), 30000, 'home cards');
  await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll');return 1;})()");
  await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProvider',{name:'Mock Harbor',baseUrl:'http://127.0.0.1:${mockPort}/v1',apiKey:'sk-visual',enabled:true,models:['mock-visual'],kind:'openai'})).data;})()`);
  await cdp.evalJS("window.useSettings.getState().set('defaultModel','mock-visual')");
  const proj = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createProject',{name:'Harbor Lights',description:'A fog-laden port city mystery',context:'Set in 1930s Mahakam; gas lamps, river barges, quiet corruption.',format:'novel',rating:'teen'})).data;})()`);
  for (const [kind, title, content, tags] of [
    ['character', 'Sari Winata', 'Harbor customs officer. Keeps a ledger of every lie she hears.', ['lead']],
    ['location', 'Pier 7', 'The night shift sleeps in the cargo netting; the sea keeps its side of the bargain.', ['act1']],
    ['lore', 'The Tide Register', 'A 1931 tide chart annotated in pencil: three dates circled, one struck out.', ['mystery']]
  ]) {
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createStory',{projectId:'${proj.id}',kind:'${kind}',title:${JSON.stringify(title)},content:${JSON.stringify(content)},tags:${JSON.stringify(tags)}});return 1;})()`);
  }
  await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createChapter',{projectId:'${proj.id}',title:'Chapter 1 — Low Tide',content:'The letter arrived on a Tuesday, folded inside a shipping manifest.',status:'draft'});return 1;})()`);
  for (const [act, title, summary] of [[1, 'The Body at Pier 7', 'A customs officer finds a ledger with impossible numbers.'], [2, 'River Bargains', 'Sari trades silence for access; the city watches.'], [3, 'High Water', 'The flood forces every secret into the open.']]) {
    await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('createFlowBeat',{projectId:'${proj.id}',act:${act},title:${JSON.stringify(title)},summary:${JSON.stringify(summary)}});return 1;})()`);
  }
  await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMemory',{content:'Prefers terse chapter endings.',source:'manual'});return 1;})()`);
  const chat = await cdp.evalJS(`(async()=>{return (await window.inkwell.dbCall('createChat',{title:'Plotting the ledger twist',project_id:'${proj.id}'})).data;})()`);
  await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'user',content:'What if the ledger numbers are coordinates?'});return 1;})()`);
  await cdp.evalJS(`(async()=>{await window.inkwell.dbCall('addMessage',{chatId:'${chat.id}',role:'assistant',content:'Then the harbor itself becomes a cipher — every manifest a map. **Nice.**',model:'mock-visual'});return 1;})()`);
  await cdp.evalJS("window.useData.getState().load()");
  await cdp.evalJS("window.useData.getState().setActiveChat('" + chat.id + "')");
  await cdp.evalJS(`window.useData.getState().setActiveProject('${proj.id}')`);
  await wake();
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 15000, 'composer after chat open');

  // ---------- 1. Home (new landing screen in 1.2.5) ----------
  await nav('home');
  await shot('home', '01-home.png', '.welcome-card');

  // ---------- 2. Chat with a streamed reply ----------
  await nav('chat');
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 15000, 'composer');
  await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'Describe the fog.');})()`);
  await cdp.evalJS("document.querySelector('.send-btn').click()");
  await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.msg.assistant')].length >= 2"), 30000, 'streamed reply');
  await shot('chat', '02-chat.png', '.msg.assistant');

  // ---------- 3. Tool log (Tools used . N) from a real agent run ----------
  await wake();
  // Agent ON so the shot tells a coherent story: agent mode ran the tools.
  await cdp.evalJS("(function(){var b=document.querySelector('.agent-toggle');if(b)b.click();return !!b;})()");
  await sleep(350);
  await cdp.evalJS(`(function(){var ta=document.querySelector('.comp-box textarea');${setReactArea}(ta,'Use the tools: read the story bible and log the harbor ledger as lore.');})()`);
  await cdp.evalJS("document.querySelector('.send-btn').click()");
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.tool-log')"), 30000, 'tool log appears');
  await waitUntil(() => cdp.evalJS("[...document.querySelectorAll('.msg.assistant')].length >= 3"), 60000, 'agent reply');
  // The panel folds itself once the run ends — reopen the newest one.
  await cdp.evalJS("(function(){var h=[...document.querySelectorAll('.msg.assistant:last-child .tl-head, .tl-head')].pop();if(h)h.click();return !!h;})()");
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.tl-body')"), 5000, 'tool log open');
  await shot('tool log', '03-tool-log.png', '.tl-body');

  // ---------- 4. Composer: Agent OFF + Web ON (the 1.2.5 decoupling) ----------
  await cdp.evalJS("(function(){var b=document.querySelector('.agent-toggle');if(b)b.click();return !!b;})()");
  await sleep(300);
  await cdp.evalJS("(function(){var b=document.querySelector('.web-toggle');if(b)b.click();return !!b;})()");
  await sleep(350);
  await shot('composer web', '04-composer-web.png', '.web-toggle');

  // ---------- 5. Version arrows below the bubble ----------
  await wake();
  await cdp.evalJS(`(function(){var btn=[...document.querySelectorAll('.msg.user .actions button')].find(b=>/edit/i.test(b.title||''));if(btn)btn.click();return !!btn;})()`);
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.edit-box textarea')"), 5000, 'edit box');
  await cdp.evalJS(`(function(){var ta=document.querySelector('.edit-box textarea');${setReactArea}(ta,'What if the ledger numbers are coordinates tied to the 1931 tide charts?');})()`);
  await cdp.evalJS("(function(){document.querySelector('.edit-actions .small.primary').click();})()");
  // Editing drops every turn after the edited prompt, so the transcript ends
  // small: original turn + new version + one fresh reply. Wait for the fork
  // marker itself (the arrows under the bubble) instead of a reply count.
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.variant-nav')"), 30000, 'variant nav');
  await sleep(2500);
  await shot('version arrows', '05-version-arrows.png', '.variant-nav');

  // ---------- 6-9. Studio pages ----------
  await nav('story');
  // The World tab is empty in the demo; show Lore instead — it holds the
  // seeded Tide Register AND the entry the agent created in the tool-run step.
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.kind-tabs button')"), 30000, 'story kind tabs');
  await cdp.evalJS("(function(){var b=[...document.querySelectorAll('.kind-tabs button')].find(x=>/^lore/i.test(x.textContent.trim()));if(b)b.click();return !!b;})()");
  await sleep(400);
  await shot('story bible lore', '06-story-bible.png', null);
  await nav('chapters');
  await sleep(500);
  // Open the seeded chapter so the manuscript editor is visible, not an
  // empty pane. The list item click loads it into the right-hand editor.
  await cdp.evalJS("(function(){var it=document.querySelector('.chapter-item');if(it)it.click();return !!it;})()");
  await sleep(700);
  await shot('chapters', '07-chapters.png', '.chapter-item.active');
  await nav('flow');     await shot('flow board', '08-flow.png', null);
  await nav('stats');    await shot('stats', '09-stats.png', null);

  // ---------- 10-11. Settings: providers + appearance (15 themes) ----------
  // Advanced mode so MCP / Automations / Plugins sections exist in the nav.
  await nav('settings'); await sleep(400);
  await cdp.evalJS("window.useSettings.getState().set('settingsMode','advanced')");
  await settingsSection('provider');
  await shot('settings providers', '10-settings-providers.png', null);
  await settingsSection('appearance');
  await shot('settings appearance', '11-settings-appearance.png', null);

  // ---------- 12-14. The three new themes, shot on the chat ----------
  await nav('chat'); await sleep(400);
  await wake();
  for (const [th, file] of [['gruvbox', '12-theme-gruvbox.png'], ['catppuccin', '13-theme-catppuccin.png'], ['sandstone', '14-theme-sandstone.png']]) {
    await cdp.evalJS(`window.useSettings.getState().set('theme', '${th}')`);
    await sleep(600);
    const probe = await cdp.evalJS("JSON.stringify([document.documentElement.getAttribute('data-theme'), getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()])");
    console.log('    theme ' + th + ' -> data-theme + --bg: ' + probe);
    await shot('theme ' + th, file, '.comp-box');
  }
  await cdp.evalJS(`window.useSettings.getState().set('theme', 'dark-classic')`);

  // ---------- 15-18. Settings sections that explain themselves ----------
  await nav('settings'); await sleep(400);
  await cdp.evalJS("window.useSettings.getState().set('settingsMode','advanced')");
  await settingsSection('data');     await shot('settings data reset', '15-settings-data.png', null);
  await settingsSection('skill');    await shot('skills v2', '16-skills.png', null);
  await settingsSection('mcp');      await shot('mcp bridge', '17-mcp.png', null);
  await settingsSection('autom');    await shot('automations', '18-automations.png', null);

  // ---------- 19. Command palette ----------
  await wake();
  await cdp.evalJS("window.__inkwellOpenPalette()");
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.palette input')"), 5000, 'palette open');
  await shot('command palette', '19-command-palette.png', '.palette input');
  await cdp.evalJS("(function(){document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));})()");

  // ---------- 20. Prompt library ----------
  await nav('chat');
  await wake();
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.comp-box textarea')"), 15000, 'composer for prompts');
  await cdp.evalJS("window.dispatchEvent(new CustomEvent('inkwell:open-prompts'))");
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.prompt-menu')"), 5000, 'prompt menu');
  await shot('prompt library', '20-prompt-library.png', '.prompt-menu');
  await cdp.evalJS("(function(){var b=[...document.querySelectorAll('.prompt-menu-head button')].pop();if(b)b.click();})()");

  // ---------- 21. In-app guide ----------
  await wake();
  await cdp.evalJS("window.useData.getState().setGuideSlug('getting-started')");
  await nav('guide');
  await sleep(600);
  await shot('guide', '21-guide.png', null);

  // ---------- 22. Zen mode ----------
  await nav('chat'); await sleep(400);
  await cdp.evalJS("(function(){var b=document.querySelector('.chat-header button[title*=Zen]')||[...document.querySelectorAll('.chat-header button')].find(x=>/zen/i.test(x.title||x.getAttribute('aria-label')||''));if(b)b.click();return !!b;})()");
  await sleep(350);
  // The dimming is focus-driven: header + composer sit at 35% opacity while
  // NOTHING inside them has focus or hover; focus-within restores them to 1.
  // Blur the just-clicked toggle so the dim state settles before capture.
  await cdp.evalJS("(function(){var a=document.activeElement;if(a&&a.blur)a.blur();return true;})()");
  await sleep(500);
  const zenOp = await cdp.evalJS("(function(){var g=function(s){var e=document.querySelector(s);return e?getComputedStyle(e).opacity:'none'};return g('.chat-root.zen .chat-header')+'/'+g('.chat-root.zen .composer2');})()");
  console.log('zen chrome opacity: ' + zenOp);
  await shot('zen mode', '22-zen-mode.png', '.chat-root.zen');
  await cdp.evalJS("(function(){var ta=document.querySelector('.comp-box textarea');if(ta)ta.blur();})()");
  await cdp.evalJS("(function(){var b=document.querySelector('.chat-header button[title*=Zen]')||[...document.querySelectorAll('.chat-header button')].find(x=>/zen/i.test(x.title||x.getAttribute('aria-label')||''));if(b)b.click();return !!b;})()");

  // ---------- 23. About (new-in-this-version card) ----------
  await nav('about');
  await sleep(500);
  await shot('about', '23-about.png', null);

  // ---------- cleanup ----------
  cdp.close();
  console.log('\ncleanup: stopping ONLY the instance this script started...');
  try { spawn('taskkill', ['/F', '/T', '/PID', String(electron.pid)], { shell: true }); } catch {}
  try { if (vite) vite.kill(); } catch {}
  try { server.close(); } catch {}
  clearTimeout(watchdog);
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort();
  console.log('\n' + files.length + ' screenshots in ' + OUT + ':');
  for (const f of files) console.log('  ' + f);
  if (consoleErrors.length) console.log('\nrenderer console errors (check before sharing): ' + consoleErrors.slice(0, 3).join(' || '));
  await sleep(300);
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  if (electronPid) { try { spawn('taskkill', ['/F', '/T', '/PID', String(electronPid)], { shell: true }); } catch {} }
  process.exit(1);
});
