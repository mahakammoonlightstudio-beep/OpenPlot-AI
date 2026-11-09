/**
 * Trust-store test (headless).
 *
 * Runs the REAL rules used by the `trust:list` / `trust:revoke` IPC handlers:
 * hashing, defensive parsing, stale/orphan detection and revoking an approval.
 * Requires `npm run build:electron`.
 *
 * Run: node scripts/trust-test.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  trustHash, parseTrust, isTrusted, remember, revoke, listTrust
} = require('../dist-electron/trust.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ------------------------------------------------------- hashing is exact ---
{
  const a = trustHash('plugin', ['console.log(1)']);
  const b = trustHash('plugin', ['console.log(2)']);
  const c = trustHash('mcp', ['console.log(1)']);
  check('hash is stable for the same payload', a === trustHash('plugin', ['console.log(1)']));
  check('hash changes when the code changes', a !== b);
  check('hash separates kinds', a !== c);
  check('hash tolerates undefined parts', trustHash('mcp', ['npx', undefined, null]).length === 64);
}

// ------------------------------------------------------------ parsing ------
{
  check('parse: empty value is an empty map', Object.keys(parseTrust('')).length === 0);
  check('parse: broken JSON is an empty map', Object.keys(parseTrust('{oops')).length === 0);
  check('parse: an array is refused', Object.keys(parseTrust('[1,2,3]')).length === 0);
  check('parse: null is refused', Object.keys(parseTrust(null)).length === 0);

  const parsed = parseTrust(JSON.stringify({ 'plugin:a': 'h1', 'mcp:b': 'h2', 'plugin:bad': 42, 'x': null }));
  check('parse: only string hashes survive',
    parsed['plugin:a'] === 'h1' && parsed['mcp:b'] === 'h2' && !('plugin:bad' in parsed) && !('x' in parsed));
  check('parse: an object value is accepted directly', parseTrust({ 'plugin:z': 'hz' })['plugin:z'] === 'hz');
}

// ----------------------------------------------------- remember / revoke ----
{
  const trust = {};
  const ph = trustHash('plugin', ['print(1)']);
  const mh = trustHash('mcp', ['node', 'server.js', '{}']);

  remember(trust, 'plugin', 'p1', ph);
  remember(trust, 'mcp', 'm1', mh);
  check('remember stores one key per kind and id',
    Object.keys(trust).sort().join(',') === 'mcp:m1,plugin:p1');
  check('isTrusted accepts the exact hash', isTrusted(trust, 'plugin', 'p1', ph));
  check('isTrusted rejects edited code', !isTrusted(trust, 'plugin', 'p1', trustHash('plugin', ['print(2)'])));
  check('isTrusted does not cross kinds', !isTrusted(trust, 'mcp', 'p1', ph));

  revoke(trust, 'plugin', 'p1');
  check('revoke removes the approval', !isTrusted(trust, 'plugin', 'p1', ph));
  check('revoke leaves other approvals alone', isTrusted(trust, 'mcp', 'm1', mh));
  check('revoke is idempotent', (revoke(trust, 'plugin', 'p1'), !('plugin:p1' in trust)));

  // What the IPC handler persists is exactly this map.
  const roundTrip = parseTrust(JSON.stringify(trust));
  check('persistence round-trips the map', JSON.stringify(roundTrip) === JSON.stringify(trust));
}

// --------------------------------------------------------- list/stale ------
{
  const plugins = [
    { id: 'p1', name: 'Word counter', code: 'v1' },
    { id: 'p2', name: 'Edited', code: 'v2' }
  ];
  const servers = [
    { id: 'm1', name: 'Files', command: 'npx', args: '["fs"]', env: '{}' }
  ];
  const trust = {
    'plugin:p1': trustHash('plugin', ['v1']),
    'plugin:p2': trustHash('plugin', ['old']),
    'mcp:m1': trustHash('mcp', ['npx', '["fs"]', '{}']),
    'plugin:gone': 'deadbeef',
    'junk': 'ignored'
  };

  const rows = listTrust(trust, plugins, servers);
  const byId = Object.fromEntries(rows.map((r) => [`${r.kind}:${r.id}`, r]));

  check('list: one row per valid approval', rows.length === 4, String(rows.length));
  check('list: current code is not stale', byId['plugin:p1'].stale === false && byId['plugin:p1'].present);
  check('list: edited code is stale', byId['plugin:p2'].stale === true);
  check('list: mcp approval compares command, args and env', byId['mcp:m1'].stale === false);
  check('list: deleted rows are orphans with their id as label',
    byId['plugin:gone'].present === false && byId['plugin:gone'].label === 'gone');
  check('list: malformed keys are skipped', !rows.some((r) => r.kind === ('junk')));
  check('list: labels come from the row', byId['plugin:p1'].label === 'Word counter');

  // Changing the MCP args must invalidate the approval.
  const edited = listTrust({ 'mcp:m1': trustHash('mcp', ['npx', '["fs"]', '{}']) },
    plugins, [{ ...servers[0], args: '["fs","C:/data"]' }]);
  check('list: editing MCP args marks it stale', edited[0].stale === true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
