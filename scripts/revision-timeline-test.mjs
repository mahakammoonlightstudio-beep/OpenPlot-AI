/**
 * Revision Timeline — unified chapter snapshots + displaced edits.
 *
 * Exercises the real dist-electron/db.js against a temp sql.js database:
 * listing shape, on-demand text fetch, project/chapter scoping, atomic
 * snapshot restore, dump restore (splice + conflict), and deletion behaviour.
 * Run: node scripts/revision-timeline-test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initDb, closeDb, handleDb } = require('../dist-electron/db.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const dbCall = (op, payload) => handleDb(op, payload);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-revision-'));
await initDb(tmp, 'revision-test.db');

try {
  // ---------- fixtures ----------
  const projA = dbCall('createProject', { name: 'Alpha' });
  const projB = dbCall('createProject', { name: 'Beta' });
  const chA = dbCall('createChapter', { projectId: projA.id, title: 'Storm', content: 'one two three' });
  const chB = dbCall('createChapter', { projectId: projB.id, title: 'Quiet', content: 'beta text' });

  const v1 = dbCall('createChapterVersion', { chapterId: chA.id, title: chA.title, content: 'draft one', source: 'manual' });
  const v2 = dbCall('createChapterVersion', { chapterId: chA.id, title: chA.title, content: 'one two three', source: 'manual' });

  // ---------- listing ----------
  const list = dbCall('listRevisionTimeline', { projectId: projA.id });
  check('timeline lists both snapshots', Array.isArray(list) && list.length === 2, `${list.length} entries`);
  check('entries are version kind', list.every((e) => e.kind === 'version'));
  check('listing carries metadata only', list.every((e) => !('before' in e) && !('content' in e)));
  check('chapter title is joined in', list.every((e) => e.chapterTitle === 'Storm'));
  check('newest entry comes first', list[0].at >= list[1].at);
  const v1Meta = list.find((e) => e.rowId === v1.id);
  const v2Meta = list.find((e) => e.rowId === v2.id);
  check('snapshot before/after words are real', v1Meta.words === 2 && v1Meta.afterWords === 3,
    `${v1Meta.words} → ${v1Meta.afterWords}`);
  check('newest snapshot diffs against current text', v2Meta.afterWords === 3, String(v2Meta.afterWords));
  check('preview is a short snippet, not the text', v1Meta.preview === 'draft one' && v1Meta.preview.length < 240);

  // ---------- on-demand text ----------
  const d1 = dbCall('getRevisionEntry', { kind: 'version', id: v1.id });
  check('version detail returns before/after', d1.ok === true && d1.before === 'draft one' && d1.after === 'one two three',
    `${JSON.stringify(d1.before)} → ${JSON.stringify(d1.after)}`);
  const d2 = dbCall('getRevisionEntry', { kind: 'version', id: v2.id });
  check('newest detail falls back to the chapter text', d2.after === 'one two three');
  check('missing entry reports cleanly', dbCall('getRevisionEntry', { kind: 'version', id: 'nope' }).ok === false);

  // ---------- scoping ----------
  check('project scope excludes other manuscripts',
    dbCall('listRevisionTimeline', { projectId: projB.id }).length === 0);
  check('chapter scope excludes other chapters',
    dbCall('listRevisionTimeline', { chapterId: chB.id }).length === 0);
  dbCall('createChapterVersion', { chapterId: chB.id, title: chB.title, content: 'beta old', source: 'manual' });
  check('chapter scope finds its own history',
    dbCall('listRevisionTimeline', { chapterId: chB.id }).length === 1);
  check('limit is honoured', dbCall('listRevisionTimeline', { projectId: projA.id, limit: 1 }).length === 1);

  // ---------- atomic snapshot restore ----------
  const restored = dbCall('restoreChapterVersion', { id: v1.id });
  check('restore writes the snapshot text', restored.ok === true && restored.content === 'draft one');
  const chAfter = dbCall('listChapters', { projectId: projA.id }).find((c) => c.id === chA.id);
  check('restored text persisted', chAfter.content === 'draft one');
  const afterRestore = dbCall('listRevisionTimeline', { projectId: projA.id });
  const safety = afterRestore.find((e) => e.source === 'restore');
  check('restore snapshots the text it replaced', !!safety && safety.kind === 'version');
  const safetyDetail = dbCall('getRevisionEntry', { kind: 'version', id: safety.rowId });
  check('safety snapshot holds the pre-restore prose',
    safetyDetail.before === 'one two three' && safetyDetail.after === 'draft one',
    `${JSON.stringify(safetyDetail.before)} → ${JSON.stringify(safetyDetail.after)}`);
  check('restoring a missing snapshot fails cleanly',
    dbCall('restoreChapterVersion', { id: 'nope' }).ok === false);

  // ---------- displaced passage: list + detail ----------
  const chC = dbCall('createChapter', { projectId: projA.id, title: 'Bridge', content: 'abc123def' });
  const dump = dbCall('addTextDump', {
    projectId: projA.id, chapterId: chC.id, chapterTitle: chC.title,
    source: 'writing', action: 'replace', scope: 'passage',
    original: 'XYZ', replacement: '123', startOffset: 3, endOffset: 6
  });
  const withDump = dbCall('listRevisionTimeline', { projectId: projA.id });
  const dumpMeta = withDump.find((e) => e.rowId === dump.id);
  check('displaced passage appears as an edit', !!dumpMeta && dumpMeta.kind === 'edit' && dumpMeta.scope === 'passage');
  check('edit shows its chapter and action', dumpMeta.chapterTitle === 'Bridge' && dumpMeta.action === 'replace');
  const dumpDetail = dbCall('getRevisionEntry', { kind: 'edit', id: dump.id });
  check('edit detail returns displaced and replacing text',
    dumpDetail.ok === true && dumpDetail.before === 'XYZ' && dumpDetail.after === '123');
  check('edit detail keeps offsets for a passage', dumpDetail.startOffset === 3 && dumpDetail.endOffset === 6);

  // ---------- passage restore ----------
  const dumpRestore = dbCall('restoreTextDump', { id: dump.id });
  check('passage restore splices the old text back', dumpRestore.ok === true);
  const chCNow = dbCall('listChapters', { projectId: projA.id }).find((c) => c.id === chC.id);
  check('spliced chapter is intact', chCNow.content === 'abcXYZdef', chCNow.content);
  const dumpMetaAfter = dbCall('listRevisionTimeline', { projectId: projA.id }).find((e) => e.rowId === dump.id);
  check('restored edit is marked as restored', dumpMetaAfter.restoredAt != null);
  check('restore also snapshots the chapter', dbCall('listRevisionTimeline', { projectId: projA.id })
    .some((e) => e.kind === 'version' && e.chapterId === chC.id && e.source === 'restore'));

  // ---------- conflict path ----------
  const chD = dbCall('createChapter', { projectId: projA.id, title: 'Conflict', content: 'newer prose' });
  const conflictDump = dbCall('addTextDump', {
    projectId: projA.id, chapterId: chD.id, chapterTitle: chD.title,
    source: 'manual', action: 'replace', scope: 'passage',
    original: 'old prose', replacement: '123', startOffset: 0, endOffset: 3
  });
  const conflicted = dbCall('restoreTextDump', { id: conflictDump.id });
  check('newer prose blocks a blind restore', conflicted.ok === false && conflicted.error === 'conflict');
  const forced = dbCall('restoreTextDump', { id: conflictDump.id, force: true });
  check('force restore is explicit and works', forced.ok === true);
  const chDNow = dbCall('listChapters', { projectId: projA.id }).find((c) => c.id === chD.id);
  check('forced restore wrote the old text', chDNow.content === 'old prose');

  // ---------- deleted chapter ----------
  const chE = dbCall('createChapter', { projectId: projA.id, title: 'Gone', content: 'will vanish' });
  const orphanDump = dbCall('addTextDump', {
    projectId: projA.id, chapterId: chE.id, chapterTitle: chE.title,
    source: 'agent', action: 'delete', scope: 'chapter',
    original: 'will vanish', replacement: ''
  });
  dbCall('deleteChapter', { id: chE.id });
  const afterDelete = dbCall('listRevisionTimeline', { projectId: projA.id });
  const orphan = afterDelete.find((e) => e.rowId === orphanDump.id);
  check('displaced text survives its chapter', !!orphan && orphan.chapterTitle === 'Gone');
  check('deleted chapter snapshots are gone', !afterDelete.some((e) => e.kind === 'version' && e.chapterId === chE.id));
  check('orphan restore refuses a missing chapter',
    dbCall('restoreTextDump', { id: orphanDump.id }).error === 'missing-chapter');

  // ---------- snapshot deletion ----------
  const beforeDelete = dbCall('listRevisionTimeline', { chapterId: chA.id }).length;
  dbCall('deleteChapterVersion', { id: v2.id });
  check('deleting a snapshot removes one timeline row',
    dbCall('listRevisionTimeline', { chapterId: chA.id }).length === beforeDelete - 1);
} finally {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
