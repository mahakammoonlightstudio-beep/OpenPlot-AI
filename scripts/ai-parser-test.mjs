/**
 * Unit tests for the exported parsing helpers in electron/ai.ts:
 *  1. baseUrlCandidates — URL normalization / candidate generation
 *  2. SseParser        — incremental SSE event splitting (feed chunks, get events)
 *  3. dataLines        — `data:` line extraction from an SSE event
 *  4. integration      — parser + dataLines round-trip (OpenAI-style stream)
 *  5. extractError     — provider error bodies → human-readable message
 *  6. statusHint       — HTTP status codes → actionable explanation
 *
 * Pure unit tests — no network, no DB, no Electron.
 * Requires a prior `npm run build:electron` (tests run against dist-electron/ai.js,
 * same convention as url-fix-test.mjs / engine-test.mjs).
 *
 * Run: node scripts/ai-parser-test.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseUrlCandidates, SseParser, dataLines, extractError, statusHint } = require('../dist-electron/ai.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.error(`  ❌ ${name} ${detail}`); failures++; }
}
const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want);

// ============================================================
console.log('\n[1] baseUrlCandidates');
const cases = [
  // --- happy paths (mirror of url-fix-test.mjs, kept as regression net) ---
  ['https://api.openai.com/v1', ['https://api.openai.com/v1']],
  ['https://api.openai.com/v1/', ['https://api.openai.com/v1']],
  ['https://api.openai.com/v1/chat/completions', ['https://api.openai.com/v1', 'https://api.openai.com']],
  ['api.openai.com/v1', ['https://api.openai.com/v1']],
  ['https://api.openai.com', ['https://api.openai.com', 'https://api.openai.com/v1']],
  // --- full endpoints: every known suffix peels back to its API root ---
  ['https://relay.example.com/v1/messages', ['https://relay.example.com/v1', 'https://relay.example.com']],
  ['https://relay.example.com/v1/completions', ['https://relay.example.com/v1', 'https://relay.example.com']],
  ['https://relay.example.com/v1/models', ['https://relay.example.com/v1', 'https://relay.example.com']],
  ['https://relay.example.com/v1/embeddings', ['https://relay.example.com/v1', 'https://relay.example.com']],
  // --- pasted endpoint WITHOUT version segment → root fallback ---
  ['https://relay.example.com/chat/completions', ['https://relay.example.com', 'https://relay.example.com/v1']],
  // --- non-standard version segment is treated as the version root ---
  ['https://relay.example.com/v2beta/chat/completions', ['https://relay.example.com/v2beta', 'https://relay.example.com']],
  // --- anthropic-style /api root ---
  ['https://relay.example.com/api', ['https://relay.example.com/api']],
  ['https://relay.example.com/api/v1', ['https://relay.example.com/api/v1']],
  // --- trailing slash on a bare host still yields the /v1 fallback ---
  ['https://api.openai.com/', ['https://api.openai.com', 'https://api.openai.com/v1']],
  // --- http:// is preserved (local LLM servers like LM Studio/Ollama) ---
  ['http://127.0.0.1:1234/v1', ['http://127.0.0.1:1234/v1']],
  // --- junk is rejected, never throws ---
  ['ftp://nope', []],
  ['', []],
  ['not a url ://', []],
  ['javascript:alert(1)', []]
];
for (const [input, expected] of cases) {
  let got, threw = false;
  try { got = baseUrlCandidates(input); } catch { threw = true; }
  check(
    `${input || '(empty)'} → [${expected.join(' | ')}]`,
    !threw && eq(got, expected),
    threw ? 'THREW' : `got [${(got || []).join(' | ')}]`
  );
}
// candidates must never contain duplicates (tryHttpRequest walks them in order)
const dup = baseUrlCandidates('https://x.io/v1/chat/completions/');
check('no duplicate candidates', eq(dup, [...new Set(dup)]), `got [${dup.join(' | ')}]`);

// ============================================================
console.log('\n[2] SseParser');
{
  // complete events split on the blank-line separator
  const p = new SseParser();
  const two = p.push('data: a\n\ndata: b\n\n');
  check('two complete events in one chunk',
    eq(two, ['data: a', 'data: b']),
    JSON.stringify(two));

  // CRLF variant (some relays use \r\n\r\n)
  const p2 = new SseParser();
  const crlf = p2.push('data: a\r\n\r\ndata: b\r\n\r\n');
  check('CRLF separator handled',
    eq(crlf, ['data: a', 'data: b']),
    JSON.stringify(crlf));

  // incremental feeding: nothing emerges until the separator arrives
  const p3 = new SseParser();
  check('partial event is buffered, not emitted', eq(p3.push('data: hel'), []), JSON.stringify(p3.buf));
  check('still buffered after more bytes', eq(p3.push('lo'), []), JSON.stringify(p3.buf));
  const evts = p3.push('world\n\n');
  check('event emitted once separator arrives',
    evts.length === 1 && evts[0] === 'data: helloworld', JSON.stringify(evts));
  check('buffer empty after emit', p3.buf === '', JSON.stringify(p3.buf));

  // several events inside ONE network chunk (coalesced TCP packets)
  const p4 = new SseParser();
  const many = p4.push('data: 1\n\ndata: 2\n\ndata: 3\n\n');
  check('three coalesced events in one chunk', many.length === 3, JSON.stringify(many));

  // trailing partial stays buffered; flush() returns it instead of dropping
  const p5 = new SseParser();
  p5.push('data: done\n\ndata: tail-without-newline');
  check('trailing partial stays buffered before flush', p5.buf === 'data: tail-without-newline');
  const tail = p5.flush();
  check('flush() returns the leftover event', tail.length === 1 && tail[0] === 'data: tail-without-newline', JSON.stringify(tail));
  check('flush() empties the buffer', p5.buf === '');

  // flush with nothing pending → no phantom events
  check('flush() with empty buffer → []', eq(new SseParser().flush(), []));

  // whitespace-only leftover is dropped by flush (matches splitEvents semantics)
  const p6 = new SseParser();
  p6.push('data: x\n\n   \n');
  check('flush() drops whitespace-only leftover', eq(p6.flush(), []), JSON.stringify(p6.buf));

  // the whole thing must behave identically whether data arrived in 1 or N chunks
  const body = 'data: one\n\ndata: two\n\ndata: three\n\n';
  const once = new SseParser(); const allAtOnce = once.push(body).concat(once.flush());
  const drip = new SseParser(); let allDrip = [];
  for (const ch of body.split(/(?=\n)/)) allDrip = allDrip.concat(drip.push(ch));
  allDrip = allDrip.concat(drip.flush());
  check('chunked feeding == single-chunk feeding', eq(allDrip, allAtOnce) && allAtOnce.length === 3,
    `once=${JSON.stringify(allAtOnce)} drip=${JSON.stringify(allDrip)}`);
}

// ============================================================
console.log('\n[3] dataLines');
{
  check('single data line', eq(dataLines('data: hello'), ['hello']));
  check('data: without space is trimmed', eq(dataLines('data:hello'), ['hello']));
  check('multi-line event keeps only data lines',
    eq(dataLines('event: message\nid: 7\ndata: {"a":1}\nretry: 500\ndata: tail'), ['{"a":1}', 'tail']));
  check('SSE comment lines are ignored', eq(dataLines(': keep-alive ping\ndata: real'), ['real']));
  check('event with no data lines → []', eq(dataLines('event: ping\nid: 3'), []));
  check('empty event → []', eq(dataLines(''), []));
  check('CRLF event works', eq(dataLines('data: a\r\ndata: b\r\n'), ['a', 'b']));
  check('whitespace after data: is trimmed', eq(dataLines('data:    spaced   '), ['spaced']));
  // a JSON payload containing the literal text "data:" must survive intact
  check('payload containing "data:" is not re-split',
    eq(dataLines('data: {"note":"see data: below"}'), ['{"note":"see data: below"}']));
}

// ============================================================
console.log('\n[4] integration: parser + dataLines round-trip (OpenAI-style stream)');
{
  // A realistic SSE body: usage chunk, [DONE], error chunk — like runOpenAI re-parses
  const body = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
    ''
  ].join('\n');
  const p = new SseParser();
  const events = p.push(body).concat(p.flush());
  const payloads = events.flatMap(dataLines).filter((s) => s && s !== '[DONE]');
  const jsons = payloads.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  check('3 usable JSON payloads parsed ([DONE] excluded)', jsons.length === 3, JSON.stringify(payloads));
  check('text delta present', jsons[0]?.choices?.[0]?.delta?.content === 'Hi');
  check('finish_reason captured', jsons[1]?.choices?.[0]?.finish_reason === 'stop');
  check('usage captured', jsons[2]?.usage?.completion_tokens === 2);
  check('[DONE] excluded', !payloads.includes('[DONE]'));
}

// ============================================================
console.log('\n[5] extractError');
{
  // --- JSON error bodies: dig out the human message ---
  check('openai-style error.message is extracted',
    extractError(JSON.stringify({ error: { message: 'Invalid API key' } })) === 'Invalid API key');
  check('anthropic-style {type:error,error:{message}} is extracted',
    extractError(JSON.stringify({ type: 'error', error: { message: 'max_tokens too large' } })) === 'max_tokens too large');
  check('flat {message} is extracted',
    extractError(JSON.stringify({ message: 'quota exceeded' })) === 'quota exceeded');
  check('error.message wins over sibling fields',
    extractError(JSON.stringify({ error: { message: 'inner' }, message: 'outer' })) === 'inner');

  // --- HTML bodies: readable hint, no raw markup dumped into a toast ---
  const html = '<!DOCTYPE HTML><html><head><title>Just a moment...</title></head><body>challenge</body></html>';
  const htmlOut = extractError(html);
  check('HTML page produces readable message', /web page/i.test(htmlOut), htmlOut);
  check('HTML <title> is included', /Just a moment\.\.\./.test(htmlOut), htmlOut);
  check('no raw HTML markup leaks into the message', !/<[a-z!]/i.test(htmlOut), htmlOut);
  const htmlNoTitle = extractError('<html><body>blocked</body></html>');
  check('HTML without <title> still readable', /web page/i.test(htmlNoTitle) && !/<[a-z!]/i.test(htmlNoTitle), htmlNoTitle);
  check('html tag case-insensitive (<HTML>)', /web page/i.test(extractError('<HTML><BODY>x</BODY></HTML>')));

  // --- non-JSON, non-HTML: trimmed prefix of the raw body ---
  check('plain text body is trimmed and returned', extractError('  relay says no  ') === 'relay says no');
  check('long non-JSON body is cut to 200 chars',
    extractError('x'.repeat(500)).length === 200);

  // --- degenerate inputs never throw ---
  check('empty body → "unknown error"', extractError('') === 'unknown error');
  check('whitespace-only body → "unknown error"', extractError('   \n\r\t ') === 'unknown error');
  check('null-ish body → "unknown error"', extractError(undefined) === 'unknown error');
  const trunc = '{"error":{"message":"cut o';
  check('truncated JSON falls back to raw text',
    extractError(trunc) === trunc);
}

// ============================================================
console.log('\n[6] statusHint');
{
  // every mapped status gets an actionable hint (not just "Provider error N")
  const mapped = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504];
  for (const s of mapped) {
    const msg = statusHint(s, '');
    check(`${s} → specific hint`,
      !msg.startsWith('Provider error') && msg.includes(`(${s})`), msg);
  }
  // unmapped status → generic fallback, never throws
  check('418 → generic fallback', statusHint(418, '').startsWith('Provider error 418'));
  check('599 → generic fallback', statusHint(599, '').startsWith('Provider error 599'));

  // provider message is appended as (provider said: "…")
  const withRaw = statusHint(429, 'rate limit exceeded for org');
  check('provider message appended for 429', /provider said: "rate limit exceeded/.test(withRaw), withRaw);
  const withRaw400 = statusHint(400, 'model gpt-nope does not exist');
  check('provider message appended for 400', /model gpt-nope does not exist/.test(withRaw400), withRaw400);
  const rawLen = statusHint(500, 'e'.repeat(500));
  const capMatch = rawLen.match(/provider said: "(e+)"/);
  check('provider message capped at 120 chars and well-formed',
    !!capMatch && capMatch[1].length === 120, `matched ${capMatch ? capMatch[1].length : 'none'}`);

  // 'unknown error' (extractError's empty-body sentinel) is NOT echoed back
  const noRaw = statusHint(401, 'unknown error');
  check('"unknown error" is not appended', !noRaw.includes('unknown error'), noRaw);
  check('empty provider message adds no raw section', !statusHint(404, '').includes('provider said'), statusHint(404, ''));

  // hint content is actionable: points at the real fix
  check('400 hint suggests checking model id', /model/i.test(statusHint(400, '')));
  check('401 hint mentions API key', /API key/i.test(statusHint(401, '')));
  check('404 hint mentions Base URL', /Base URL/i.test(statusHint(404, '')));
  check('429 hint mentions retry', /retry|wait/i.test(statusHint(429, '')));
  check('5xx hints blame the provider side', /provider/i.test(statusHint(502, '')));
}

console.log(failures === 0 ? '\n🟢 ALL AI-PARSER TESTS PASSED\n' : `\n🔴 ${failures} TEST(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
