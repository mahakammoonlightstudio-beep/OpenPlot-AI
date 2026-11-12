/**
 * Skills v2 tests (v1.2.3 Task 7).
 *
 * Covers the parts that used to be wrong: builtin seeding is idempotent (not
 * "only when the table is empty"), a new skill is born DISABLED, builtins cannot
 * be deleted but can be reset, and re-initialising a database adds nothing.
 *
 * Run: npm run build:electron && node scripts/skills-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb, DEFAULT_SKILLS } = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const skills = () => handleDb('listSkills', {}) || [];
const byId = (id) => skills().find((s) => s.id === id);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-skills-'));
await initDb(tmp, 'skills.db');

// --------------------------------------------------------------- builtins ---
check('seed: ships the full builtin skill set', DEFAULT_SKILLS.length === 9, String(DEFAULT_SKILLS.length));
check('seed: every builtin has an id, name, description and content',
  DEFAULT_SKILLS.every((s) => /^skill-/.test(s.id) && s.name && s.description && s.content.length > 40));
check('seed: the database holds every builtin', skills().filter((s) => Number(s.builtin) === 1).length === DEFAULT_SKILLS.length);
check('seed: builtins start DISABLED (skills are opt-in via /skill)',
  skills().every((s) => Number(s.enabled) === 0));
check('seed: descriptions are persisted', skills().every((s) => String(s.description || '').length > 10));
check('seed: every builtin has a valid category',
  skills().every((s) => ['chat', 'agent', 'writing'].includes(String(s.category))));

// ------------------------------------------------------------ enable gate ---
const added = handleDb('saveSkill', { name: 'My voice', content: 'Write like a tired detective.' });
check('add: a new skill is saved disabled', Number(added?.enabled) === 0, JSON.stringify(added));
check('add: a new skill is not builtin', Number(added?.builtin) === 0);
check('add: it is listed right away', !!byId(added.id));
check('add: an omitted category defaults to writing', added?.category === 'writing', String(added?.category));

const enabled = handleDb('saveSkill', { id: added.id, name: 'My voice', content: 'Write like a tired detective.', category: 'agent', enabled: true });
check('enable: the explicit toggle sticks', Number(enabled?.enabled) === 1);
check('category: an explicit category is stored', enabled?.category === 'agent', String(enabled?.category));
const kept = handleDb('saveSkill', { id: added.id, name: 'My voice', content: 'Write like a tired detective.', enabled: false });
check('category: an omitted category keeps the stored one', kept?.category === 'agent', String(kept?.category));

// --------------------------------------------------------------- builtins ---
const edited = handleDb('saveSkill', {
  id: 'skill-prose', name: 'Prose Polisher (mine)', description: 'edited', content: 'Edited instructions', enabled: true
});
check('builtin: editing keeps the builtin flag', Number(edited?.builtin) === 1);
check('builtin: edited text is stored as written', edited?.content === 'Edited instructions');

let deleteRefused = false;
try { handleDb('deleteSkill', { id: 'skill-prose' }); } catch { deleteRefused = true; }
check('builtin: delete is refused', deleteRefused && !!byId('skill-prose'));

const reset = handleDb('resetSkill', { id: 'skill-prose' });
const shipped = DEFAULT_SKILLS.find((s) => s.id === 'skill-prose');
check('builtin: reset restores the shipped name and content',
  reset?.name === shipped.name && reset?.content === shipped.content && reset?.description === shipped.description);
check('builtin: reset restores the shipped category', reset?.category === shipped.category, String(reset?.category));

let resetRefused = false;
try { handleDb('resetSkill', { id: added.id }); } catch { resetRefused = true; }
check('builtin: reset refuses a user skill', resetRefused);

// ------------------------------------------------------------- user skills ---
handleDb('deleteSkill', { id: added.id });
check('user: delete removes the row', !byId(added.id));

// ------------------------------------------------------------ idempotency ---
closeDb();
await initDb(tmp, 'skills.db');
check('reseed: reopening adds no duplicates', skills().length === DEFAULT_SKILLS.length, String(skills().length));
check('reseed: an edited builtin is not overwritten',
  byId('skill-prose')?.content === shipped.content);

handleDb('resetAll', {});
const afterReset = skills();
check('resetAll: builtins are re-seeded immediately',
  afterReset.length === DEFAULT_SKILLS.length && afterReset.every((s) => Number(s.builtin) === 1), String(afterReset.length));

closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL SKILLS TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
