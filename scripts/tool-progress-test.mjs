/**
 * Agent tool progress labels (headless).
 *
 * The streaming bubble lists each tool call as it lands. This locks the mapping
 * from a tool result to a readable step: what kind of thing was touched, its
 * title, and whether the call reported an error.
 *
 * Run: node scripts/tool-progress-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const PROJ = path.resolve(import.meta.dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-tool-progress-'));
const outfile = path.join(outDir, 'tool-progress.cjs');

await build({
  entryPoints: [path.join(PROJ, 'src/lib/toolProgress.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'silent'
});

const { describeToolStep } = require(outfile);
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const project = describeToolStep('create_project', JSON.stringify({ ok: true, id: 'p1', name: 'Agent E2E', next: 'Pass this id as projectId on every later call.' }));
check('project step carries the project name', project.kind === 'project' && project.detail === 'Agent E2E' && project.ok, JSON.stringify(project));

const entry = describeToolStep('create_story_entry', JSON.stringify({ ok: true, id: 's1', kind: 'character', title: 'Mira' }));
check('bible step carries the entry title', entry.kind === 'entry' && entry.detail === 'Mira' && entry.ok, JSON.stringify(entry));

const chapter = describeToolStep('append_to_chapter', JSON.stringify({ ok: true, id: 'c1', title: 'Opening' }));
check('chapter step covers append as well as create', chapter.kind === 'chapter' && chapter.detail === 'Opening', JSON.stringify(chapter));

const failed = describeToolStep('create_chapter', JSON.stringify({ error: 'No project exists yet. Call create_project first, then pass its id as projectId.' }));
check('a failed step is marked and shows the reason',
  failed.ok === false && /create_project/.test(failed.detail), JSON.stringify(failed));

const searched = describeToolStep('search_story', JSON.stringify({ entries: [{ title: 'a' }, { title: 'b' }], files: [] }));
check('a search step reports how many hits it found', searched.kind === 'search' && searched.detail === '2', JSON.stringify(searched));

const memory = describeToolStep('save_memory', 'Memory saved.');
check('a plain-text result is a successful memory step', memory.kind === 'memory' && memory.ok && memory.detail === '', JSON.stringify(memory));

const unknown = describeToolStep('mcp_custom_thing', JSON.stringify({ ok: true, result: 'x' }));
check('an unknown tool still renders as a step', unknown.kind === 'other' && unknown.ok, JSON.stringify(unknown));

fs.rmSync(outDir, { recursive: true, force: true });

const failedCount = results.filter((r) => !r.ok).length;
console.log('\n' + (failedCount === 0 ? 'ALL TOOL PROGRESS TESTS PASSED (' + results.length + ')' : failedCount + ' CHECK(S) FAILED'));
process.exit(failedCount === 0 ? 0 : 1);
