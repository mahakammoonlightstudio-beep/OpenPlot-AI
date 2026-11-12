/** Skill Lab: exact block, token estimate, budget and overlap/tension checks. */
import { loadTs } from './lib/load-ts.mjs';

const { buildSkillLab, skillBlockBody } = await loadTs('src/lib/skillLab.ts');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const skill = (id, name, content, category = 'writing', enabled = 0, description = '') => ({
  id, name, content, category, enabled, description, builtin: 0
});

const beta = skill('beta', 'Beta Reader', 'Do not rewrite unless asked. Quote the exact lines that confused you.', 'chat');
const line = skill('line', 'Line Editor', 'Do a line edit, not a rewrite: fix grammar and repeated words. Preserve the voice.', 'writing');
const duplicate = skill('dup', 'Beta Copy', beta.content, 'chat');
const voiceA = skill('voice-a', 'Voice A', 'Track point of view, tense and register. Match sentence rhythm, vocabulary and interiority.', 'writing');
const voiceB = skill('voice-b', 'Voice B', 'Keep point of view, tense and register consistent. Match sentence rhythm, vocabulary and interiority across chapters.', 'writing');

const body = skillBlockBody({ ...beta, description: 'Reads as a first reader.' });
check('block uses the real heading/description/content shape', body === `## Beta Reader\nReads as a first reader.\n${beta.content}`);

const bare = skillBlockBody({ ...beta, description: '' });
check('no description adds no blank paragraph', bare === `## Beta Reader\n${beta.content}`);

const lab = buildSkillLab(beta, [beta, line], { skillsOn: [beta.id, line.id] });
check('selected block is exact', lab.body === skillBlockBody(beta));
check('token estimate follows the 4-char rule', lab.tokens === Math.ceil(lab.body.length / 4), `${lab.tokens} tokens`);
check('active count includes both', lab.activeCount === 2);
check('tension is detected', lab.issues.some((i) => i.kind === 'tension' && i.topic === 'rewrite' && i.id === line.id));
check('active set reports the real block size', lab.activeChars > lab.chars);

const dup = buildSkillLab(beta, [beta, duplicate], { skillsOn: [beta.id, duplicate.id] });
check('duplicate instruction is detected', dup.issues.some((i) => i.kind === 'duplicate' && i.id === duplicate.id));

const overlap = buildSkillLab(voiceA, [voiceA, voiceB], { skillsOn: [voiceA.id, voiceB.id] });
const overlapIssue = overlap.issues.find((i) => i.kind === 'overlap' && i.id === voiceB.id);
check('shared focus is detected', !!overlapIssue && overlapIssue.shared.length >= 5, overlapIssue?.shared.join(', '));

const quiet = buildSkillLab(beta, [beta], { skillsOn: [beta.id] });
check('a lone skill has nothing to review', quiet.issues.length === 0 && !quiet.truncated);

const muted = buildSkillLab(beta, [beta, line], { skillsOn: [beta.id, line.id], skillsOff: [line.id] });
check('a muted skill is not in the active set or issues', muted.activeCount === 1 && !muted.issues.some((i) => i.id === line.id));

const huge = [0, 1, 2].map((n) => skill(`huge-${n}`, `Huge ${n}`, 'word '.repeat(2000)));
const over = buildSkillLab(huge[0], huge, { skillsOn: huge.map((s) => s.id) });
check('over-budget active set is marked truncated', over.truncated);

const off = buildSkillLab(beta, [beta, line], {});
check('disabled skills are not active without skillsOn', off.activeCount === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
