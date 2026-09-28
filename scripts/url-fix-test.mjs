/**
 * Quick verification for the provider-connection fixes:
 *  1. baseUrlCandidates handles: bare host, host + /v1, pasted full endpoint,
 *     trailing slash, and non-http(s) junk.
 *  2. fetchModels recovers from a pasted full endpoint (falls back to /v1).
 *  3. extractError turns HTML responses into a readable message.
 *
 * Run: node scripts/url-fix-test.mjs
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchModels, verifyModel, baseUrlCandidates } = require('../dist-electron/ai.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.error(`  ❌ ${name} ${detail}`); failures++; }
}

const cases = [
  ['https://api.openai.com/v1', ['https://api.openai.com/v1']],
  ['https://api.openai.com/v1/', ['https://api.openai.com/v1']],
  ['https://api.openai.com/v1/chat/completions', ['https://api.openai.com/v1', 'https://api.openai.com']],
  ['api.openai.com/v1', ['https://api.openai.com/v1']],
  ['https://api.openai.com', ['https://api.openai.com', 'https://api.openai.com/v1']],
  ['https://api.openai.com/v1/messages', ['https://api.openai.com/v1', 'https://api.openai.com']],
  ['ftp://nope', []],
  ['', []]
];

console.log('\n[1] baseUrlCandidates');
for (const [input, expected] of cases) {
  const got = baseUrlCandidates(input);
  check(`${input || '(empty)'} → [${expected.join(' | ')}]`,
    JSON.stringify(got) === JSON.stringify(expected), `got [${got.join(' | ')}]`);
}

console.log('\n[2] fetchModels recovers from pasted full endpoint');
// Server that ONLY answers on /v1/models; everything else gets an HTML page
// (like a website landing page would).
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.model === 'good-model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model ${parsed.model} not found` } }));
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE HTML><html lang="zh-Hans"><head><title>Welcome</title></head><body>hello</body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

const provider = {
  id: 'p', name: 'p', enabled: true, models: [], kind: 'openai',
  // user pasted the FULL endpoint including /chat/completions
  baseUrl: `${origin}/v1/chat/completions`, apiKey: 'sk-test'
};
const models = await fetchModels(provider);
check('models fetched despite pasted endpoint', JSON.stringify(models) === '["model-a","model-b"]', JSON.stringify(models));

console.log('\n[3] bare host base URL falls back to /v1 automatically');
const bare = { ...provider, baseUrl: origin }; // root → first try fails, /v1 fallback succeeds
const bareModels = await fetchModels(bare);
check('bare host recovers via /v1 fallback', JSON.stringify(bareModels) === '["model-a","model-b"]', JSON.stringify(bareModels));

console.log('\n[4] server with only HTML pages produces a readable error');
const htmlServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE HTML><html lang="zh-Hans"><head><title>Welcome</title></head><body>hello</body></html>');
});
await new Promise((r) => htmlServer.listen(0, '127.0.0.1', r));
const htmlOrigin = `http://127.0.0.1:${htmlServer.address().port}`;
const bad = { ...provider, baseUrl: `${htmlOrigin}/v1` };
let err = null;
try { await fetchModels(bad); } catch (e) { err = e; }
check('error thrown', !!err, 'no error thrown');
check('no raw HTML in message', err && !/<html|<!DOCTYPE/i.test(err.message), err?.message);
check('message mentions Base URL', err && /Base URL/i.test(err.message), err?.message);
htmlServer.close();

console.log('\n[5] verifyModel: working model, bad model, pasted-endpoint base URL');
const okProv = { ...provider, baseUrl: `${origin}/v1` };
const vOk = await verifyModel(okProv, 'good-model');
check('good model verifies', vOk.ok && vOk.reply === 'OK' && vOk.latencyMs >= 0, JSON.stringify(vOk));
const vBad = await verifyModel(okProv, 'ghost-model');
check('bad model fails with readable error', !vBad.ok && /not found/i.test(vBad.error || ''), JSON.stringify(vBad));
const vPasted = await verifyModel({ ...provider, baseUrl: `${origin}/v1/chat/completions` }, 'good-model');
check('verify works with pasted full endpoint URL', vPasted.ok, JSON.stringify(vPasted));

server.close();
console.log(failures === 0 ? '\n🟢 ALL URL-FIX TESTS PASSED\n' : `\n🔴 ${failures} TEST(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
