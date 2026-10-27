/**
 * Prompt-library portability tests (v1.2.3 Task 15).
 *
 * `parsePromptImport` is the only path by which foreign JSON reaches the
 * prompts table, so it gets its own suite: shape tolerance, required fields,
 * category normalisation, de-duplication (against the library AND within one
 * file) and the size cap.
 *
 * Run: node scripts/prompt-bundle-test.mjs
 */
import { loadTs } from './lib/load-ts.mjs';

const {
  buildPromptBundle, parsePromptImport, promptKey, PROMPT_IMPORT_MAX
} = await loadTs('src/promptLibrary.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const row = (id, title, category = 'user', template = 'do the thing') => ({ id, title, category, template });

// ----------------------------------------------------------------- export ---
const bundle = JSON.parse(buildPromptBundle([
  row('1', 'Chapter critique'),
  row('2', 'Logline', 'craft', 'Write a logline for {premise}')
]));
check('export: carries app/kind/version metadata',
  bundle.app === 'OpenPlot AI' && bundle.kind === 'prompt-library' && bundle.version === 1);
check('export: one entry per prompt with title/category/template',
  bundle.prompts.length === 2
  && bundle.prompts[0].title === 'Chapter critique'
  && bundle.prompts[1].template === 'Write a logline for {premise}');
check('export: empty library still produces a valid bundle',
  JSON.parse(buildPromptBundle([])).prompts.length === 0);

// ----------------------------------------------------------------- import ---
const fresh = parsePromptImport(buildPromptBundle([row('1', 'Chapter critique')]), []);
check('import: round-trips an exported bundle',
  fresh.accepted.length === 1 && fresh.accepted[0].title === 'Chapter critique');

const bare = parsePromptImport(JSON.stringify([{ title: 'A', template: 'body' }]), []);
check('import: a bare array is accepted', bare.accepted.length === 1);

check('import: invalid JSON is reported, not thrown',
  parsePromptImport('{nope', []).errors.length === 1 && parsePromptImport('{nope', []).accepted.length === 0);
check('import: a non-list payload is rejected',
  parsePromptImport('{"hello":"world"}', []).errors.length === 1);
check('import: entries without a title or template are skipped',
  parsePromptImport(JSON.stringify([{ title: 'x' }, { template: 'y' }, { title: 'ok', template: 'z' }]), []).accepted.length === 1);

const cats = parsePromptImport(JSON.stringify([
  { title: 'a', template: 't', category: 'craft' },
  { title: 'b', template: 't', category: 'BIBLE' },
  { title: 'c', template: 't', category: 'nonsense' },
  { title: 'd', template: 't' }
]), []);
check('import: known categories are kept and normalised, unknown → user',
  cats.accepted[0].category === 'craft'
  && cats.accepted[1].category === 'bible'
  && cats.accepted[2].category === 'user'
  && cats.accepted[3].category === 'user',
  cats.accepted.map((p) => p.category).join(','));

const dupAgainstLibrary = parsePromptImport(
  JSON.stringify([{ title: '  CHAPTER critique ', template: 'again', category: 'user' }]),
  [row('1', 'Chapter critique', 'user')]
);
check('import: duplicates of existing prompts are skipped (trim + case insensitive)',
  dupAgainstLibrary.accepted.length === 0 && dupAgainstLibrary.duplicates === 1);

const dupWithin = parsePromptImport(JSON.stringify([
  { title: 'Same', template: 'one' },
  { title: 'same', template: 'two' }
]), []);
check('import: duplicates inside one file are collapsed',
  dupWithin.accepted.length === 1 && dupWithin.duplicates === 1);

check('import: same title in a different category is NOT a duplicate',
  parsePromptImport(JSON.stringify([{ title: 'Same', template: 't', category: 'craft' }]), [row('1', 'Same', 'user')]).accepted.length === 1);

check('import: key helper is stable', promptKey('  My Prompt ', 'User') === promptKey('my prompt', 'user'));

const many = Array.from({ length: PROMPT_IMPORT_MAX + 5 }, (_, i) => ({ title: 'p' + i, template: 't' }));
const capped = parsePromptImport(JSON.stringify(many), []);
check('import: the size cap is enforced and reported',
  capped.accepted.length === PROMPT_IMPORT_MAX && capped.errors.length === 1,
  `${capped.accepted.length} accepted`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL PROMPT BUNDLE TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
