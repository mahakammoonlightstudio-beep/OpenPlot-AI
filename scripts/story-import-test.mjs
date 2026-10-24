/**
 * Story-bible import parser tests (pure library, no DB / no GUI).
 * Run: node scripts/story-import-test.mjs
 */
import { loadTs } from './lib/load-ts.mjs';

const {
  parseStoryFile, parseStoryFiles, parseMarkdownSections, parseCsvRows,
  parseCsvEntries, parseJsonEntries, normalizeKind, guessKindFromName, formatBytes
} = await loadTs('src/lib/storyImport.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ---------- kind + filename inference ----------
check('normalizeKind plural + Indonesian aliases', normalizeKind('Characters') === 'character' && normalizeKind('Lokasi') === 'location' && normalizeKind('legend') === 'lore');
check('normalizeKind rejects junk', normalizeKind('banana') === null);
check('guessKindFromName characters_sheet.md', guessKindFromName('characters_sheet.md') === 'character');
check('formatBytes', formatBytes(1536) === '1.5 KB' && formatBytes(2048 * 1024) === '2.00 MB');

// ---------- markdown ----------
const md = `Preamble notes for the whole file.\n\n# Kael Ardent\nA reluctant duelist.\n\n## Wants\nTo leave the city.\n\n# Mira Vale\nA smuggler with a conscience.\n\n\`\`\`\n# not a heading\n\`\`\`\n`;
const sections = parseMarkdownSections(md, 'Notes');
check('markdown splits headings and keeps preamble', sections.length === 3 && sections[0].title === 'Notes', JSON.stringify(sections.map((s) => s.title)));
check('markdown ignores # inside code fences', sections.some((s) => s.content.includes('# not a heading')));
const mdImport = parseStoryFile({ name: 'characters.md', content: md }, 'character');
check('parseStoryFile infers kind from filename', mdImport.entries.every((e) => e.kind === 'character'), JSON.stringify(mdImport.entries.map((e) => e.kind)));
check('parseStoryFile keeps entries non-empty', mdImport.entries.length === 3 && mdImport.entries.every((e) => e.content.length > 0));

const plain = parseStoryFile({ name: 'lore-notes.txt', content: 'The Ninth Fleet vanished without a trace.' }, 'lore');
check('plain text becomes one entry', plain.entries.length === 1 && plain.entries[0].title === 'lore notes');
check('plain text falls back to the chosen kind', plain.entries[0].kind === 'lore');

const headingKinds = parseStoryFile({ name: 'mixed.md', content: '# Characters\nKael\n\n# Locations\nHarbor' }, 'lore');
check('heading that names a category overrides kind', headingKinds.entries[0].kind === 'character' && headingKinds.entries[1].kind === 'location');

// ---------- csv ----------
const csv = 'name,description,type,tags\n"Kael, the Duelist","Reluctant, but deadly","character","lead;rebel"\nMira,"Smuggler with a conscience",character,ally\n';
const rows = parseCsvRows(csv);
check('csv parser respects quoted commas', rows.length === 3 && rows[1][0] === 'Kael, the Duelist', JSON.stringify(rows[1]));
const csvEntries = parseCsvEntries(csv, 'lore', 'Import');
check('csv header aliases map title/content/kind/tags', csvEntries.length === 2 && csvEntries[0].title === 'Kael, the Duelist' && csvEntries[0].kind === 'character' && csvEntries[0].tags.includes('lead'), JSON.stringify(csvEntries[0]));
check('csv keeps second row', csvEntries[1].title === 'Mira' && csvEntries[1].content === 'Smuggler with a conscience');

const semi = 'judul;isi;kategori\nMenara;Menara tua di utara;lokasi\n';
const semiEntries = parseCsvEntries(semi, 'lore', 'Import');
check('csv detects semicolon delimiter + Indonesian headers', semiEntries.length === 1 && semiEntries[0].kind === 'location' && semiEntries[0].content === 'Menara tua di utara');

const headerless = parseCsvEntries('Harbor,A busy port\nForest,A quiet wood\n', 'lore', 'Import');
check('csv without header uses first two columns', headerless.length === 2 && headerless[0].title === 'Harbor' && headerless[0].content === 'A busy port');

// ---------- json ----------
const jarr = JSON.stringify([
  { title: 'Kael', content: 'Duelist', kind: 'character', tags: ['lead'] },
  { name: 'Harbor', description: 'A port', type: 'location' }
]);
const jEntries = parseJsonEntries(jarr, 'lore', 'Import');
check('json array of objects', jEntries.length === 2 && jEntries[0].kind === 'character' && jEntries[1].kind === 'location');

const keyed = JSON.stringify({
  characters: [{ name: 'Kael', description: 'Duelist', want: 'To leave' }],
  lore: [{ title: 'The Fall', content: 'A city sank.' }]
});
const keyedEntries = parseJsonEntries(keyed, 'lore', 'Import');
check('json category-keyed containers infer kinds', keyedEntries.length === 2 && keyedEntries[0].kind === 'character' && keyedEntries[1].kind === 'lore');
check('json character object folds extra fields into content', keyedEntries[0].content.includes('want'));

const wrapped = JSON.stringify({ entries: [{ title: 'One', content: 'Body' }] });
check('json wrapper { entries: [] }', parseJsonEntries(wrapped, 'world', 'Import').length === 1);
check('invalid json returns nothing (no throw)', parseJsonEntries('{oops', 'lore', 'Import').length === 0);

// ---------- batch ----------
const batch = parseStoryFiles([
  { name: 'characters.md', content: '# Kael\nDuelist\n# Mira\nSmuggler' },
  { name: 'characters2.md', content: '# Kael\nDuplicate\n# Thorn\nSpy' }
], 'character');
check('batch de-duplicates titles across files', batch.entries.length === 3, JSON.stringify(batch.entries.map((e) => e.title)));
check('batch reports the duplicate as a warning', batch.warnings.some((w) => /duplicate/i.test(w)));

const unsupported = parseStoryFile({ name: 'sheet.xlsx', content: 'xx' }, 'lore');
check('unsupported extension warns instead of importing garbage', unsupported.entries.length === 0 && unsupported.warnings.length === 1);
check('empty file warns', parseStoryFile({ name: 'empty.md', content: '   ' }, 'lore').warnings.length === 1);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL IMPORT TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
