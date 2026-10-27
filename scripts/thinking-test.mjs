/**
 * Thinking-parameter tests (v1.2.3, Task 4) against a mock Anthropic endpoint.
 *
 *   [A] thinking enabled  → the request carries `thinking` + a context-safe
 *       max_tokens, reasoning deltas stream and are returned separately
 *   [B] thinking disabled → the parameter is absent (no silent thinking)
 *   [C] provider rejects  → main retries once WITHOUT thinking, the answer still
 *       arrives, and `thinkingRejected` is reported so the UI can hide the
 *       control for this model
 *
 * Run: node scripts/thinking-test.mjs   (requires `npm run build:electron`)
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runGeneration } = require('../dist-electron/ai.js');
const { initDb, closeDb } = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const seen = [];
let mode = 'ok'; // 'ok' | 'reject'

const SSE = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/messages$/.test(req.url || '')) {
    res.writeHead(404); res.end('{}'); return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* malformed body counts as a failure */ }
    seen.push(body);

    // A relay/model that refuses extended thinking answers with a 400 whose
    // message names the parameter — exactly what the retry path looks for.
    if (mode === 'reject' && body.thinking) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: 'thinking is not supported for this model' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(SSE('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 12, cache_read_input_tokens: 5 } }
    }));
    // Reasoning block only when the request actually enabled thinking.
    if (body.thinking) {
      res.write(SSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
      res.write(SSE('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } }));
      res.write(SSE('content_block_stop', { type: 'content_block_stop', index: 0 }));
    }
    const textIndex = body.thinking ? 1 : 0;
    res.write(SSE('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }));
    res.write(SSE('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: 'OK' } }));
    res.write(SSE('content_block_stop', { type: 'content_block_stop', index: textIndex }));
    res.write(SSE('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }));
    res.write(SSE('message_stop', { type: 'message_stop' }));
    res.end();
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const provider = {
  id: 'mock-anthropic', name: 'Mock Anthropic', baseUrl: base,
  apiKey: 'sk-test', enabled: true, models: ['claude-sonnet-4-5'], kind: 'anthropic'
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-thinking-'));
await initDb(tmp, 'thinking.db');

const run = (overrides = {}) => runGeneration(
  {
    provider, model: 'claude-sonnet-4-5',
    messages: [{ role: 'system', content: 'You are concise.' }, { role: 'user', content: 'Reply OK.' }],
    thinkingEnabled: true, thinkingBudget: 4096, toolsEnabled: false,
    ...overrides
  },
  () => {},
  () => false
);

// ------------------------------------------------------- [A] thinking on ---
{
  seen.length = 0;
  mode = 'ok';
  const result = await run();
  const body = seen[0] || {};
  check('enabled: request carries thinking with the requested budget',
    body.thinking?.type === 'enabled' && body.thinking?.budget_tokens === 4096,
    JSON.stringify(body.thinking));
  check('enabled: max_tokens leaves room for the answer',
    typeof body.max_tokens === 'number' && body.max_tokens >= 4096 + 2048, String(body.max_tokens));
  check('enabled: temperature/top_p are omitted (required by extended thinking)',
    body.temperature === undefined && body.top_p === undefined);
  check('enabled: reasoning is returned separately from the text',
    result.thinking === 'pondering' && result.text === 'OK', JSON.stringify({ t: result.text, th: result.thinking }));
  check('enabled: cache reuse is still read', result.tokensCached === 5, String(result.tokensCached));
  check('enabled: retry flag is not set', !result.thinkingRejected);
}

// ------------------------------------------------------ [B] thinking off ---
{
  seen.length = 0;
  const result = await run({ thinkingEnabled: false });
  const body = seen[0] || {};
  check('disabled: no thinking parameter is sent', body.thinking === undefined);
  check('disabled: text still streams', result.text === 'OK' && !result.thinking);
  check('disabled: temperature is kept', typeof body.temperature === 'number', String(body.temperature));
}

// ------------------------------------------------ [C] rejected → retry ----
{
  seen.length = 0;
  mode = 'reject';
  const result = await run();
  check('rejected: the provider refuses thinking', seen.length === 2 && !!seen[0].thinking,
    `${seen.length} request(s)`);
  check('rejected: the retry drops the parameter', seen[1] && seen[1].thinking === undefined);
  check('rejected: the reply still arrives', result.text === 'OK');
  check('rejected: the retry is reported to the renderer', result.thinkingRejected === true);
  check('rejected: no reasoning is reported for the retried answer', !result.thinking);
}

server.close();
closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL THINKING TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
