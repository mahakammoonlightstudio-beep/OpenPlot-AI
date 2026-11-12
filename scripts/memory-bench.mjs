/**
 * RAM / responsiveness benchmark (ASCII only, Windows-friendly).
 *
 * Boots the real Electron app against an isolated data directory, seeds a
 * heavy-but-realistic library, then records:
 *   - renderer JS heap (used / total) after a forced GC
 *   - DOM node count
 *   - total working set of every Electron process in this run's tree
 *   - time to open a 5,000-message chat and render its window
 *   - time to return Home
 *
 * No thresholds: this is a comparison harness (`node scripts/memory-bench.mjs`),
 * so it can be run before and after a performance change. It never touches the
 * user's real database (OPENPLOT_DATA_DIR points at a temp directory).
 */
import { execSync, spawn } from 'node:child_process';
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
    try { if (await fn()) return; } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
}

async function connectCdp(port) {
  let list = [];
  for (let i = 0; i < 50; i++) {
    try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch { /* booting */ }
    if (list.some((t) => t.type === 'page' && !/devtools/i.test(t.url))) break;
    await sleep(250);
  }
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('no CDP page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
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
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable').catch(() => {});
  return {
    async evalJS(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result?.value;
    },
    async gc() { await send('HeapProfiler.collectGarbage').catch(() => {}); },
    async addInitScript(source) { await send('Page.addScriptToEvaluateOnNewDocument', { source }); },
    async reload() { await send('Page.reload', {}); },
    close: () => { try { ws.close(); } catch { /* already closed */ } }
  };
}

/** Working set (KB) of the spawned Electron process and every descendant. */
function electronTreeRssKb(rootPid) {
  const script = [
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize",
    "$all | ConvertTo-Json -Compress"
  ].join('; ');
  let rows = [];
  try {
    const raw = execSync('powershell -NoProfile -Command "' + script + '"', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    rows = JSON.parse(raw || '[]');
    if (!Array.isArray(rows)) rows = [rows];
  } catch { return null; }
  const kids = new Map();
  for (const r of rows) {
    const parent = Number(r.ParentProcessId);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(r);
  }
  let total = 0;
  let count = 0;
  const queue = [Number(rootPid)];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((r) => Number(r.ProcessId) === pid);
    if (row) { total += Number(row.WorkingSetSize) || 0; count++; }
    for (const child of kids.get(pid) || []) queue.push(Number(child.ProcessId));
  }
  return { mb: Math.round((total / 1024 / 1024) * 10) / 10, processes: count };
}

function killTree(pid) {
  if (!pid) return;
  try { execSync('taskkill /F /T /PID ' + pid, { stdio: 'ignore' }); } catch { /* already gone */ }
}

const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-ram-'));
const cdpPort = 9900 + Math.floor(Math.random() * 90);
let vite = null;
let electron = null;
let cdp = null;

try {
  vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { shell: true, stdio: 'ignore', cwd: PROJ });
  await waitUntil(async () => { try { return (await fetch('http://localhost:5173/')).ok; } catch { return false; } }, 60000, 'vite ready');

  electron = spawn(electronExe, ['--remote-debugging-port=' + cdpPort, '--js-flags=--expose-gc', '.'], {
    stdio: 'ignore', cwd: PROJ,
    env: { ...process.env, INKWELL_DEV: '1', APPDATA: tmpAppData, OPENPLOT_DATA_DIR: tmpAppData }
  });
  electron.on('exit', (code) => { if (code) console.error('electron exited ' + code); });

  await waitUntil(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).ok; } catch { return false; } }, 60000, 'CDP endpoint');
  cdp = await connectCdp(cdpPort);
  await waitUntil(() => cdp.evalJS("!!document.querySelector('.app')"), 90000, 'app shell');
  // BENCH_LOW_MEMORY=1 forces the ≤4 GB code path (deviceMemory is coarse and
  // cannot be set through CDP) so the lean profile can be measured too.
  if (process.env.BENCH_LOW_MEMORY) {
    await cdp.addInitScript("Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get() { return 4; } })");
    await cdp.reload();
    await waitUntil(() => cdp.evalJS("!!document.querySelector('.app')"), 90000, 'app shell (low-memory)');
  }
  await waitUntil(() => cdp.evalJS("!!window.useSettings.getState().version"), 30000, 'settings');
  const profile = await cdp.evalJS("({ memory: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0 })");
  console.log('device profile: ' + (process.env.BENCH_LOW_MEMORY ? 'low-memory' : 'reported') + ' (deviceMemory=' + profile.memory + ' GB, cores=' + profile.cores + ')');

  await cdp.evalJS("window.useSettings.getState().set('lastSeenVersion', window.useSettings.getState().version)");
  await cdp.evalJS("window.useData.getState().navigate('home')");
  await cdp.evalJS("(async()=>{await window.inkwell.dbCall('resetAll'); return 1;})()");
  await cdp.evalJS("(async()=>{await window.useData.getState().load(); return 1;})()");
  await cdp.gc();
  await sleep(500);
  const empty = await cdp.evalJS(`({ usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), nodes: document.querySelectorAll('*').length })`);

  // ------------------------------------------------------------- seed library
  const seedStart = Date.now();
  const ids = await cdp.evalJS(`(async()=>{
    const db = (op, p = {}) => window.inkwell.dbCall(op, p);
    const unwrap = (r) => r && r.ok !== undefined ? r.data : r;
    const proj = unwrap(await db('createProject', { name: 'RAM Harbor', description: 'heavy fixture', format: 'novel' }));
    const words = 'The harbor bell rang once across the wet stones and every window answered with a darker silence. ';
    const chapterBody = words.repeat(700); // ~7,700 words per chapter
    const ids = [];
    for (let i = 0; i < 120; i++) {
      const c = unwrap(await db('createChapter', { projectId: proj.id, title: 'Chapter ' + (i + 1), content: chapterBody + '\\n\\nEnd of chapter ' + (i + 1) + '.', status: i % 3 ? 'draft' : 'done' }));
      ids.push(c.id);
    }
    for (let i = 0; i < 240; i++) {
      await db('createStory', { projectId: proj.id, kind: i % 4 ? 'character' : 'place', title: 'Entry ' + (i + 1), content: chapterBody.slice(0, 1800) + ' entry ' + i, tags: ['bench'] });
    }
    return { projectId: proj.id, firstChapter: ids[0] };
  })()`);
  console.log('seeded library in ' + ((Date.now() - seedStart) / 1000).toFixed(1) + 's');

  // ------------------------------------------------------------- long transcript
  const chatSeedStart = Date.now();
  const chat = await cdp.evalJS(`(async()=>{
    const db = (op, p = {}) => window.inkwell.dbCall(op, p);
    const unwrap = (r) => r && r.ok !== undefined ? r.data : r;
    const c = unwrap(await db('createChat', { title: 'Long bench chat', projectId: '${ids.projectId}' }));
    for (let i = 0; i < 5000; i++) {
      await db('addMessage', {
        chatId: c.id,
        role: i % 2 ? 'assistant' : 'user',
        content: i % 2
          ? 'The fog moved through the harbor like a patient animal, and Sari counted the bells before she answered. Message ' + i + '.'
          : 'What did the ledger say about message ' + i + '?'
      });
    }
    return c;
  })()`);
  console.log('seeded 5,000 messages in ' + ((Date.now() - chatSeedStart) / 1000).toFixed(1) + 's');

  // Reload everything into the renderer store (the state a normal boot reaches).
  const reloadMs = await cdp.evalJS(`(async()=>{
    const t = performance.now();
    await window.useData.getState().load();
    return Math.round(performance.now() - t);
  })()`);
  const pageMs = await cdp.evalJS(`(async()=>{
    const t = performance.now();
    await window.inkwell.dbCall('getMessagePage', { chatId: '${chat.id}', limit: 200 });
    return Math.round(performance.now() - t);
  })()`);
  await cdp.gc();
  await cdp.evalJS('window.gc && window.gc()');
  await sleep(700);

  const home = await cdp.evalJS(`({
    usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    totalMb: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
    nodes: document.querySelectorAll('*').length,
    chapters: window.useData.getState().chapters.length,
    story: window.useData.getState().story.length,
    chats: window.useData.getState().chats.length
  })`);

  const openMs = await cdp.evalJS(`(async()=>{
    const t = performance.now();
    window.useData.getState().setActiveChat('${chat.id}');
    while (!document.querySelector('.messages .msg')) await new Promise((r) => setTimeout(r, 16));
    for (let i = 0; i < 40 && document.querySelectorAll('.messages .msg').length < 20; i++) await new Promise((r) => setTimeout(r, 16));
    return Math.round(performance.now() - t);
  })()`);
  await sleep(500);
  await cdp.gc();
  await sleep(300);

  const chatState = await cdp.evalJS(`({
    usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    totalMb: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
    nodes: document.querySelectorAll('*').length,
    bubbles: document.querySelectorAll('.messages .msg').length
  })`);

  const homeBackMs = await cdp.evalJS(`(async()=>{
    const t = performance.now();
    window.useData.getState().navigate('home');
    while (!document.querySelector('.welcome-card')) await new Promise((r) => setTimeout(r, 16));
    return Math.round(performance.now() - t);
  })()`);
  await sleep(400);
  await cdp.gc();
  await sleep(300);
  const homeBack = await cdp.evalJS(`({
    usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    nodes: document.querySelectorAll('*').length
  })`);

  // Open/close the heavy chat twice more: a retained transcript or cache leak
  // shows up as a heap that keeps climbing after returning Home.
  await cdp.evalJS(`(async()=>{
    for (let i = 0; i < 2; i++) {
      window.useData.getState().setActiveChat('${chat.id}');
      while (!document.querySelector('.messages .msg')) await new Promise((r) => setTimeout(r, 16));
      await new Promise((r) => setTimeout(r, 250));
      window.useData.getState().navigate('home');
      await new Promise((r) => setTimeout(r, 250));
    }
    return 1;
  })()`);
  await cdp.gc();
  await sleep(400);
  const afterCycles = await cdp.evalJS(`+(performance.memory.usedJSHeapSize / 1048576).toFixed(1)`);

  const rss = electronTreeRssKb(electron.pid);
  const dbStats = await cdp.evalJS("(async()=>{const r = await window.inkwell.dbCall('dbStats'); return r && r.ok !== undefined ? r.data : r;})()");

  console.log('\n--- OpenPlot memory bench ---');
  console.log('Empty Home: ' + empty.usedMb + ' MB heap, ' + empty.nodes + ' DOM nodes');
  console.log('Home (store fully loaded): ' + home.usedMb + ' MB heap / ' + home.totalMb + ' MB reserved, ' + home.nodes + ' DOM nodes');
  console.log('  chapters=' + home.chapters + ' story=' + home.story + ' chats=' + home.chats);
  const onlyChapters = await cdp.evalJS(`(async()=>{const t=performance.now();await window.useData.getState().reloadChapters();return Math.round(performance.now()-t);})()`);
  console.log('Reload store: full=' + reloadMs + ' ms, chapters-only=' + onlyChapters + ' ms | message page=' + pageMs + ' ms');
  console.log('Long chat (' + chatState.bubbles + ' bubbles): ' + chatState.usedMb + ' MB heap / ' + chatState.totalMb + ' MB reserved, ' + chatState.nodes + ' DOM nodes');
  console.log('Open chat: ' + openMs + ' ms | back Home: ' + homeBackMs + ' ms | Home again: ' + homeBack.usedMb + ' MB / ' + homeBack.nodes + ' nodes');
  console.log('After 3 open/close cycles: ' + afterCycles + ' MB (retained delta ' + (afterCycles - homeBack.usedMb).toFixed(1) + ' MB)');
  console.log('Electron tree RSS: ' + (rss ? rss.mb + ' MB across ' + rss.processes + ' processes' : 'unavailable'));
  console.log('DB on disk: ' + (dbStats.bytes / 1048576).toFixed(1) + ' MB, ' + dbStats.messages + ' messages');
  console.log('\nCopy these numbers before/after a change.');
} finally {
  cdp?.close();
  killTree(electron?.pid);
  killTree(vite?.pid);
  await sleep(300);
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* locked */ }
}
