/**
 * Security + hostile-input suite.
 *
 * These are the checks that do not need a window: address guards, protocol
 * guards, database injection shapes, prototype pollution, hostile payload
 * types, integrity under extreme content, and long-term storage damage.
 *
 * The rule for this file: every check must attack the REAL code path (compiled
 * main-process modules / real temp database), never a copy of the logic.
 *
 * Run: node scripts/security-test.mjs   (requires `npm run build:electron`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initDb, handleDb, persistNow, closeDb, providerSecret, setSecretCrypto, settingSecret } = require('../dist-electron/db.js');
const { settingsForRenderer } = require('../dist-electron/settingsPrivacy.js');
const { isBlockedHost, runWebFetch, publicLookup } = require('../dist-electron/webtools.js');
const { grantPaths, clearGrants, checkReadable, readTextFiles, isSensitivePath, setPrivateRoot } = require('../dist-electron/fileaccess.js');
const { loadPlugins, listLoadedPlugins, getLogs } = require('../dist-electron/plugins.js');
const { restartMcpServer } = require('../dist-electron/mcp.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-sec-'));
await initDb(dir, 'sec.db');
const db = (op, payload = {}) => handleDb(op, payload);
const ms = (n) => `${n.toFixed(1)} ms`;
const timeIt = (fn) => { const t = performance.now(); const out = fn(); return [performance.now() - t, out]; };

// ---------------------------------------------------------------- S1: SSRF ---
// web_fetch takes URLs from model output, so anything that reaches the local
// machine or its network must be refused before a socket is opened.
{
  const blocked = [
    'localhost', 'localhost.', 'LOCALHOST', 'app.localhost', 'printer.local',
    '127.0.0.1', '127.1', '127.0.0.0', '2130706433', '0x7f000001', '017700000001',
    '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10',
    '[::1]', '::1', '::', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]',
    'metadata.google.internal', 'anything.lan', '999.1.1.1', ''
  ];
  const allowed = [
    'example.com', 'www.wikipedia.org', 'api.exa.ai', '8.8.8.8',
    '93.184.216.34', 'sub.domain.co.uk', 'xn--bcher-kva.example'
  ];
  const badAllowed = blocked.filter((h) => !isBlockedHost(h));
  const badBlocked = allowed.filter((h) => isBlockedHost(h));
  check('SSRF: loopback/private/metadata hosts blocked', badAllowed.length === 0, badAllowed.join(', '));
  check('SSRF: public hosts stay reachable', badBlocked.length === 0, badBlocked.join(', '));
}

// ------------------------------------------------------ S2: protocol guard ---
{
  const hostile = [
    'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x',
    'ftp://example.com/x', 'gopher://example.com/', '\\\\server\\share'
  ];
  const leaked = [];
  for (const url of hostile) {
    const t0 = performance.now();
    const raw = await runWebFetch({ url });
    const elapsed = performance.now() - t0;
    const parsed = JSON.parse(raw || '{}');
    // No socket may be opened: a refusal is immediate, a DNS attempt is not.
    if (!parsed.error || elapsed > 1200) leaked.push(`${url} → ${raw.slice(0, 60)} (${ms(elapsed)})`);
  }
  check('protocol: file/javascript/data/ftp refused without a request', leaked.length === 0, leaked.join(' | '));
}

// ---------------------------------------------- S3: private target on fetch ---
{
  const targets = ['http://127.0.0.1:9/', 'http://localhost:9/', 'http://169.254.169.254/latest/meta-data/'];
  const leaked = [];
  for (const url of targets) {
    const t0 = performance.now();
    const raw = await runWebFetch({ url });
    const elapsed = performance.now() - t0;
    const parsed = JSON.parse(raw || '{}');
    if (!parsed.error || elapsed > 1500) leaked.push(`${url} → ${raw.slice(0, 50)} (${ms(elapsed)})`);
  }
  check('SSRF: local targets rejected before connecting', leaked.length === 0, leaked.join(' | '));
}

// ------------------------------------------------- S3b: file read allowlist ---
// files:read is what a compromised renderer would use to exfiltrate local text.
// Only granted paths may be read, and secret shapes never are.
{
  const plain = path.join(dir, 'note.md');
  fs.writeFileSync(plain, 'hello from a picked file');
  clearGrants();
  const ungranted = checkReadable(plain);
  check('files: an ungranted path is refused',
    ungranted.ok === false && ungranted.error === 'not granted', JSON.stringify(ungranted));
  check('files: an ungranted path yields no content', readTextFiles([plain]).length === 0);

  grantPaths([plain]);
  check('files: a granted path becomes readable',
    readTextFiles([plain])[0]?.content === 'hello from a picked file');

  const secretDir = path.join(dir, '.ssh');
  fs.mkdirSync(secretDir, { recursive: true });
  const secret = path.join(secretDir, 'id_rsa');
  fs.writeFileSync(secret, 'PRIVATE KEY');
  grantPaths([secret]);
  check('files: secrets are refused even when granted',
    checkReadable(secret).error === 'sensitive path' && readTextFiles([secret]).length === 0);
  check('files: sensitive matcher covers keys, env and credential stores',
    isSensitivePath('/home/u/.env') && isSensitivePath('/home/u/.aws/credentials') &&
    isSensitivePath('C:\\Users\\u\\.ssh\\id_ed25519') && isSensitivePath('/x/cert.pem') &&
    isSensitivePath('/x/keychain/login.keychain-db') && !isSensitivePath('/x/chapter-1.md'));
  check('files: the grant list is narrow',
    readTextFiles([path.join(dir, 'other.md')]).length === 0);
  clearGrants();
}

// ------------------------------------------------- S4: injection + pollution ---
{
  const project = db('createProject', { name: 'Sec' });
  const chat = db('createChat', { title: 'Sec chat' });

  // Prototype pollution through payload keys.
  db('createStory', { projectId: project.id, kind: 'lore', title: 'p', content: 'c', __proto__: { pwned: 1 } });
  db('updateChapter', { id: 'nope', __proto__: { pwned: 2 }, constructor: { prototype: { pwned: 3 } } });
  db('addMessage', { chatId: chat.id, role: 'user', content: 'x', __proto__: { pwned: 4 } });
  check('pollution: Object.prototype untouched', ({}).pwned === undefined && [].pwned === undefined);

  // Column injection through a key that is not part of the whitelist.
  const chapter = db('createChapter', { projectId: project.id, title: 'Safe', content: '', status: 'draft' });
  db('updateChapter', {
    id: chapter.id,
    title: 'Renamed',
    'title=? WHERE 1=1 --': 'boom',
    'status); DROP TABLE chapters; --': 'boom'
  });
  const after = db('listChapters', { projectId: project.id }) || [];
  check('injection: hostile keys cannot rewrite the statement',
    after.length > 0 && after.every((c) => 'content' in c));
  check('injection: the legitimate field still updates',
    (after.find((c) => c.id === chapter.id) || {}).title === 'Renamed');
}

// ------------------------------------------------------- S5: hostile shapes ---
{
  const hostilePayloads = [
    null, undefined, 0, '', 'x', [], [null], { id: null }, { id: 1 },
    { chatId: {} }, { chatId: [], limit: NaN }, { limit: -1 }, { limit: 1e9 },
    { content: { toString: null } }, { toolSteps: 'not-an-array' }, { toolSteps: [null, 1, 'x', {}] }
  ];
  const ops = ['getMessages', 'getMessagePage', 'addMessage', 'createStory', 'updateChapter', 'dbStats'];
  const broke = [];
  for (const op of ops) {
    for (const payload of hostilePayloads) {
      try { db(op, payload); } catch (err) {
        // A thrown validation error is acceptable; a crash-shaped error is not.
        if (!/required|invalid|missing|not found|no such|unknown/i.test(String(err?.message || err))) {
          broke.push(`${op}(${JSON.stringify(payload)}) → ${err?.message || err}`);
        }
      }
    }
  }
  check('hostile payloads never crash the database layer', broke.length === 0, broke.slice(0, 3).join(' | '));
}

// ------------------------------------------------------- S6: extreme content ---
{
  const chat = db('createChat', { title: 'Extreme' });
  const nasty = [
    'A'.repeat(1_000_000),
    '🎭'.repeat(50_000),
    '\u202Egnp.exe\u202C',                       // bidi override
    'control\u0001\u0007chars',
    '<script>alert(1)</script>',
    "'); DROP TABLE messages; --",
    'line\r\nbreak\u2028sep'
  ];
  const broken = [];
  for (const content of nasty) {
    try {
      const saved = db('addMessage', { chatId: chat.id, role: 'user', content });
      const back = db('getMessages', { chatId: chat.id }).find((m) => m.id === saved.id);
      if (!back || back.content !== content) broken.push(`content mismatch (${content.slice(0, 12)})`);
    } catch (err) { broken.push(String(err?.message || err)); }
  }
  check('extreme content round-trips byte-for-byte', broken.length === 0, broken.slice(0, 2).join(' | '));

  // A NUL byte cannot survive the SQLite string API; it must be stripped on the
  // way in rather than truncating everything after it.
  const nulSaved = db('addMessage', { chatId: chat.id, role: 'user', content: 'a\u0000b\u0000c' });
  const nulBack = db('getMessages', { chatId: chat.id }).find((m) => m.id === nulSaved.id);
  check('NUL bytes are stripped, not truncated', nulBack?.content === 'abc', JSON.stringify(nulBack?.content));

  // Tool steps are attacker-influenced too (model output). Bounds must hold and
  // junk must not break the row.
  const huge = Array.from({ length: 10_000 }, () => ({ name: 'web_fetch', kind: 'web', detail: 'y'.repeat(5000), ok: true }));
  const saved = db('addMessage', { chatId: chat.id, role: 'assistant', content: 'x', toolSteps: huge });
  const back = db('getMessages', { chatId: chat.id }).find((m) => m.id === saved.id);
  check('tool steps: 10k hostile rows stored bounded',
    back.toolSteps.length === 40 && back.toolSteps[0].detail.length === 200,
    `${back.toolSteps.length} rows / ${back.toolSteps[0].detail.length} chars`);
  const junk = db('addMessage', {
    chatId: chat.id, role: 'assistant', content: 'junk',
    toolSteps: [null, 7, 'str', {}, { name: {}, kind: [], detail: 42 }]
  });
  const junkBack = db('getMessages', { chatId: chat.id }).find((m) => m.id === junk.id);
  check('tool steps: junk entries cannot throw on read back',
    Array.isArray(junkBack.toolSteps) && junkBack.toolSteps.every((s) => typeof s.name === 'string' && typeof s.detail === 'string'));
}

// ------------------------------------------------ S7: long-term storage damage ---
{
  const chat = db('createChat', { title: 'Growth' });
  const [seedMs] = timeIt(() => {
    for (let i = 0; i < 2000; i++) {
      db('addMessage', { chatId: chat.id, role: i % 2 ? 'assistant' : 'user', content: `m${i} ` + 'z'.repeat(200) });
    }
  });
  persistNow(true);
  const sizeAfterSeed = fs.statSync(path.join(dir, 'sec.db')).size;
  check('growth: 2,000 messages persist in a sane size', sizeAfterSeed < 20 * 1024 * 1024,
    `${(sizeAfterSeed / 1024 / 1024).toFixed(2)} MB, seed ${ms(seedMs)}`);

  // Repeated persists must not balloon the file (no copy-per-write growth).
  for (let i = 0; i < 5; i++) { db('addMessage', { chatId: chat.id, role: 'user', content: 'tick' }); persistNow(true); }
  const sizeAfterTicks = fs.statSync(path.join(dir, 'sec.db')).size;
  check('growth: repeated persists stay flat',
    sizeAfterTicks < sizeAfterSeed * 1.2 + 512 * 1024,
    `${(sizeAfterTicks / 1024 / 1024).toFixed(2)} MB`);

  const compact = db('compactDb');
  const sizeAfterCompact = fs.statSync(path.join(dir, 'sec.db')).size;
  check('growth: compaction succeeds on a large database',
    (compact === undefined || compact?.ok !== false) && sizeAfterCompact <= sizeAfterTicks + 1024,
    `${(sizeAfterCompact / 1024 / 1024).toFixed(2)} MB`);

  const stats = db('dbStats');
  check('growth: stats still read after compaction', Number(stats.messages) > 2000, `${stats.messages} messages`);

  // A page read must stay interactive even on a big table.
  const [pageMs, page] = timeIt(() => db('getMessagePage', { chatId: chat.id, limit: 200 }));
  check('growth: paged read stays fast', page.rows.length === 200 && pageMs < 150, ms(pageMs));
}

// ------------------------------------- S8: provider secrets stay in main only ---
{
  // Deterministic stand-in for Electron's safeStorage, so the at-rest checks
  // work in a headless run as well as in the packaged app.
  setSecretCrypto(
    (plain) => 'test:' + Buffer.from(plain, 'utf8').toString('base64'),
    (sealed) => Buffer.from(String(sealed).slice(5), 'base64').toString('utf8')
  );
  const created = db('createProvider', {
    name: 'Key Probe', baseUrl: 'https://example.com/v1', apiKey: 'sk-very-secret',
    models: [], kind: 'openai', enabled: true
  });
  const listed = (db('listProviders') || []).find((p) => p.id === created.id) || {};
  check('providers: listProviders never returns the key',
    !listed.api_key && listed.has_key === 1,
    JSON.stringify({ api_key: listed.api_key, has_key: listed.has_key }));
  check('providers: the main process can still read it',
    providerSecret(created.id)?.apiKey === 'sk-very-secret');
  check('providers: updating without a key keeps the stored one',
    db('updateProvider', { id: created.id, name: 'Renamed' }) &&
    providerSecret(created.id)?.apiKey === 'sk-very-secret');
}

// ---------------------------- S8b: web-search key is sealed and redacted ---
{
  const secret = 'sk-search-very-secret';
  db('setSetting', { key: 'webSearchApiKey', value: JSON.stringify(secret) });
  const stored = String(db('getAllSettings').webSearchApiKey || '');
  check('settings: web-search key is encrypted at rest',
    stored.startsWith('enc:v1:') && !stored.includes(secret), stored.slice(0, 24));
  check('settings: main can still read the web-search key',
    settingSecret('webSearchApiKey') === secret);
  const view = settingsForRenderer(db('getAllSettings'), true);
  check('settings: the renderer view never contains the key',
    view.webSearchApiKey === '' && view.webSearchHasKey === 'true' && !JSON.stringify(view).includes(secret));

  db('setSetting', { key: 'webSearchApiKey', value: JSON.stringify('   ') });
  check('settings: clearing the key leaves no ciphertext',
    db('getAllSettings').webSearchApiKey === '' && settingSecret('webSearchApiKey') === '');
}

// --------------------------------- S8c: DNS answers are checked before use ---
{
  const dns = require('node:dns');
  const original = dns.lookup;
  // Simulate DNS rebinding: a public name resolves to loopback at connect time.
  dns.lookup = (hostname, options, callback) =>
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  let error = null;
  try {
    await new Promise((resolve) => {
      publicLookup('public.example', {}, (err) => { error = err; resolve(); });
    });
  } finally {
    dns.lookup = original;
  }
  check('SSRF: a DNS answer in a private range is refused',
    !!error && /private|local network|own machine/i.test(String(error.message || error)));
}

// ------------------------------------------ S9: the app's own data directory ---
{
  const root = path.join(dir, 'profile');
  fs.mkdirSync(root, { recursive: true });
  const dbLike = path.join(root, 'openplot.db');
  const profileNote = path.join(root, 'notes.txt');
  fs.writeFileSync(dbLike, 'SECRET DATA');
  fs.writeFileSync(profileNote, 'profile text');
  setPrivateRoot(root);
  clearGrants();
  grantPaths([dbLike, profileNote]);
  // A plain-looking file inside the profile is refused too: the rule is the
  // directory, not the file name (the db name has its own matcher below).
  check('files: the app data directory is refused even when granted',
    checkReadable(profileNote).error === 'private path' && readTextFiles([profileNote]).length === 0,
    JSON.stringify(checkReadable(profileNote)));
  check('files: the database inside the profile yields no content',
    readTextFiles([dbLike]).length === 0);
  check('files: a database file is refused by name',
    isSensitivePath('/x/openplot.db') && isSensitivePath('C:\\x\\inkwell.db'));
  check('files: absurdly long paths are refused',
    checkReadable('C:\\' + 'a'.repeat(5000)).error === 'path too long');

  const links = path.join(dir, 'links');
  const secretDir = path.join(dir, '.ssh');
  fs.mkdirSync(links, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  const secretFile = path.join(secretDir, 'id_rsa');
  fs.writeFileSync(secretFile, 'PRIVATE KEY');
  const linkDir = path.join(links, 'reading-list');
  try {
    fs.symlinkSync(secretDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const throughLink = path.join(linkDir, 'id_rsa');
    clearGrants();
    grantPaths([throughLink]);
    const verdict = checkReadable(throughLink);
    check('files: a symlink cannot smuggle a sensitive target',
      verdict.ok === false && verdict.error === 'sensitive path', JSON.stringify(verdict));
    check('files: readTextFiles refuses the symlinked secret',
      readTextFiles([throughLink]).length === 0);
  } catch (e) {
    console.log('SKIP  files: symlink test unavailable — ' + String(e?.code || e));
  }
}

// ------------------------------------------- S10: plugin execution is gated ---
{
  const logs = () => getLogs().join('\n');
  db('savePlugin', { id: 'p-disabled', name: 'Disabled', code: "context.log('PLUGIN_DISABLED_RAN');", enabled: 0 });
  db('savePlugin', { id: 'p-denied', name: 'Denied', code: "context.log('PLUGIN_DENIED_RAN');", enabled: 1 });
  db('savePlugin', { id: 'p-approved', name: 'Approved', code: "context.log('PLUGIN_APPROVED_RAN');", enabled: 1 });

  loadPlugins({ isTrusted: () => false });
  check('plugins: a disabled plugin never executes', !logs().includes('PLUGIN_DISABLED_RAN'));
  check('plugins: an unapproved plugin never executes', !logs().includes('PLUGIN_DENIED_RAN'));
  check('plugins: nothing unapproved is loaded',
    !listLoadedPlugins().some((p) => p.id === 'p-denied' || p.id === 'p-disabled'));

  loadPlugins({ isTrusted: (row) => row.id === 'p-approved' });
  check('plugins: an approved plugin runs', logs().includes('PLUGIN_APPROVED_RAN'));
  check('plugins: only approved rows are loaded',
    listLoadedPlugins().some((p) => p.id === 'p-approved') &&
    !listLoadedPlugins().some((p) => p.id === 'p-disabled'));
}

// --------------------------------------------- S11: disabled MCP never spawns ---
{
  const status = await restartMcpServer({
    id: 'mcp-off', name: 'Off', command: 'openplot-does-not-exist', enabled: 0
  });
  check('mcp: a disabled server is never spawned', status === null);
}

// --------------------------------------- S12: remote image proxy is guarded ---
{
  const { proxyImageUrl, imageDataUrl } = require('../dist-electron/images.js');
  check('images: file:// and data: URLs are refused',
    !proxyImageUrl('file:///etc/passwd') && !proxyImageUrl('data:image/png;base64,iVBORw0KGgo='));
  check('images: loopback, private and metadata hosts are refused',
    !proxyImageUrl('http://127.0.0.1:8080/a.png') &&
    !proxyImageUrl('http://localhost/a.png') &&
    !proxyImageUrl('http://10.0.0.5/a.png') &&
    !proxyImageUrl('http://169.254.169.254/latest/meta-data/'));
  check('images: credentials in the URL are refused',
    !proxyImageUrl('http://user:pass@example.com/a.png'));
  check('images: a redirect target is checked like any other URL',
    !proxyImageUrl('http://169.254.169.254/x.png', 'https://example.com/') &&
    !!proxyImageUrl('/a.png', 'https://example.com/page'));

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const ok = imageDataUrl('image/png', png);
  check('images: a raster image becomes a data: URL',
    ok.ok === true && String(ok.data || '').startsWith('data:image/png;base64,'));
  check('images: html and svg are never proxied',
    imageDataUrl('text/html', png).ok === false && imageDataUrl('image/svg+xml', png).ok === false);
  check('images: oversized payloads are refused',
    imageDataUrl('image/png', Buffer.alloc(6 * 1024 * 1024)).ok === false);
  check('images: empty payloads are refused', imageDataUrl('image/png', Buffer.alloc(0)).ok === false);
}

closeDb();
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL SECURITY CHECKS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
