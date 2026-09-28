// CDP smoke test for the new composer + project chip + model dropdown flip.
// Connects to the running Electron window (remote-debugging-port=9222) and
// exercises the UI the same way a user would.
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

async function main() {
  // Fetch the Electron page target directly (its own debugger endpoint).
  const list = await fetch('http://localhost:9222/json').then((r) => r.json());
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
  if (!page) { console.error('APP PAGE NOT FOUND'); process.exit(2); }

  // Connect straight to the page-level websocket (browser-level CDP is
  // restricted in Electron). Raw CDPSession gives us Runtime + Input domains.
  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  cdp.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    cdp.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval failed');
    return r.result?.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  };

  await send('Runtime.enable');
  await sleep(1200);

  // --- 0. Open an existing chat so the composer mounts ---
  const hasComp0 = await evalJs(`!!document.querySelector('.composer2')`);
  if (!hasComp0) {
    const opened = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('.sidebar button, .sidebar [role=button], .sidebar li, .sidebar div')]
        .filter((el) => el.offsetParent && /^New chat$/.test(el.textContent.trim()));
      if (btns.length) { btns[btns.length - 1].click(); return true; }
      return false;
    })()`);
    if (!opened) console.log('(warn: tidak menemukan item chat di sidebar)');
    await sleep(1500);
  }

  // --- 1. Composer visible? ---
  const hasComp = await evalJs(`!!document.querySelector('.composer2')`);
  check('composer2 rendered', !!hasComp);
  if (!hasComp) {
    console.log('(note: buka chat dulu di aplikasi untuk melihat composer)');
    cdp.close();
    process.exit(1);
  }

  // --- 2. Thinking popover flips UP ---
  await evalJs(`document.querySelector('.think-btn').click()`);
  await sleep(400);
  let cls = await evalJs(`document.querySelector('.ui-popover')?.className || ''`);
  check('thinking popover opened', String(cls).includes('ui-popover'));
  check('thinking popover flips UP', String(cls).includes('drop-up'), cls);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(250);

  // --- 3. Model popover flips UP ---
  await evalJs(`document.querySelector('.model-btn').click()`);
  await sleep(400);
  cls = await evalJs(`[...document.querySelectorAll('.ui-popover')].map(e=>e.className).join('|')`);
  check('model popover opened', String(cls).includes('ui-popover'));
  check('model popover flips UP', String(cls).includes('drop-up'), cls);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(250);

  // --- 4. Project chip: attach & detach ---
  const hasChip = await evalJs(`!!document.querySelector('.proj-chip:not(.ghosted)')`);
  const hasGhost = await evalJs(`!!document.querySelector('.proj-chip.ghosted')`);
  if (hasChip) {
    await evalJs(`document.querySelector('.proj-chip:not(.ghosted) .x').click()`);
    await sleep(700);
    const after = await evalJs(`!!document.querySelector('.proj-chip:not(.ghosted)')`);
    const ghostAfter = await evalJs(`!!document.querySelector('.proj-chip.ghosted')`);
    check('project chip detached (X works)', !after && !!ghostAfter);
    // Re-attach via ghost chip picker to prove the picker works too
    await evalJs(`document.querySelector('.proj-chip.ghosted')?.click()`);
    await sleep(400);
    const picked = await evalJs(`(() => { const b = document.querySelector('.ui-menu-item'); if (!b) return false; b.click(); return true; })()`);
    if (picked) {
      await sleep(700);
      const re = await evalJs(`!!document.querySelector('.proj-chip:not(.ghosted)')`);
      check('project re-attached from picker', re);
    }
  } else if (hasGhost) {
    await evalJs(`document.querySelector('.proj-chip.ghosted').click()`);
    await sleep(400);
    const picked = await evalJs(`(() => { const b = document.querySelector('.ui-menu-item'); if (!b) return false; b.click(); return true; })()`);
    check('project attach picker has options', !!picked);
    if (picked) {
      await sleep(700);
      const now = await evalJs(`!!document.querySelector('.proj-chip:not(.ghosted)')`);
      check('project attached from ghost chip', now);
      await evalJs(`document.querySelector('.proj-chip:not(.ghosted) .x')?.click()`);
      await sleep(700);
      const after = await evalJs(`!!document.querySelector('.proj-chip:not(.ghosted)')`);
      check('project chip detached (X works)', !after);
    }
  } else {
    check('project chip present in some form', false);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? 'ALL COMPOSER CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`);
  cdp.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(1); });
