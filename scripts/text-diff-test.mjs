/**
 * Word-diff tests (headless). The Writing preview relies on this being both
 * correct and bounded, so the suite checks the three edit shapes and the
 * prefix/suffix fallback used for very large passages.
 */
import { loadTs } from './lib/load-ts.mjs';

const { diffWords, diffCounts } = await loadTs('src/lib/textDiff.ts');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; console.error('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};

const text = (parts) => parts.map((p) => p.text).join('');
const added = (parts) => parts.filter((p) => p.kind === 'add').map((p) => p.text).join('');
const removed = (parts) => parts.filter((p) => p.kind === 'del').map((p) => p.text).join('');

const before = 'The harbor sleeps under a quilt of fog.';
const after = 'The harbour sleeps beneath a blanket of fog.';
const d = diffWords(before, after);
check('round-trips the old text', text(d.filter((p) => p.kind !== 'add')) === before);
check('round-trips the new text', text(d.filter((p) => p.kind !== 'del')) === after);
check('marks the changed words', added(d).includes('beneath') && removed(d).includes('under'), `+${added(d)} / -${removed(d)}`);
check('keeps unchanged words', d.some((p) => p.kind === 'same' && p.text.includes('sleeps')));

const insertion = diffWords('One two three.', 'One two bright three.');
check('detects a pure insertion', added(insertion).includes('bright') && removed(insertion) === '');

const deletion = diffWords('One two bright three.', 'One two three.');
check('detects a pure deletion', removed(deletion).includes('bright') && added(deletion) === '');
check('identical text is one same part', diffWords('Same.', 'Same.').length === 1);

const blank = diffWords('', 'New prose.');
check('empty before is all added', blank.length === 1 && blank[0].kind === 'add');
const cleared = diffWords('Old prose.', '');
check('empty after is all deleted', cleared.length === 1 && cleared[0].kind === 'del');

const longA = Array.from({ length: 1400 }, (_, i) => 'word' + i).join(' ');
const longB = longA.replace('word700', 'changed700');
const big = diffWords(longA, longB);
check('large passages fall back without losing text', text(big.filter((p) => p.kind !== 'add')) === longA);
check('large fallback still shows the edit', added(big).includes('changed700') && removed(big).includes('word700'));

const counts = diffCounts(d);
check('counts add/remove words', counts.added === 3 && counts.removed === 3, `${counts.added}/${counts.removed}`);

console.log(`\n${fail === 0 ? `ALL DIFF TESTS PASSED (${pass})` : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
