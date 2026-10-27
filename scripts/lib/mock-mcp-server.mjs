/**
 * Mock MCP server for `scripts/mcp-test.mjs` (v1.2.3 Task 13).
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio, like a real server:
 *   --tools        echo, slow (600 ms), fail (returns isError), huge (2 MB), env
 *   --no-tools     initialize only, then answers tools/list with an empty list
 *   --fail-init    exits immediately after start (simulates a broken server)
 *   --bad-json     writes a non-JSON line first (must be ignored, not fatal)
 *   --big-line     sends one response line larger than the 1 MB cap
 *
 * Usage: node mock-mcp-server.mjs --tools
 */
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has('--fail-init')) {
  console.error('mock-mcp: refusing to start');
  process.exit(3);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const TOOLS = [
  { name: 'echo', description: 'Echo the given text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'slow', description: 'Answer after 600 ms', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'huge', description: 'Returns 2 MB of text', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Echoes back an environment variable', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'weird name!!', description: 'Tool with characters that must be sanitized', inputSchema: { type: 'object', properties: {} } }
];

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id == null) return; // notifications are not answered
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (message) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });

  switch (msg.method) {
    case 'initialize':
      if (has('--bad-json')) process.stdout.write('this is not json\n');
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' }
      });
      return;
    case 'tools/list':
      reply({ tools: has('--no-tools') ? [] : TOOLS });
      return;
    case 'tools/call': {
      const name = msg.params?.name;
      const input = msg.params?.arguments || {};
      if (name === 'echo') return reply({ content: [{ type: 'text', text: `echo: ${input.text ?? ''}` }] });
      if (name === 'slow') {
        setTimeout(() => reply({ content: [{ type: 'text', text: 'slow done' }] }), 600);
        return;
      }
      if (name === 'fail') return reply({ content: [{ type: 'text', text: 'deliberate failure' }], isError: true });
      if (name === 'huge') return reply({ content: [{ type: 'text', text: has('--big-line') ? 'x'.repeat(1_200_000) : 'y'.repeat(60_000) }] });
      if (name === 'env') return reply({ content: [{ type: 'text', text: String(process.env[input.name] ?? '') }] });
      if (name === 'weird name!!') return reply({ content: [{ type: 'text', text: 'sanitized ok' }] });
      return fail(`unknown tool ${name}`);
    }
    default:
      return fail(`unknown method ${msg.method}`);
  }
}
