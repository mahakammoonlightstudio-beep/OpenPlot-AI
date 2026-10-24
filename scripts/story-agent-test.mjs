/**
 * Plot Smith (story agent) engine tests — prompts, JSON recovery, plan
 * normalization and the plan → project conversion. Pure library, no DB.
 * Run: node scripts/story-agent-test.mjs
 */
import { loadTs } from './lib/load-ts.mjs';

const A = await loadTs('src/lib/storyAgent.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const brief = {
  ...A.DEFAULT_BRIEF,
  idea: 'A city where memories are currency',
  genres: ['fantasy', 'mystery'],
  tone: 'dark',
  audience: 'mature',
  format: 'novel',
  pov: 'first-person',
  length: 'novella',
  language: 'id',
  notes: 'No chosen-one trope'
};

// ---------- options ----------
check('optionLabel EN + ID', A.optionLabel(A.GENRES, 'fantasy', 'en') === 'Fantasy' && A.optionLabel(A.GENRES, 'fantasy', 'id') === 'Fantasi');
check('briefSummary includes choices', /Fantasi/.test(A.briefSummary(brief, 'id')) && /first person/i.test(A.briefSummary(brief, 'en')));
check('length words map exists for every length', A.LENGTHS.every((l) => (A.LENGTH_WORDS[l.id] || 0) > 0));

// ---------- prompts ----------
const p1 = A.premisePrompt(brief);
check('premise prompt asks for strict JSON shape', /STRICT JSON/.test(p1.system) && /"options"/.test(p1.user));
check('premise prompt carries brief + rating + language', /memories are currency/.test(p1.user) && /MATURE/.test(p1.user) && /Bahasa Indonesia/.test(p1.user));
check('premise prompt is creative-brief shaped, not chatty', /3 genuinely DIFFERENT/.test(p1.user));

const premise = { title: 'The Ledger', logline: 'A memory broker buys her own past.', hook: 'She finds a debt she cannot pay.', stakes: 'Losing her identity.', themes: ['memory', 'class'], openingImage: 'A rain-soaked ledger.' };
const cast = {
  world: { name: 'Veyra', premise: 'Memory is money.', rules: 'Memories can be withdrawn only once.', conflict: 'The Ledger vs the city.' },
  characters: [{ name: 'Sera', role: 'protagonist', age: '31', want: 'Her past', flaw: 'Cannot trust', secret: 'She sold it', description: 'Broker.' }],
  locations: [{ name: 'The Vault', description: 'Cold halls.', significance: 'Finale' }],
  lore: [{ title: 'The First Ledger', content: 'Signed in blood.', relevance: 'Sets the rules' }]
};
const outline = {
  acts: [
    { act: 1, title: 'Debt', summary: 'Setup', beats: [{ title: 'Sale', summary: 'She buys a memory.' }, { title: 'Discovery', summary: 'It is hers.' }] },
    { act: 2, title: 'Chase', summary: 'Middle', beats: [{ title: 'Betrayal', summary: 'Ally flips.' }] },
    { act: 3, title: 'Ledger', summary: 'End', beats: [{ title: 'Burn', summary: 'She burns the vault.' }] }
  ],
  chapters: [
    { title: 'The Sale', summary: 'Open on the ledger.', act: 1 },
    { title: 'A Familiar Debt', summary: 'The twist lands.', act: 2 },
    { title: 'Balance Due', summary: 'Resolve the cost.', act: 3 }
  ],
  themes: ['memory', 'class']
};

const p2 = A.castPrompt(brief, premise);
check('cast prompt reuses the chosen premise', /The Ledger/.test(p2.user) && /Veyra|world/i.test(p2.user));
const p3 = A.outlinePrompt({ ...brief, length: 'short' }, premise, cast);
check('outline prompt scales chapter target to length', /4 chapters/.test(p3.user), p3.user.match(/\d+ chapters/)?.[0]);
check('outline prompt names the cast', /Sera/.test(p3.user));

// ---------- JSON recovery ----------
const messy = 'Sure! Here is the plan:\n```json\n{"options":[{"title":"A","logline":"B",},],}\n```\nHope this helps.';
const recovered = A.parseAgentJson(messy);
check('extracts JSON from prose + fences + trailing commas', recovered?.options?.[0]?.title === 'A', JSON.stringify(recovered));
check('curly quotes around keys are repaired', A.parseAgentJson('{"a":1, “b”:2}')?.b === 2);
check('garbage returns null', A.parseAgentJson('no json here') === null && A.parseAgentJson('') === null);
check('array payload parses', Array.isArray(A.parseAgentJson('[{"title":"x"}]')));

// ---------- normalization ----------
const premises = A.normalizePremises({ options: [{ title: 'One', logline: 'L', themes: ['a', 'b'] }, { title: '', logline: 'skip' }] });
check('normalizePremises drops entries without title/logline', premises.length === 1 && premises[0].themes.length === 2);
const ncast = A.normalizeCast({
  world: { name: 'Veyra', premise: 'P', rules: 'R', conflict: 'C' },
  characters: [{ name: 'Sera', role: 'protagonist', want: 'W', flaw: 'F', secret: 'S', description: 'D' }, { role: 'no-name' }],
  locations: [{ name: 'Vault', description: 'Cold' }],
  lore: [{ title: 'Ledger', content: 'Rules' }]
});
check('normalizeCast keeps valid rows and drops nameless ones', ncast.characters.length === 1 && ncast.characters[0].name === 'Sera');
check('normalizeCast returns null when nothing usable', A.normalizeCast({ characters: [] }) === null);
const noutline = A.normalizeOutline(outline);
check('normalizeOutline keeps 3 acts + chapters + themes', noutline.acts.length === 3 && noutline.chapters.length === 3 && noutline.themes.length === 2);
check('normalizeOutline returns null when empty', A.normalizeOutline({}) === null);

const state = A.normalizePlanState({ premise, cast, outline });
check('plan state round-trips a single premise', state.premise?.title === 'The Ledger');
check('plan state round-trips cast + outline', state.cast.characters.length === 1 && state.outline.chapters.length === 3);
check('hasPremise guard', A.hasPremise(state) && !A.hasPremise(A.EMPTY_PLAN));

// ---------- project seed ----------
const seed = A.buildProjectSeed(brief, premise, cast, outline);
check('seed project uses premise title + rating + format', seed.project.name === 'The Ledger' && seed.project.rating === 'mature' && seed.project.format === 'novel');
check('seed name override is honoured', A.buildProjectSeed(brief, premise, cast, outline, { name: 'Custom' }).project.name === 'Custom');
check('seed context carries the brief + target length', /memories are currency/i.test(seed.project.context) && seed.project.context.includes('~30,000 words') && /Central conflict/.test(seed.project.context));
check('seed creates world + character + location + lore entries', seed.entries.map((e) => e.kind).sort().join(',') === 'character,location,lore,world', seed.entries.map((e) => e.kind).join(','));
check('character entry includes want/flaw/secret', /## Want/.test(seed.entries.find((e) => e.kind === 'character').content) && /## Secret/.test(seed.entries.find((e) => e.kind === 'character').content));
check('seed creates one chapter per outline chapter', seed.chapters.length === 3 && seed.chapters[0].title === 'The Sale');
check('chapter keeps its outline as a quotable note', seed.chapters[0].content.startsWith('> **Outline**'));
check('seed creates one beat per outline beat', seed.beats.length === 4 && seed.beats[0].act === 1 && seed.beats[3].act === 3);
check('include flags can skip bible + chapters', A.buildProjectSeed(brief, premise, cast, outline, { includeBible: false, includeChapters: false }).entries.length === 0 && A.buildProjectSeed(brief, premise, cast, outline, { includeChapters: false }).chapters.length === 0);
check('seed without cast/outline still returns a project', A.buildProjectSeed(brief, premise, null, null).project.name === 'The Ledger');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL STORY AGENT TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
