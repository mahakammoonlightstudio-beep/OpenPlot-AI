/**
 * Library Time Machine — snapshot naming, isolation, retention and path safety.
 * Runs against dist-electron/snapshots.js (no Electron, no display).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SNAPSHOT_MAX,
  writeSnapshotFile,
  copySnapshotFile,
  listSnapshotFiles,
  snapshotFilePath,
  snapshotDirectory
} = require('../dist-electron/snapshots.js');

let pass = 0;
let fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
};
const throws = (name, fn) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-snap-'));
try {
  check('starts empty', listSnapshotFiles(root, 'alpha.db').length === 0);
  check('snapshot folder is profile-local', snapshotDirectory(root, 'alpha.db').startsWith(path.join(root, 'snapshots')));

  const first = writeSnapshotFile(root, 'alpha.db', Buffer.from('alpha-one'), 'manual');
  const firstFile = path.join(snapshotDirectory(root, 'alpha.db'), first.name);
  check('writes a timestamped .db', /^snap-\d{10,}-manual\.db$/.test(first.name));
  check('returns the copied size', first.bytes === Buffer.byteLength('alpha-one'));
  check('file exists on disk', fs.existsSync(firstFile));

  const listed = listSnapshotFiles(root, 'alpha.db');
  check('lists the snapshot', listed.length === 1 && listed[0].name === first.name);
  check('reads the reason from the name', listed[0].reason === 'manual');
  check('newest first', listed[0].savedAt >= first.savedAt);

  const other = writeSnapshotFile(root, 'beta.db', Buffer.from('beta'), 'daily');
  check('libraries have separate folders', !listSnapshotFiles(root, 'alpha.db').some((s) => s.name === other.name));
  check('other library sees only its own', listSnapshotFiles(root, 'beta.db').length === 1);

  const source = path.join(root, 'source.db');
  fs.writeFileSync(source, Buffer.from('copied-bytes'));
  const copied = copySnapshotFile(root, 'alpha.db', source, 'pre-import');
  check('copies a file without changing it', fs.readFileSync(path.join(snapshotDirectory(root, 'alpha.db'), copied.name), 'utf8') === 'copied-bytes');
  throws('missing source is refused', () => copySnapshotFile(root, 'alpha.db', path.join(root, 'nope.db'), 'manual'));

  for (let i = 0; i < SNAPSHOT_MAX + 3; i++) {
    writeSnapshotFile(root, 'alpha.db', Buffer.from(`retention-${i}`), 'daily');
  }
  const kept = listSnapshotFiles(root, 'alpha.db');
  const keptText = kept.map((s) => fs.readFileSync(path.join(snapshotDirectory(root, 'alpha.db'), s.name), 'utf8'));
  check(`retention keeps ${SNAPSHOT_MAX}`, kept.length === SNAPSHOT_MAX);
  check('retention keeps the newest', keptText.includes(`retention-${SNAPSHOT_MAX + 2}`));
  check('retention evicts the oldest', !keptText.includes('retention-0'));

  throws('path traversal is refused', () => snapshotFilePath(root, 'alpha.db', '../escape.db'));
  throws('a non-snapshot name is refused', () => snapshotFilePath(root, 'alpha.db', 'book.db'));
  const valid = snapshotFilePath(root, 'alpha.db', kept[0].name);
  check('a listed name resolves inside the folder', path.dirname(valid) === snapshotDirectory(root, 'alpha.db'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
}
