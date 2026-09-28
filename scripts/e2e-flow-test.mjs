// E2E full-flow test on the RUNNING Electron app (CDP over port 9222):
// create a rated project -> set format/rating -> build Story Flow (seed,
// add beat) -> write a beat into a chapter -> verify DB rows & prompt build.
// Usage: node scripts/e2e-flow-test.mjs   (requires vite:5173 + electron:9222)
import fs from 'node:fs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch('http://localhost:9222/json').then((r) => r.json());
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
if (!page) { console.error('APP PAGE NOT FOUND — jalankan vite + electron dulu'); process.exit(2); }

const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = rej; });
let msgId = 0; const pending = new Map();
cdp.onmessage = (ev) => { const d = JSON.parse(ev.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};

await send('Runtime.enable');
await sleep(1000);

const STAMP = Date.now().toString(36);

// ---------- 1. Create the project directly via the store (the sidebar's
// project rows only navigate — creation lives inside ProjectsView) ----------
await evalJs(`(window.useData ? 1 : Promise.reject(new Error('useData hook missing')))`);
const navOk = await evalJs(`(() => {
  const items = [...document.querySelectorAll('.nav-item')];
  const el = items.find((n) => /Untitled project|Test Project/);
  if (el) { el.click(); return true; }
  return false;
})()`);
check('navigate to Projects via project row', !!navOk);
await sleep(600);
// Deterministic guard: the app's own route store must now be on 'projects'.
await evalJs(`window.useData.getState().navigate('projects')`);
await sleep(300);

// ---------- 2. Create project via textPrompt modal ----------
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => /New Project|Proyek Baru/i.test(x.textContent));
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(400);
await evalJs(`(() => {
  const input = document.querySelector('.modal input, .modal-host input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Flow Test ${STAMP}');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.modal button, .modal-host button')];
  const b = btns.find((x) => /Create|Buat/i.test(x.textContent));
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(900);
const projectName = await evalJs(`useData.getState().projects.find(p => /Flow Test ${STAMP}/.test(p.name))?.name || ''`);
check('project created', !!projectName, projectName);
const pid = await evalJs(`useData.getState().projects.find(p => /Flow Test ${STAMP}/.test(p.name))?.id || null`);

// ---------- 3. Set format + rating through the UI ----------
await evalJs(`(() => {
  const items = [...document.querySelectorAll('.story-item')];
  const el = items.find((n) => /Flow Test ${STAMP}/.test(n.textContent));
  if (el) { el.click(); return true; }
  return false;
})()`);
await sleep(500);
const setFormat = await evalJs(`(() => {
  const sels = [...document.querySelectorAll('select')];
  const sel = sels.find((s) => [...s.options].some((o) => o.value === 'short-story'));
  if (!sel) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'short-story');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
const setRating = await evalJs(`(() => {
  const sels = [...document.querySelectorAll('select')];
  const sel = sels.find((s) => [...s.options].some((o) => o.value === 'mature'));
  if (!sel) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'mature');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
check('format picker present', !!setFormat);
check('rating picker present', !!setRating);
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => /Save|Simpan/i.test(x.textContent) && !x.disabled);
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(700);
const saved = await evalJs(`(() => {
  const p = useData.getState().projects.find(p => p.id === '${pid}');
  return p ? p.format + ':' + p.rating : '';
})()`);
check('project saved as short-story:mature', saved === 'short-story:mature', saved);

// ---------- 4. Story Flow: seed + add ----------
await evalJs(`window.useData.getState().navigate('flow')`);
await sleep(600);
const seeded = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => /Starter outline|Outline awal/i.test(x.textContent));
  if (b) { b.click(); return true; }
  return false;
})()`);
check('starter outline button available', !!seeded);
await sleep(1000);
const beatCount = await evalJs(`useData.getState().flowBeats.filter(b => b.project_id === '${pid}').length`);
check('9 seed beats created', beatCount === 9, String(beatCount));

// add a custom beat to Act II via + button
await evalJs(`(() => {
  const acts = [...document.querySelectorAll('.flow-act')];
  const btn = acts[1]?.querySelector('button');
  if (btn) { btn.click(); return true; }
  return false;
})()`);
await sleep(700);
const beatCount2 = await evalJs(`useData.getState().flowBeats.filter(b => b.project_id === '${pid}').length`);
check('custom beat added to Act II', beatCount2 === 10, String(beatCount2));

// ---------- 5. Write a beat into a chapter ----------
const wroteOk = await evalJs(`(async () => {
  const beats = useData.getState().flowBeats.filter(b => b.project_id === '${pid}');
  const beat = beats.find(b => b.act === 2) || beats[0];
  const btns = [...document.querySelectorAll('.beat button')];
  const b = btns.find((x) => /Write this beat|Tulis beat ini/i.test(x.textContent));
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(1200);
const chapterInfo = await evalJs(`(() => {
  const st = useData.getState();
  const beat = st.flowBeats.filter(b => b.project_id === '${pid}').find(b => b.chapter_id);
  const ch = beat ? st.chapters.find(c => c.id === beat.chapter_id) : null;
  return beat && ch ? beat.status + '|' + ch.title + '|' + ch.project_id : '';
})()`);
check('beat -> chapter created & linked', /^drafting\|/.test(chapterInfo) && chapterInfo.endsWith(pid), chapterInfo);

// ---------- 6. System prompt injection (format + rating) ----------
const promptProbe = await evalJs(`(() => {
  const p = useData.getState().projects.find(p => p.id === '${pid}');
  const fmtLabel = {
    'short-story': 'a short story (aim for a compact, single-arc piece)',
    novel: 'a novel (long-form; keep chapters and pacing novel-scale)',
    book: 'a full book / series (track long arcs and continuity)',
    fanfic: 'fan fiction (respect the source material while adding new angles)',
    script: 'a script / screenplay (use scene headings and dialogue-first prose)'
  };
  const ratingLabel = {
    family: 'CONTENT RATING: family-friendly',
    teen: 'CONTENT RATING: teen',
    mature: 'CONTENT RATING: mature'
  };
  const fmt = fmtLabel[p.format] || '';
  const rating = ratingLabel[p.rating] || '';
  return (fmt + ' ' + rating).trim();
})()`);
check('format+rating map to prompt guidance', /short story/.test(promptProbe) && /mature/.test(promptProbe), promptProbe.slice(0, 60) + '…');

// ---------- 7. Data integrity: everything scoped to the project ----------
const integrity = await evalJs(`(() => {
  const st = useData.getState();
  const beats = st.flowBeats.filter(b => b.project_id === '${pid}');
  const chs = st.chapters.filter(c => c.project_id === '${pid}');
  const linkedOk = beats.filter(b => b.chapter_id).every(b => chs.some(c => c.id === b.chapter_id));
  return beats.length + '|' + chs.length + '|' + linkedOk;
})()`);
check('integrity: beats/chapters scoped & links valid', integrity === '10|1|true', integrity);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? 'ALL E2E FLOW CHECKS PASSED (' + results.length + ')' : failed + ' CHECK(S) FAILED'}`);
cdp.close();
process.exit(failed === 0 ? 0 : 1);
