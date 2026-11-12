/**
 * Portable library export — one file with the whole studio, minus machine-bound
 * secrets and approvals. Runs against dist-electron/db.js (no Electron).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb, portableDatabaseBuffer, providerSecret } = require('../dist-electron/db.js');
const { portableFileName, portableTarget, writePortableCopy } = require('../dist-electron/libraryExport.js');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-export-'));
const SQL = await initSqlJs({ locateFile: (f) => path.join('node_modules', 'sql.js', 'dist', f) });

try {
  await initDb(root, 'studio.db');

  const project = handleDb('createProject', { name: 'Portable Novel', description: 'carry me' });
  handleDb('createChapter', { projectId: project.id, title: 'Chapter One', content: 'alpha beta' });
  const provider = handleDb('createProvider', {
    name: 'Test Provider', baseUrl: 'https://example.test/v1', apiKey: 'sk-live-secret', models: ['m']
  });
  handleDb('setSetting', { key: 'trustedExec', value: JSON.stringify({ plugin: { p1: 'hash' } }) });
  handleDb('setSetting', { key: 'webSearchApiKey', value: JSON.stringify('sk-search-export') });
  handleDb('setSetting', { key: 'uiLanguage', value: 'id' });
  handleDb('saveMcpServer', {
    id: 'mcp-export', name: 'Exporter', command: 'node', args: '[]',
    env: JSON.stringify({ MCP_TOKEN: 'mcp-very-secret' }), enabled: 0
  });

  const buf = portableDatabaseBuffer();
  check('returns a buffer while the library is open', Buffer.isBuffer(buf) && buf.length > 0);
  check('is a real SQLite database', buf.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000');

  const copy = new SQL.Database(buf);
  const read = (sql, params = []) => {
    const stmt = copy.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };

  check('keeps projects', read('SELECT name, description FROM projects')[0]?.name === 'Portable Novel');
  const chapter = read('SELECT title, content FROM chapters')[0];
  check('keeps chapters and prose', chapter?.title === 'Chapter One' && chapter?.content === 'alpha beta');
  check('keeps ordinary settings', read("SELECT value FROM settings WHERE key='uiLanguage'")[0]?.value === 'id');
  check('strips provider API keys', read('SELECT api_key FROM providers')[0]?.api_key === '');
  check('drops stored execution approvals', read("SELECT key FROM settings WHERE key='trustedExec'").length === 0);
  check('drops the web-search key', read("SELECT key FROM settings WHERE key='webSearchApiKey'").length === 0);
  check('empties MCP environment secrets', read("SELECT env FROM mcp_servers WHERE id='mcp-export'")[0]?.env === '{}');
  check('keeps MCP server identity', read("SELECT name, command FROM mcp_servers WHERE id='mcp-export'")[0]?.name === 'Exporter');
  check('keeps provider identity', read('SELECT name, base_url FROM providers')[0]?.name === 'Test Provider');
  copy.close();

  check('live library keeps its API key', providerSecret(provider.id)?.apiKey === 'sk-live-secret');
  check('live library keeps approvals', JSON.parse(handleDb('getAllSettings', {}).trustedExec).plugin.p1 === 'hash');

  // The export is a snapshot, not a live view: later writes must not leak in.
  handleDb('createChapter', { projectId: project.id, title: 'Chapter Two', content: 'gamma' });
  const after = new SQL.Database(buf);
  const stmt = after.prepare('SELECT COUNT(*) AS n FROM chapters');
  stmt.step();
  check('export does not change when the live library does', stmt.getAsObject().n === 1);
  stmt.free();
  after.close();

  closeDb();
  const empty = portableDatabaseBuffer();
  check('returns null with no open library', empty === null);

  const live = path.join(root, 'studio.db');
  check('uses a dated, readable filename', portableFileName(live, new Date(2026, 10, 11)) === 'studio-portable-2026-11-11.db');
  check('strips hostile name characters', portableFileName(path.join(root, 'a:b?.db'), new Date(2026, 10, 11)) === 'a_b_-portable-2026-11-11.db');
  check('adds .db when the dialog path has none', portableTarget(path.join(root, 'carry'), live) === path.join(root, 'carry.db'));
  check('keeps a chosen extension', portableTarget(path.join(root, 'carry.sqlite'), live) === path.join(root, 'carry.sqlite'));
  let refused = false;
  try { portableTarget(live, live); } catch { refused = true; }
  check('refuses to overwrite the open library', refused);
  if (process.platform !== 'linux') {
    let cased = false;
    try { portableTarget(live.toUpperCase(), live); } catch { cased = true; }
    check('refuses the live file in another case', cased);
  }
  const target = path.join(root, 'copy.db');
  writePortableCopy(target, Buffer.from('portable-bytes'));
  check('writes the export where asked', fs.readFileSync(target, 'utf8') === 'portable-bytes');
  check('leaves no staging file behind', !fs.existsSync(`${target}.part`));
  writePortableCopy(target, Buffer.from('second-copy'));
  check('replaces an existing export cleanly', fs.readFileSync(target, 'utf8') === 'second-copy');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  try { closeDb(); } catch { /* already closed */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
}
