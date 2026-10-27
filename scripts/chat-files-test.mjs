/**
 * Chat attachment tests (v1.2.3) — files that live with a sent message.
 *
 * Drives the compiled `dist-electron/db.js` against a temp database:
 *   - addMessage writes the turn AND its files atomically, returning metadata
 *   - getMessages returns metadata only (never the bodies)
 *   - readMessageFile returns the body on demand; missing rows are readable
 *   - limits: 8 files / 256 KB each / 1 MB total / binary content
 *   - a rejected attachment writes nothing (no half-saved user turn)
 *   - deleting the message/chat removes the rows; clearChatFiles wipes them
 *
 * Run: node scripts/chat-files-test.mjs   (requires `npm run build:electron`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  initDb, closeDb, handleDb,
  MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES, MAX_CHAT_TOTAL_BYTES
} = require('../dist-electron/db.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};
const throws = (fn, pattern) => {
  try {
    fn();
    return { ok: false, error: 'did not throw' };
  } catch (err) {
    const message = String(err?.message || err);
    return { ok: pattern.test(message), error: message };
  }
};

const db = (op, payload = {}) => handleDb(op, payload);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-chatfiles-'));
await initDb(tmpRoot, 'files.db');

const chat = db('createChat', { title: 'Attachment chat' });

// ------------------------------------------------------------- basics -----
{
  check('limits match the documented values', MAX_CHAT_FILES === 8 && MAX_CHAT_FILE_BYTES === 256 * 1024 && MAX_CHAT_TOTAL_BYTES === 1024 * 1024,
    `${MAX_CHAT_FILES}/${MAX_CHAT_FILE_BYTES}/${MAX_CHAT_TOTAL_BYTES}`);

  const notes = '# Notes\nhello from a file';
  const lore = 'lore body';
  const saved = db('addMessage', {
    chatId: chat.id, role: 'user', content: 'please read these',
    files: [
      { name: 'notes.md', kind: 'file', content: notes },
      { name: 'Kael (story)', kind: 'story', content: lore }
    ]
  });

  check('addMessage returns file metadata', Array.isArray(saved.files) && saved.files.length === 2);
  check('metadata has name/kind/id/bytes', saved.files[0].name === 'notes.md'
    && saved.files[0].kind === 'file'
    && typeof saved.files[0].id === 'string' && saved.files[0].bytes === Buffer.byteLength(notes, 'utf8'));
  check('story kind is preserved', saved.files[1].kind === 'story');
  check('returned metadata never includes the body', !('content' in saved.files[0]));

  const rows = db('getMessages', { chatId: chat.id });
  check('getMessages attaches file metadata', rows.length === 1 && rows[0].files.length === 2);
  check('getMessages does not leak file bodies', !JSON.stringify(rows[0].files).includes('hello from a file'));
  check('message content round-trips', rows[0].content === 'please read these');

  const list = db('listMessageFiles', { messageId: saved.id });
  check('listMessageFiles returns metadata only', list.length === 2 && !('content' in list[0]) && list[0].message_id === saved.id);

  const body = db('readMessageFile', { id: saved.files[0].id });
  check('readMessageFile returns the original text', body.content === notes && body.bytes === saved.files[0].bytes);

  const stats = db('dbStats');
  check('dbStats counts files and bytes', stats.chatFiles === 2
    && stats.chatFileBytes === Buffer.byteLength(notes, 'utf8') + Buffer.byteLength(lore, 'utf8'),
    `${stats.chatFiles}/${stats.chatFileBytes}`);

  const plain = db('addMessage', { chatId: chat.id, role: 'assistant', content: 'no files' });
  check('messages without files get an empty list', plain.files.length === 0);
  check('getMessages keeps the empty list', db('getMessages', { chatId: chat.id })[1].files.length === 0);

  const unknownKind = db('addMessage', {
    chatId: chat.id, role: 'user', content: 'kind guard',
    files: [{ name: 'x.txt', kind: 'weird', content: 'x' }]
  });
  check('unknown kinds are normalized to file', unknownKind.files[0].kind === 'file');
  db('deleteMessage', { id: unknownKind.id, chatId: chat.id });
}

// -------------------------------------------------------------- limits -----
{
  const before = db('dbStats').messages;
  const file = (name, content) => ({ name, kind: 'file', content });

  const tooMany = throws(
    () => db('addMessage', { chatId: chat.id, role: 'user', content: 'x', files: Array.from({ length: 9 }, (_, i) => file(`f${i}.txt`, 'x')) }),
    /at most 8 files/
  );
  check('nine files are rejected with a readable message', tooMany.ok, tooMany.error);

  const tooBig = throws(
    () => db('addMessage', { chatId: chat.id, role: 'user', content: 'x', files: [file('big.txt', 'a'.repeat(MAX_CHAT_FILE_BYTES + 1))] }),
    /per-file limit/
  );
  check('a file over 256 KB is rejected', tooBig.ok, tooBig.error);

  // Five 240 KB files: each is under the per-file cap, the sum is over 1 MB.
  const overTotal = throws(
    () => db('addMessage', {
      chatId: chat.id, role: 'user', content: 'x',
      files: Array.from({ length: 5 }, (_, i) => file(`chunk${i}.txt`, 'a'.repeat(240 * 1024)))
    }),
    /limit is 1024 KB/
  );
  check('a set over 1 MB total is rejected', overTotal.ok, overTotal.error);

  const binary = throws(
    () => db('addMessage', { chatId: chat.id, role: 'user', content: 'x', files: [file('blob.bin', 'abc\u0000def')] }),
    /binary/
  );
  check('binary content is rejected', binary.ok, binary.error);

  const notString = throws(
    () => db('addMessage', { chatId: chat.id, role: 'user', content: 'x', files: [{ name: 'n.md' }] }),
    /no readable text content/
  );
  check('a file without string content is rejected', notString.ok, notString.error);

  check('rejected attachments wrote no message rows', db('dbStats').messages === before,
    `${before} → ${db('dbStats').messages}`);
}

// ------------------------------------------------------ delete / cleanup ---
{
  const rows = db('getMessages', { chatId: chat.id });
  const withFiles = rows.find((r) => r.files.length > 0);
  check('found the message that owns files', !!withFiles);

  db('deleteMessage', { id: withFiles.id, chatId: chat.id });
  check('deleting the message removes its files', db('dbStats').chatFiles === 0);

  const missing = throws(() => db('readMessageFile', { id: withFiles.files[0].id }), /no longer available/);
  check('reading a deleted file gives a readable error', missing.ok, missing.error);

  const again = db('addMessage', {
    chatId: chat.id, role: 'user', content: 'second batch',
    files: [{ name: 'a.txt', kind: 'file', content: 'aaa' }, { name: 'b.txt', kind: 'file', content: 'bb' }]
  });
  check('a second message can store files', again.files.length === 2 && db('dbStats').chatFiles === 2);

  const cleared = db('clearChatFiles');
  check('clearChatFiles reports what it removed', cleared.removed === 2 && db('dbStats').chatFiles === 0);
  check('clearChatFiles keeps the messages', db('getMessages', { chatId: chat.id }).length >= 2);
  check('cleared messages now have empty file lists', db('getMessages', { chatId: chat.id }).every((m) => m.files.length === 0));

  const third = db('addMessage', {
    chatId: chat.id, role: 'user', content: 'third batch',
    files: [{ name: 'c.txt', kind: 'file', content: 'c' }]
  });
  check('attachments still work after a clear', third.files.length === 1);

  // Restart: the card metadata and the lazily-read body must both survive.
  closeDb();
  await initDb(tmpRoot, 'files.db');
  const reopened = db('getMessages', { chatId: chat.id }).find((m) => m.files.length === 1);
  check('attachments survive a restart (metadata)', !!reopened && reopened.files[0].name === 'c.txt');
  const reopenedBody = reopened ? db('readMessageFile', { id: reopened.files[0].id }) : null;
  check('attachments survive a restart (body)', reopenedBody?.content === 'c');

  db('deleteChat', { id: chat.id });
  check('deleting the chat removes its files', db('dbStats').chatFiles === 0);
}

closeDb();
fs.rmSync(tmpRoot, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? `ALL CHAT-FILE TESTS PASSED (${results.length})` : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
