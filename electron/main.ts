import { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { initDb, closeDb, handleDb, setSecretCrypto } from './db';
import { runGeneration, fetchModels, verifyModel, validateApiKey, probeCapabilities, ProviderConfig, ChatMessage, GenChunk } from './ai';
import { PROVIDER_PRESETS, refreshPresets } from './presets';
import { loadPlugins, runPluginCommand, setNotify, listLoadedPlugins, runHook, wireDbHooks, log, getLogs } from './plugins';

const DONATE_URL = 'https://sociabuzz.com/mahakam_moonlight_studio/tribe';
const SAWERIA_URL = 'https://saweria.co/MahakamMoonStudio';

let win: BrowserWindow | null = null;
const aborts = new Map<string, () => void>();
// Chats with a generation in flight — db.ts refuses message deletes for
// these so an in-flight reply can never be stranded.
const busyChats = new Set<string>();
(globalThis as any).__busyChats = busyChats;

// Last-resort crash guard: an uncaught exception in the main process used to
// kill the whole app with no dialog, no log, nothing (Windows Event Log
// showed 0xc0000409 fast-fails during API-key validation). The app now
// surfaces the error in the UI and keeps running — a stuck renderer beats a
// dead app. Also log periodic unhandled rejections so they can be diagnosed.
process.on('uncaughtException', (err) => {
  try {
    console.error('[openplot] uncaught exception:', err?.stack || err);
    // ui:toast carries a plain string (see App.tsx onUi handler).
    send('ui:toast', 'Internal error caught: ' + String(err?.message || err).slice(0, 140));
  } catch { /* nothing more we can do */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('[openplot] unhandled rejection:', String((reason as any)?.stack || reason).slice(0, 400));
});

function send(channel: string, ...args: any[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Forward renderer crashes to a visible dialog instead of a silent white
// screen — users then have something concrete to report.
function rendererCrashGuard(): void {
  app.on('render-process-gone', (_e, _wc, details) => {
    try {
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'OpenPlot AI',
        message: 'The interface crashed and will reload.',
        detail: `Reason: ${details?.reason || 'unknown'}. Your data is safe on disk.`
      });
    } catch { /* ignore */ }
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
}

function createWindow(): void {
  // App icon (window/taskbar on Windows & Linux; dock uses the bundled icns)
  let iconPath: string | undefined;
  const iconCandidates = [
    path.join(__dirname, '..', 'build', 'icon-256.png'),
    path.join(__dirname, '..', 'icon-256.png')
  ];
  for (const p of iconCandidates) {
    try { if (fs.existsSync(p)) { iconPath = p; break; } } catch { /* ignore */ }
  }
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'OpenPlot AI',
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(true);

  // Open target=_blank / window.open links in the OS browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block in-app navigation away from the app itself
  win.webContents.on('will-navigate', (e, url) => {
    const current = win?.webContents.getURL() || '';
    if (url !== current && !url.startsWith('http://localhost:5173') && !url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => win?.show());

  if (process.env.INKWELL_DEV) {
    win.loadURL('http://localhost:5173');
    // PERF: auto-opening DevTools costs real CPU/RAM on every dev run and
    // Windows feels it the most. Opt back in with OPENPLOT_DEVTOOLS=1.
    if (process.env.OPENPLOT_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
    // Chromium's DevTools calls Autofill.enable on Electron versions where the
    // domain was removed — harmless, but it spams the terminal with
    // ERROR:CONSOLE lines. Swallow exactly those messages.
    win.webContents.on('console-message', (event, _level, message) => {
      if (/Autofill\.(enable|setAddresses)/i.test(message) && /wasn't found/i.test(message)) {
        event.preventDefault();
      }
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  win.on('closed', () => { win = null; });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'OpenPlot AI',
      submenu: [
        { label: 'About OpenPlot AI', click: () => send('ui:navigate', 'about') },
        { label: 'Donate (SociaBuzz)', click: () => shell.openExternal(DONATE_URL) },
        { label: 'Donate (Saweria)', click: () => shell.openExternal(SAWERIA_URL) },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'hide' : 'minimize' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'Find Chat', accelerator: 'CmdOrCtrl+F', click: () => send('ui:action', 'focus-search') },
        { label: 'Prompt Library', accelerator: 'CmdOrCtrl+/', click: () => send('ui:action', 'open-prompts') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send('ui:action', 'new-chat') },
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('ui:action', 'new-project') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('ui:navigate', 'settings') }
      ]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Donate (SociaBuzz)', click: () => shell.openExternal(DONATE_URL) },
        { label: 'Donate (Saweria)', click: () => shell.openExternal(SAWERIA_URL) },
        { label: 'GitHub', click: () => shell.openExternal('https://github.com/mahakammoonlightstudio-beep') },
        { label: 'YouTube', click: () => shell.openExternal('https://www.youtube.com/@MahakamMoonlightStudio') },
        { label: 'Plugin API Docs', click: () => send('ui:navigate', 'settings-plugins') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

ipcMain.handle('db', (_e, op: string, payload?: any) => {
  try {
    return { ok: true, data: handleDb(op, payload ?? {}) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:generate', async (_e, req: any) => {
  const reqId = req.reqId;
  let aborted = false;
  aborts.set(reqId, () => { aborted = true; });
  const isAborted = () => aborted;
  if (req.chatId) busyChats.add(req.chatId);

  try {
    const result = await runGeneration(
      {
        provider: req.provider,
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        topP: req.topP,
        thinkingEnabled: req.thinkingEnabled,
        thinkingBudget: req.thinkingBudget,
        toolsEnabled: req.toolsEnabled,
        projectId: req.projectId
      },
      (chunk: GenChunk) => send('ai:chunk', { reqId, chunk }),
      isAborted
    );
    return { ok: true, data: result };
  } catch (err: any) {
    if (err?.name === 'AbortedError' || /aborted/i.test(String(err?.message))) {
      return { ok: true, data: { text: '', thinking: '', toolsUsed: [], aborted: true } };
    }
    return { ok: false, error: err?.message || String(err) };
  } finally {
    aborts.delete(reqId);
    if (req.chatId) busyChats.delete(req.chatId);
  }
});

ipcMain.handle('ai:abort', (_e, reqId: string) => {
  aborts.get(reqId)?.();
  return true;
});

ipcMain.handle('ai:models', async (_e, provider: ProviderConfig) => {
  try {
    return { ok: true, data: await fetchModels(provider) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:verifyModel', async (_e, provider: ProviderConfig, model: string, reqId?: string) => {
  // Optional reqId lets the renderer cancel a slow verify via ai:abort —
  // the abort map is shared with ai:generate.
  let aborted = false;
  if (reqId) aborts.set(reqId, () => { aborted = true; });
  try {
    return { ok: true, data: await verifyModel(provider, model, () => aborted) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (reqId) aborts.delete(reqId);
  }
});

ipcMain.handle('ai:validateKey', async (_e, provider: ProviderConfig) => {
  try {
    return { ok: true, data: await validateApiKey(provider) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:probeCapabilities', async (_e, provider: ProviderConfig, model: string) => {
  try {
    return { ok: true, data: await probeCapabilities(provider, model) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:providerPresets', () => ({ ok: true, data: PROVIDER_PRESETS }));

ipcMain.handle('ai:refreshPresets', async (_e, providers: ProviderConfig[]) => {
  try {
    return { ok: true, data: await refreshPresets(providers || []) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('plugins:run', (_e, pluginId: string, command: string, payload?: any) => {
  try {
    return { ok: true, data: runPluginCommand(pluginId, command, payload) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('plugins:list', () => ({ ok: true, data: listLoadedPlugins() }));

ipcMain.handle('plugins:logs', () => ({ ok: true, data: getLogs() }));

ipcMain.handle('plugins:reload', () => {
  try {
    loadPlugins();
    return { ok: true, data: listLoadedPlugins() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ui:unreadCount', (_e, count: number) => {
  const n = Math.max(0, Math.min(999, Number(count) || 0));
  if (win && !win.isDestroyed()) {
    win.setTitle(n > 0 ? `(${n}) OpenPlot AI` : 'OpenPlot AI');
  }
  return true;
});

ipcMain.handle('app:info', () => ({
  ok: true,
  data: {
    version: app.getVersion(),
    platform: process.platform,
    dataPath: app.getPath('userData'),
    donateUrl: DONATE_URL,
    encryption: safeStorage?.isEncryptionAvailable?.() === true
  }
}));

ipcMain.handle('shell:openExternal', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle('export:markdown', async (_e, defaultName: string, content: string) => {
  if (!win) return { ok: false, error: 'no window' };
  // Strip filesystem-hostile characters from chat titles — Windows silently
  // turns  `title: "foo"`  into `title_ _foo_`  and Linux refuses the path.
  const safeName = String(defaultName || 'openplot-export.md')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'openplot-export.md';
  try {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export as Markdown',
      defaultPath: safeName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, data: res.filePath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---------- EPUB (assembled in the main process with zlib alone) ----------

// Minimal store-only ZIP writer: zlib.deflateRawSync per entry + local file
// headers + central directory. The EPUB spec requires the first entry
// (mimetype) to be STORED and FIRST — handled by a special case below.
function zipSync(entries: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 31) << 5) | ((now.getSeconds() >> 1) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  const crcTable = ZipCrc.table();

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = e.store ? e.data : zlib.deflateRawSync(e.data, { level: 9 });
    const useStore = e.store || comp.length >= e.data.length; // tiny files: store is smaller
    const data = useStore ? e.data : comp;
    const method = useStore ? 0 : 8;
    const crc = ZipCrc.crc32(e.data, crcTable) >>> 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);  // compressed size
    lh.writeUInt32LE(e.data.length, 22);// uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0, 8);             // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra len
    ch.writeUInt16LE(0, 32);            // comment len
    ch.writeUInt16LE(0, 34);            // disk number
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0, 38);            // external attrs
    ch.writeUInt32LE(offset, 42);       // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  offset += cdBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// CRC-32 (IEEE) — zlib needs it in every local/central header.
const ZipCrc = {
  table(): Uint32Array {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  },
  crc32(buf: Buffer, table: Uint32Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
};

// XML-escape for the OPF/XHTML documents.
function xmlEsc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Turn a chapter's plain text into one XHTML document (paragraph per block).
function chapterToXhtml(title: string, content: string): string {
  const paras = String(content || '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n/g, ' ').trim())
    .filter(Boolean)
    .map((p) => `    <p>${xmlEsc(p)}</p>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8" />
    <title>${xmlEsc(title)}</title>
  </head>
  <body>
    <h2>${xmlEsc(title)}</h2>
${paras || '    <p></p>'}
  </body>
</html>`;
}

interface EpubChapter { title: string; content: string }

// Build a valid EPUB 2 (most reader-compatible) from project data.
function buildEpubBuffer(title: string, chapters: EpubChapter[], author: string, lang: string = 'en'): Buffer {
  const bookId = `urn:uuid:${Date.now().toString(16)}-openplot`;
  const escapeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const files: { name: string; data: Buffer; store?: boolean }[] = [];

  // Spec: mimetype must be the FIRST entry and STORED.
  files.push({ name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), store: true });
  files.push({ name: 'META-INF/container.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`, 'utf8') });

  const items: string[] = [];
  const spine: string[] = [];
  const spineList = [
    { id: 'nav', title: 'Contents' },
    ...chapters.map((c, i) => ({ id: `ch${i + 1}`, title: c.title || `Chapter ${i + 1}` }))
  ];

  for (const ch of chapters) {
    const id = `ch${chapters.indexOf(ch) + 1}`;
    files.push({ name: `OEBPS/${id}.xhtml`, data: Buffer.from(chapterToXhtml(ch.title, ch.content), 'utf8') });
    items.push(`    <item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="${id}"/>`);
  }
  files.push({ name: 'OEBPS/nav.xhtml', data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><meta charset="utf-8" /><title>Contents</title></head>
  <body>
    <nav epub:type="toc">
      <h1>${xmlEsc(title)}</h1>
      <ol>
${spineList.map((c) => `        <li><a href="${c.id}.xhtml">${xmlEsc(c.title)}</a></li>`).join('\n')}
      </ol>
    </nav>
  </body>
</html>`, 'utf8') });
  items.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>`);

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${xmlEsc(bookId)}</dc:identifier>
    <dc:title>${xmlEsc(title)}</dc:title>
    <dc:creator>${xmlEsc(author)}</dc:creator>
    <dc:language>${xmlEsc(lang)}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, '')}Z</meta>
  </metadata>
  <manifest>
${items.join('\n')}
  </manifest>
  <spine>
${spine.join('\n')}
  </spine>
</package>`;
  files.push({ name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') });

  return zipSync(files);
}

// Save the assembled EPUB through the native save dialog. The renderer sends
// plain chapter data; the ZIP assembly happens here where zlib lives.
ipcMain.handle('export:epub', async (_e, defaultName: string, author: string, chapters: EpubChapter[], lang?: string) => {
  if (!win) return { ok: false, error: 'no window' };
  const safeName = String(defaultName || 'openplot-export.epub')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'openplot-export.epub';
  try {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export as EPUB',
      defaultPath: safeName,
      filters: [{ name: 'EPUB', extensions: ['epub'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    const title = safeName.replace(/\.epub$/i, '').trim() || 'OpenPlot Export';
    // Language tag is validated against a whitelist — arbitrary strings must
    // never reach the XML metadata unescaped (it goes through xmlEsc anyway,
    // but a well-formed tag like 'id' or 'en' is what readers expect).
    const langTag = /^(id|en)$/i.test(String(lang || '')) ? String(lang).toLowerCase() : 'en';
    const buf = buildEpubBuffer(title, Array.isArray(chapters) ? chapters : [], String(author || 'Unknown Author'), langTag);
    fs.writeFileSync(res.filePath, buf);
    return { ok: true, data: res.filePath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Generic save dialog for plain-text formats (TXT/MD) — one handler, many formats.
ipcMain.handle('export:file', async (_e, defaultName: string, content: string, kind: 'txt' | 'md') => {
  if (!win) return { ok: false, error: 'no window' };
  const ext = kind === 'txt' ? 'txt' : 'md';
  const safeName = String(defaultName || `openplot-export.${ext}`)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || `openplot-export.${ext}`;
  try {
    const res = await dialog.showSaveDialog(win, {
      title: `Export as ${ext.toUpperCase()}`,
      defaultPath: safeName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, data: res.filePath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('dialog:pickFiles', async () => {
  if (!win) return [];
  try {
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'fountain'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return res.canceled ? [] : res.filePaths;
  } catch {
    return [];
  }
});

ipcMain.handle('files:read', async (_e, paths: string[]) => {
  const out: { name: string; content: string }[] = [];
  for (const p of (paths || []).slice(0, 8)) {
    try {
      const st = fs.statSync(p);
      if (st.size > 300_000) continue; // skip huge files silently
      out.push({ name: p.split(/[\\/]/).pop() || p, content: fs.readFileSync(p, 'utf8') });
    } catch { /* unreadable file — skip */ }
  }
  return out;
});

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // OPENPLOT_DATA_DIR redirects the whole profile (DB + settings) — used for
    // clean-room test runs and screenshots without touching real user data.
    const dataDir = process.env.OPENPLOT_DATA_DIR || app.getPath('userData');
    // API keys at rest: encrypt with the OS credential vault when available.
    // Prefix-marked ciphertext keeps keys written by older versions readable.
    if (safeStorage?.isEncryptionAvailable?.()) {
      setSecretCrypto(
        (plain) => safeStorage.encryptString(plain).toString('latin1'),
        (stored) => safeStorage.decryptString(Buffer.from(stored, 'latin1'))
      );
    }
    // carry over data from the pre-rename InkWell install
    try {
      const oldDb = path.join(dataDir, 'inkwell.db');
      const newDb = path.join(dataDir, 'openplot.db');
      if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) fs.renameSync(oldDb, newDb);
    } catch { /* non-fatal */ }
    await initDb(dataDir, 'openplot.db');
    setNotify((msg) => send('ui:toast', msg));
    wireDbHooks(); // plugin hooks fire on chat:create / message:add DB events
    loadPlugins();
    runHook('app:ready', {});
    buildMenu();
    rendererCrashGuard();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Do NOT close the DB here: on macOS the app stays alive after all
    // windows close and any later DB call would throw "DB not ready".
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    closeDb();
  });
}
