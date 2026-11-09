/**
 * System-prompt tests (v1.2.3 Task 7).
 *
 * The prompt is the one artifact users never see, so it gets its own suite:
 * block order, skill gating (global + per-chat), the 12k skills budget, memory
 * gating and the rule that tools are only advertised when they are sent.
 *
 * Run: node scripts/prompt-test.mjs
 */
import { loadTs } from './lib/load-ts.mjs';

const {
  buildSystemPrompt, buildSkillsBlock, activeSkills, parseSkillsOff, parseSkillsOn, SKILLS_BLOCK_CHARS,
  parseSkillCommand, matchSkills, buildModeBlock, buildAgentBlock, CHAT_MODES
} = await loadTs('src/lib/prompt.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const skill = (id, name, extra = {}) => ({
  id, name, description: `${name} description`, content: `${name} instructions`, enabled: 1, ...extra
});

// ------------------------------------------------------------- skills gate ---
const skills = [skill('a', 'Alpha'), skill('b', 'Beta'), skill('c', 'Gamma', { enabled: 0 })];

check('skills: disabled skills never reach the prompt',
  activeSkills(skills).map((s) => s.id).join(',') === 'a,b',
  activeSkills(skills).map((s) => s.id).join(','));
check('skills: a per-chat opt-out removes the skill',
  activeSkills(skills, ['a']).map((s) => s.id).join(',') === 'b');

const block = buildSkillsBlock(skills, ['b']);
check('skills block: header + name + description + content',
  /# Active skills/.test(block) && /## Alpha/.test(block) && /Alpha description/.test(block) && /Alpha instructions/.test(block));
check('skills block: a muted skill is absent', !/Beta/.test(block));
check('skills block: no active skills → no block', buildSkillsBlock(skills, ['a', 'b']) === null);
check('skills block: empty list → null', buildSkillsBlock([]) === null);

const huge = skill('huge', 'Huge', { content: 'x'.repeat(SKILLS_BLOCK_CHARS + 500) });
const capped = buildSkillsBlock([skill('small', 'Small'), huge]);
check('skills block: an oversized skill is replaced by a truncation marker',
  /\[skill truncated: Huge/.test(capped) && !/x{1000}/.test(capped));
check('skills block: the budget is respected', capped.length <= SKILLS_BLOCK_CHARS + 200, String(capped.length));

// --------------------------------------------------------- skills_off shape ---
check('skills_off: JSON text parses', parseSkillsOff('["a","b"]').join(',') === 'a,b');
check('skills_off: an array passes through', parseSkillsOff(['c']).join(',') === 'c');
check('skills_off: garbage becomes an empty list',
  parseSkillsOff('{not json').length === 0 && parseSkillsOff(null).length === 0 && parseSkillsOff(7).length === 0);
check('skills_off: non-strings are dropped', parseSkillsOff('["a",1,null]').join(',') === 'a');
check('skills_on: JSON text parses', parseSkillsOn('["b"]').join(',') === 'b' && parseSkillsOn(null).length === 0);
check('skills: a chat-activated skill reaches the prompt while globally off',
  activeSkills([skill('x', 'X', { enabled: 0 })], [], ['x']).length === 1);
check('skills: a per-chat opt-out wins over /skill',
  activeSkills([skill('x', 'X', { enabled: 0 })], ['x'], ['x']).length === 0);
check('skills block: a chat-activated skill is included',
  /## Gamma/.test(buildSkillsBlock(skills, [], ['c'])));

// ------------------------------------------------- modes + agent protocol ---
const plan = buildSystemPrompt({ mode: 'plan' });
check('mode: plan is injected and asks for a next action',
  /# Mode: plan/.test(plan) && /Next action/.test(plan));
check('mode: write forbids a preamble',
  /# Mode: write/.test(buildSystemPrompt({ mode: 'write' })) && /no preamble/i.test(buildSystemPrompt({ mode: 'write' })));
check('mode: brainstorm asks for options',
  /# Mode: brainstorm/.test(buildSystemPrompt({ mode: 'brainstorm' })));
check('mode: no mode means no mode block', !/^# Mode:/m.test(buildSystemPrompt({})));
check('mode: agent block only when agent mode is on',
  !/# Agent mode/.test(plan) && /# Agent mode/.test(buildSystemPrompt({ mode: 'plan', agentMode: true })));
check('mode: every mode has a block',
  CHAT_MODES.every((m) => new RegExp('# Mode: ' + m).test(buildModeBlock(m))) && /# Agent mode/.test(buildAgentBlock()));
check('mode: an unknown mode falls back to write', /# Mode: write/.test(buildModeBlock('nope')));
check('agent: finishes the whole task in one run and creates the project itself',
  /create_project/.test(buildAgentBlock()) && /WHOLE task/i.test(buildAgentBlock())
  && !/continue in the next turn/i.test(buildAgentBlock()));
check('agent: the tool list advertises create_project',
  /create_project/.test(buildSystemPrompt({ agentMode: true, toolsEnabled: true })));
check('agent: web tools are advertised with the rest',
  /web_search/.test(buildSystemPrompt({ agentMode: true, toolsEnabled: true }))
  && /web_fetch/.test(buildSystemPrompt({ agentMode: true, toolsEnabled: true })));
check('agent: web research rules tell the model to cite the page',
  /web_search/.test(buildAgentBlock()) && /URL/.test(buildAgentBlock()));
check('agent: no web tools are advertised when tools are off',
  !/web_search/.test(buildSystemPrompt({ toolsEnabled: false })));

// ------------------------------------------------------- /skill commands ---
check('skill cmd: /skill/Name parses', JSON.stringify(parseSkillCommand('/skill/dialogue')) === '{"name":"dialogue"}');
check('skill cmd: /skill/all parses', JSON.stringify(parseSkillCommand('/skill/all')) === '{"all":true}');
check('skill cmd: bare /skill opens the picker instead', parseSkillCommand('/skill') === null);
check('skill cmd: ordinary text is not a command', parseSkillCommand('hello') === null && parseSkillCommand('/help') === null);
const pool = [{ id: 'skill-dialogue', name: 'Dialogue Coach' }, { id: 'skill-prose', name: 'Prose Polisher' }];
check('skill match: full name wins', matchSkills(pool, 'Dialogue Coach').length === 1);
check('skill match: a partial name finds the skill', matchSkills(pool, 'dialogue')[0]?.id === 'skill-dialogue');
check('skill match: the id works too', matchSkills(pool, 'skill-prose')[0]?.id === 'skill-prose');
check('skill match: unknown names match nothing', matchSkills(pool, 'zzz').length === 0);

// ------------------------------------------------------------------- order ---
const full = buildSystemPrompt({
  systemOverride: 'SYSTEM-ROOT',
  agentMd: 'AGENT-BODY',
  project: { id: 'p', name: 'Novel', context: 'PROJECT-CONTEXT', format: 'novel', rating: 'teen' },
  memories: ['likes tea'],
  memoryEnabled: true,
  skills: [skill('a', 'Alpha')],
  style: { id: 's', name: 'Concise', content: 'STYLE-BODY', builtin: 1 },
  goal: 'GOAL-BODY',
  toolsEnabled: true,
  attachments: [{ name: 'notes.md', kind: 'file', content: 'ATTACH-BODY' }]
});
const idx = (needle) => full.indexOf(needle);
check('order: system → agent.md → project → memory → skills → goal → style → tools → attachments',
  idx('SYSTEM-ROOT') === 0
  && idx('AGENT-BODY') > idx('SYSTEM-ROOT')
  && idx('PROJECT-CONTEXT') > idx('AGENT-BODY')
  && idx('likes tea') > idx('PROJECT-CONTEXT')
  && idx('# Active skills') > idx('likes tea')
  && idx('GOAL-BODY') > idx('# Active skills')
  && idx('STYLE-BODY') > idx('GOAL-BODY')
  && idx('# Story tools') > idx('STYLE-BODY')
  && idx('ATTACH-BODY') > idx('# Story tools'),
  String(full.length));
check('order: per-chat system override wins over the default',
  buildSystemPrompt({ systemOverride: 'OVERRIDE', defaultSystem: 'GLOBAL' }).startsWith('OVERRIDE')
  && !/GLOBAL/.test(buildSystemPrompt({ systemOverride: 'OVERRIDE', defaultSystem: 'GLOBAL' })));
check('order: the global system prompt is used when there is no override',
  buildSystemPrompt({ defaultSystem: 'GLOBAL' }).startsWith('GLOBAL'));

check('gates: memory off removes the block',
  !/# Long-term memory/.test(buildSystemPrompt({ memories: ['likes tea'], memoryEnabled: false })));
check('gates: tools off removes the tool contract',
  !/# Story tools/.test(buildSystemPrompt({ toolsEnabled: false })));
check('gates: buffer/mature ratings add a content line',
  /CONTENT RATING: mature/.test(buildSystemPrompt({ project: { id: 'p', name: 'X', rating: 'mature' } })));
check('gates: an unknown format injects nothing',
  !/# Work format/.test(buildSystemPrompt({ project: { id: 'p', name: 'X', format: 'poetry' } })));
check('gates: empty input yields an empty prompt', buildSystemPrompt({}) === '');

// ------------------------------------------------------ agent.md labelling ---
const labelled = buildSystemPrompt({ agentMd: 'AGENT-BODY' });
check('agent.md: injected under an explicit priority label',
  /^# Agent instructions \(highest priority after the system prompt\)\nAGENT-BODY$/.test(labelled), labelled.slice(0, 80));
check('agent.md: whitespace-only text injects nothing',
  !/Agent instructions/.test(buildSystemPrompt({ agentMd: '   \n\t ' })));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL PROMPT TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
