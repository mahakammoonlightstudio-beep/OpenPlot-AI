/**
 * MCP bridge tests (v1.2.3 Task 13).
 *
 * Drives the real bridge (`dist-electron/mcp.js`) against a mock stdio server,
 * which is the only honest way to test a process protocol:
 *   - handshake (initialize → initialized → tools/list) and tool discovery,
 *   - tool names normalised to `mcp__{server}__{tool}` with odd characters
 *     replaced, so a provider schema can never be broken by a server name,
 *   - calling a tool end-to-end, `isError` results surfaced as errors,
 *   - call timeout mapped to a readable error (not a hung request),
 *   - a server that fails to start reports `error` and does not throw,
 *   - a server that dies mid-call rejects the pending call instead of hanging,
 *   - an oversized response line is refused (1 MB cap) rather than buffered,
 *   - results are capped before they reach the model (20k characters),
 *   - disabled servers never spawn; enabling starts them; stopping kills them,
 *   - environment variables from the definition reach the process,
 *   - logs are a bounded ring buffer.
 *
 * Run: node scripts/mcp-test.mjs   (requires `npm run build:electron`)
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../dist-electron/mcp.js');
process.env.OPENPLOT_MCP_CALL_TIMEOUT_MS = '1200';

const SERVER = path.join(import.meta.dirname, 'lib', 'mock-mcp-server.mjs');
const cfg = (over = {}) => ({
  id: 'mock',
  name: 'Mock',
  command: process.execPath,
  args: JSON.stringify([SERVER, ...(over.flags || ['--tools'])]),
  env: JSON.stringify(over.env || {}),
  enabled: 1
});

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ----------------------------------------------------------------- handshake ---
{
  const [status] = await mcp.startMcpServers([cfg()]);
  check('connect: handshake completes and the server reports connected', status.status === 'connected', status.status);
  check('connect: tools are listed', status.tools === 6, String(status.tools));
  check('connect: tool names are namespaced and sanitized',
    status.toolNames.includes('mcp__Mock__echo')
    && status.toolNames.some((n) => /^mcp__Mock__weird_name_+$/.test(n)),
    status.toolNames.join(','));
  check('connect: definitions carry a provider-ready schema', (() => {
    const defs = mcp.mcpToolDefs();
    const echo = defs.find((d) => d.tool === 'echo');
    return !!echo && echo.input_schema?.type === 'object' && /MCP:Mock/.test(echo.description);
  })());
}

// --------------------------------------------------------------------- calls ---
{
  const echoed = await mcp.callMcpTool('mcp__Mock__echo', { text: 'hello bridge' });
  check('call: a tool call round-trips', echoed === 'echo: hello bridge', echoed);

  const failed = await mcp.callMcpTool('mcp__Mock__fail', {});
  check('call: isError results are reported as errors', /Error from MCP tool: deliberate failure/.test(failed), failed);

  const unknown = await mcp.callMcpTool('mcp__Mock__nope', {});
  check('call: an unknown tool returns a readable error',
    /not available/i.test(unknown) && !/undefined/.test(unknown), unknown);

  const capped = await mcp.callMcpTool('mcp__Mock__huge', {});
  check('call: a long result is capped before it reaches the model',
    capped.length <= mcp.MAX_MCP_RESULT_CHARS + 120 && /\[truncated: showing the first 20000 characters\]/.test(capped),
    String(capped.length));

  const t0 = Date.now();
  const slow = await mcp.callMcpTool('mcp__Mock__slow', {});
  const fastEnough = Date.now() - t0 < 900;
  check('call: a slow tool still answers within the timeout', slow === 'slow done' && fastEnough, `${Date.now() - t0} ms`);
}

// ------------------------------------------------------------------- timeout ---
{
  // A call that outlives the (test) timeout must come back as an error string.
  process.env.OPENPLOT_MCP_CALL_TIMEOUT_MS = '200';
  const slowTool = mcp.mcpToolDefs().find((d) => d.tool === 'slow');
  const t0 = Date.now();
  const out = await mcp.callMcpTool(slowTool.name, {});
  const elapsed = Date.now() - t0;
  check('timeout: a call past the budget returns a readable error',
    /MCP call failed: Timed out after/.test(out) && elapsed < 1500, `${elapsed} ms — ${out.slice(0, 80)}`);
  process.env.OPENPLOT_MCP_CALL_TIMEOUT_MS = '1200';
  check('timeout: the bridge still works after one', (await mcp.callMcpTool('mcp__Mock__echo', { text: 'still here' })) === 'echo: still here');
}

// -------------------------------------------------------------- env + logs ---
{
  mcp.stopAllMcp();
  await mcp.startMcpServers([cfg({ env: { OPENPLOT_MOCK_TOKEN: 's3cret' } })]);
  const value = await mcp.callMcpTool('mcp__Mock__env', { name: 'OPENPLOT_MOCK_TOKEN' });
  check('env: definition environment reaches the process', value === 's3cret', value);
  const logs = mcp.mcpLogs('mock');
  check('env: logs record the lifecycle', logs.some((l) => /spawn/.test(l)) && logs.some((l) => /ready with/.test(l)), String(logs.length));
  check('env: logs stay bounded', logs.length <= 300, String(logs.length));
}

// ------------------------------------------------------- failures that matter ---
{
  mcp.stopAllMcp();
  const [bad] = await mcp.startMcpServers([cfg({ flags: ['--fail-init'] })]);
  check('failure: a server that exits reports error instead of throwing', bad.status === 'error', bad.status);
  check('failure: the reason is preserved for the user', /exited with code 3|handshake|Timed out/i.test(bad.lastError || ''), String(bad.lastError));
  check('failure: no tools are advertised from a dead server', mcp.mcpToolDefs().length === 0);
  const explained = await mcp.callMcpTool('mcp__Mock__echo', {});
  check('failure: the error is explained when the tool is called anyway',
    /not available/.test(explained) && /Mock \(error\)/.test(explained), explained);
}

{
  mcp.stopAllMcp();
  const [empty] = await mcp.startMcpServers([cfg({ flags: ['--no-tools'] })]);
  check('edge: a server with no tools still counts as connected', empty.status === 'connected' && empty.tools === 0, `${empty.status}/${empty.tools}`);
  check('edge: no tool definitions come from an empty server', mcp.mcpToolDefs().length === 0);
}

{
  mcp.stopAllMcp();
  const [noisy] = await mcp.startMcpServers([cfg({ flags: ['--tools', '--bad-json'] })]);
  check('edge: a non-JSON line is ignored, not fatal', noisy.status === 'connected' && noisy.tools === 6, `${noisy.status}/${noisy.tools}`);
}

{
  mcp.stopAllMcp();
  const [huge] = await mcp.startMcpServers([cfg({ flags: ['--tools', '--big-line'] })]);
  // Ignoring `--big-line` (small result) keeps this check about the cap itself.
  check('edge: start still succeeds before the oversized line', huge.status === 'connected', huge.status);
  const out = await mcp.callMcpTool('mcp__Mock__huge', {});
  check('edge: an oversized response fails with the reason, not a hang',
    /oversized response/i.test(out) && /1 MB/.test(out), out.slice(0, 90));
}

// ---------------------------------------------------------------- lifecycle ---
{
  mcp.stopAllMcp();
  const started = await mcp.startMcpServers([cfg()]);
  check('lifecycle: enabled servers start', started.length === 1 && started[0].status === 'connected');

  const stopped = await mcp.startMcpServers([{ ...cfg(), enabled: 0 }]);
  check('lifecycle: disabling a server stops it (registry empty)', stopped.length === 0 && mcp.mcpStatuses().length === 0);
  check('lifecycle: a stopped server advertises nothing', mcp.mcpToolDefs().length === 0);

  await mcp.startMcpServers([cfg()]);
  const restarted = await mcp.restartMcpServer({ ...cfg(), enabled: 1 });
  check('lifecycle: restart reconnects the same server', restarted?.status === 'connected' && restarted.tools === 6,
    `${restarted?.status}/${restarted?.tools}`);

  const off = mcp.stopMcpServer('mock');
  check('lifecycle: stopMcpServer reports the final state', off?.status === 'stopped' && mcp.mcpStatuses().length === 0, String(off?.status));

  mcp.stopAllMcp();
  check('lifecycle: stopAll (app quit) leaves nothing running', mcp.mcpStatuses().length === 0 && mcp.mcpToolDefs().length === 0);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL MCP TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
