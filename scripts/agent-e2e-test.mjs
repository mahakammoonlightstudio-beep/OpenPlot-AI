/**
 * Agent end-to-end test (Task: one run = project + bible + chapter).
 *
 * A mock OpenAI-compatible provider emits CONSECUTIVE tool calls across many
 * rounds — 12 story entries plus a chapter, i.e. more rounds than the old
 * 10-round cap — and the real runGeneration() loop has to keep going, execute
 * every call, and finish with a normal reply.
 *
 * Run: npm run build:electron && node scripts/agent-e2e-test.mjs
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb } = require('../dist-electron/db.js');
const { runGeneration } = require('../dist-electron/ai.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const ENTRIES = 12;
let round = 0;
let projectId = null;
const seen = [];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url || '')) {
    res.writeHead(404); res.end('{}'); return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    // The agent must pass the created project id on every later call; read it
    // from the tool result the runtime returned, exactly as a model would.
    for (const m of parsed.messages || []) {
      if (m.role !== 'tool') continue;
      try {
        const j = JSON.parse(m.content);
        if (j && j.ok && j.id && /Pass this id/.test(String(j.next || ''))) projectId = j.id;
      } catch { /* not JSON */ }
    }
    round++;
    seen.push(round);
    const sse = (frames) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const toolFrame = (name, args, finish = 'tool_calls') => [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + round, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: finish }] }
    ];

    if (round === 1) {
      sse(toolFrame('create_project', { name: 'Agent E2E', description: 'built by the agent', format: 'novel', rating: 'teen' }));
      return;
    }
    if (round <= 1 + ENTRIES) {
      const n = round - 1;
      sse(toolFrame('create_story_entry', {
        kind: n % 2 ? 'character' : 'lore',
        title: 'Entry ' + n,
        content: 'Content for entry ' + n,
        projectId
      }));
      return;
    }
    if (round === 2 + ENTRIES) {
      // Some relays report "stop" while still returning a tool call; the loop
      // must act on the call instead of dropping it.
      sse(toolFrame('create_chapter', { title: 'Opening', content: 'It began in fog.', projectId }, 'stop'));
      return;
    }
    sse([
      { choices: [{ delta: { content: 'Created project Agent E2E with ' + ENTRIES + ' bible entries and 1 chapter.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-agent-e2e-'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

try {
  await initDb(tmp, 'agent-e2e.db');

  const toolEvents = [];
  const result = await runGeneration(
    {
      provider: {
        id: 'mock-agent', name: 'Mock Agent',
        baseUrl: 'http://127.0.0.1:' + port + '/v1',
        apiKey: 'test', enabled: true, models: ['mock-agent'], kind: 'openai'
      },
      model: 'mock-agent',
      messages: [
        { role: 'system', content: 'You are an agent. Build the project the user asks for.' },
        { role: 'user', content: 'Make a brand-new novel project with 12 bible entries and an opening chapter.' }
      ],
      toolsEnabled: true,
      projectId: null
    },
    (chunk) => { if (chunk.type === 'tool' && chunk.tool) toolEvents.push(chunk.tool.name); },
    () => false
  );

  check('the run went past the old 10-round cap', round === ENTRIES + 3, String(round));
  check('every tool call was executed, in order',
    result.toolsUsed.length === ENTRIES + 2
    && result.toolsUsed[0] === 'create_project'
    && result.toolsUsed.filter((n) => n === 'create_story_entry').length === ENTRIES
    && result.toolsUsed[ENTRIES + 1] === 'create_chapter',
    JSON.stringify(result.toolsUsed));
  check('a tool call reported with finish_reason "stop" still ran',
    result.toolsUsed.includes('create_chapter'), JSON.stringify(result.toolsUsed.slice(-2)));
  check('live tool chunks were streamed to the UI', toolEvents.length === ENTRIES + 2, String(toolEvents.length));
  check('the run ended with a normal reply, not a stall',
    /Created project Agent E2E/.test(result.text), result.text.slice(0, 80));

  const projects = handleDb('listProjects', {});
  const project = projects.find((p) => p.name === 'Agent E2E');
  check('exactly one project was created', projects.length === 1 && !!project, JSON.stringify(projects.map((p) => p.name)));

  const story = handleDb('listStory', {});
  check('all bible entries landed in the new project',
    story.length === ENTRIES && story.every((e) => e.project_id === project.id),
    JSON.stringify({ count: story.length, ids: [...new Set(story.map((e) => e.project_id))] }));

  const chapters = handleDb('listChapters', { projectId: project.id });
  check('the chapter landed in the same project',
    chapters.length === 1 && chapters[0].title === 'Opening' && /fog/.test(chapters[0].content),
    JSON.stringify(chapters.map((c) => c.title)));
} catch (e) {
  check('run finished without throwing', false, String(e && e.message || e).slice(0, 200));
} finally {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (failed === 0 ? 'ALL AGENT E2E CHECKS PASSED (' + results.length + ')' : failed + ' CHECK(S) FAILED'));
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 200);
