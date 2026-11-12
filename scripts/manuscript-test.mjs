/**
 * Manuscript check (headless, pure).
 *
 * Locks the revision heuristics: word/sentence counts, dialogue share, filter
 * words, repeated openings, overuse thresholds, long sentences and per-chapter
 * rows. The module must stay deterministic and must never throw on an empty
 * draft.
 *
 * Run: node scripts/manuscript-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const PROJ = path.resolve(import.meta.dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-manuscript-'));
const outfile = path.join(outDir, 'manuscript.cjs');

await build({
  entryPoints: [path.join(PROJ, 'src', 'lib', 'manuscript.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile,
  logLevel: 'silent'
});

const { analyzeManuscript } = require(outfile);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const prose = [
  'The rain had stopped before dawn. She felt the cold through her coat. She saw the light move across the floor.',
  'She looked at the door and waited. He said nothing, so she felt the silence grow.',
  '"We should go," he said. "The road will be worse by noon."',
  'She saw the same street again. She felt the same doubt again. She looked back once more.'
].join('\n\n');

const one = analyzeManuscript([{ id: 'c1', title: 'Storm', content: prose }]);

check('counts words and sentences', one.words > 40 && one.sentences >= 8, JSON.stringify({ words: one.words, sentences: one.sentences }));
check('computes a reading time', one.readingMinutes >= 1 && one.readingMinutes <= 2, String(one.readingMinutes));
check('measures dialogue share from quoted spans', one.dialogueShare > 0 && one.dialogueShare < 60, String(one.dialogueShare));
check('detects filter words with counts', one.filterWords.some((w) => w.word === 'felt' && w.count === 3), JSON.stringify(one.filterWords));
check('filter words carry a per-1000 rate', one.filterWords.every((w) => w.per1000 >= 0), JSON.stringify(one.filterWords.slice(0, 2)));
check('finds repeated sentence openings', one.openings.some((o) => o.word === 'she' && o.count >= 4), JSON.stringify(one.openings));
check('sentence openings need at least three repeats', one.openings.every((o) => o.count >= 3), JSON.stringify(one.openings));
check('per-chapter row mirrors the chapter', one.chapters.length === 1
  && one.chapters[0].title === 'Storm' && one.chapters[0].words === one.words, JSON.stringify(one.chapters));

// A 40-word sentence must be reported, with its chapter and a snippet.
const longSentence = Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ') + '.';
const long = analyzeManuscript([{ id: 'c2', title: 'Long', content: longSentence }]);
check('flags long sentences with chapter and snippet', long.longSentenceCount === 1
  && long.longSentences[0]?.chapter === 'Long' && long.longSentences[0].words === 40,
  JSON.stringify(long.longSentences[0]));

// Overuse ignores glue words and needs both an absolute and a relative floor.
const repeated = ('the lantern ' + 'the ').repeat(20) + 'lantern.';
const over = analyzeManuscript([{ title: 'Lantern', content: repeated }]);
check('overuse ignores stopwords and reports the repeated noun',
  over.overused.some((w) => w.word === 'lantern') && !over.overused.some((w) => w.word === 'the'),
  JSON.stringify(over.overused));

// A short draft mentioning a word twice is not overuse.
const shortDraft = analyzeManuscript([{ title: 'Short', content: 'A lantern. The lantern died.' }]);
check('short drafts do not trigger overuse', shortDraft.overused.length === 0, JSON.stringify(shortDraft.overused));

// Indonesian filter words are covered without a language setting.
const indonesian = analyzeManuscript([{ title: 'Hujan', content: 'Dia merasa dingin. Dia melihat pintu. Dia menyadari sesuatu. Dia merasa lelah.' }]);
check('detects Indonesian filter words', indonesian.filterWords.some((w) => w.word === 'merasa' && w.count === 2),
  JSON.stringify(indonesian.filterWords.slice(0, 3)));

// -ly adverbs need a repeat before they are worth flagging, and the non-adverb
// exceptions are left alone.
const adverbs = analyzeManuscript([{ title: 'Adverbs', content: 'She walked slowly. He spoke softly. They moved slowly. She waited slowly. The lovely room was really cold.' }]);
check('counts repeated -ly adverbs and skips exceptions',
  adverbs.adverbs.some((w) => w.word === 'slowly' && w.count === 3)
  && !adverbs.adverbs.some((w) => w.word === 'softly' || w.word === 'lovely' || w.word === 'really'),
  JSON.stringify(adverbs.adverbs));

check('empty draft returns zeros instead of throwing', (() => {
  const empty = analyzeManuscript([]);
  return empty.words === 0 && empty.sentences === 0 && empty.chapters.length === 0
    && empty.dialogueShare === 0 && empty.filterWords.length === 0 && empty.readingMinutes === 1;
})());

const multi = analyzeManuscript([
  { id: 'a', title: 'One', content: 'She ran. She hid.' },
  { id: 'b', title: 'Two', content: 'He waited. He slept.' }
]);
check('keeps chapters separate and in order', multi.chapters.map((c) => c.id).join(',') === 'a,b'
  && multi.chapters[1].words === 4, JSON.stringify(multi.chapters));

fs.rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? 'ALL MANUSCRIPT TESTS PASSED (' + results.length + ')' : failed + ' CHECK(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
