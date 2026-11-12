import { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, nativeTheme } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { initDb, closeDb, handleDb, providerSecret, setSecretCrypto, SCHEMA_VERSION, getSchemaVersion, readSchemaVersionFile, persistNow, getDbFilePath, portableDatabaseBuffer, settingSecret } from './db';
import { settingsForRenderer } from './settingsPrivacy';
import { SNAPSHOT_MAX, copySnapshotFile, listSnapshotFiles, snapshotDirectory, snapshotFilePath } from './snapshots';
import { portableFileName, portableTarget, writePortableCopy } from './libraryExport';
import { runGeneration, fetchModels, verifyModel, validateApiKey, probeCapabilities, ProviderConfig, ChatMessage, GenChunk } from './ai';
import { PROVIDER_PRESETS, refreshPresets } from './presets';
import { markThinkingRejected, recordCacheObservation, recordModelCaps } from './caps';
import { loadPlugins, runPluginCommand, setNotify, listLoadedPlugins, runHook, wireDbHooks, log, getLogs } from './plugins';
import { startMcpServers, stopAllMcp, restartMcpServer, stopMcpServer, mcpStatuses, mcpLogs } from './mcp';
import { grantPaths, readTextFiles, setPrivateRoot } from './fileaccess';
import { fetchRemoteImage } from './images';
import { isTrusted, listTrust, parseTrust, remember, revoke, trustHash, type ExecKind, type TrustedMap } from './trust';

const DONATE_URL = 'https://sociabuzz.com/mahakam_moonlight_studio/tribe';

/** Dev renderer URL. Overridable so a test harness can serve Vite on its own
 *  port instead of fighting the default one. */
const DEV_URL = process.env.OPENPLOT_DEV_URL || 'http://localhost:5173';
function devOrigin(): string {
  try { return new URL(DEV_URL).origin; } catch { return ''; }
}

/** Automation runs on a throwaway profile (OPENPLOT_DATA_DIR); a real user's
 *  profile never sets it, so the destructive-op dialog still guards them. */
const ISOLATED_PROFILE = !!process.env.OPENPLOT_DATA_DIR;
const SAWERIA_URL = 'https://saweria.co/MahakamMoonStudio';

let win: BrowserWindow | null = null;
// Filled before initDb so a startup failure can tell the user where their data
// lives — the old build rejected silently and left a windowless process.
let dataDirForErrors = '';
let startupComplete = false;
let revealFallback: NodeJS.Timeout | null = null;
let startupErrorWin: BrowserWindow | null = null;
let restartingForRecovery = false;
const LIBRARY_CONFIG_FILE = 'library.json';
const aborts = new Map<string, () => void>();
// Chats with a generation in flight — db.ts refuses message deletes for
// these so an in-flight reply can never be stranded.
const busyChats = new Set<string>();
(globalThis as any).__busyChats = busyChats;

// ---------- renderer trust ----------

/**
 * Only the app's own document may use the bridge. `will-navigate` refuses to
 * load anything else into this window, and this is the matching IPC check: a
 * frame that is not the studio's own page gets nothing.
 */
function isTrustedFrame(event: Electron.IpcMainInvokeEvent): boolean {
  try {
    // A message from another window (or from a destroyed one) is refused
    // outright, whatever URL it claims.
    if (!win || win.isDestroyed() || !event?.sender || event.sender.id !== win.webContents.id) {
      return false;
    }
    const url = String(event.senderFrame?.url || '');
    // Some Electron versions do not expose the frame URL; the channel is only
    // reachable from this window's bridge anyway.
    if (!url) return true;
    if (/^file:\/\//i.test(url)) return /\/dist\/index\.html(?:[?#].*)?$/i.test(url);
    try {
      return new URL(url).origin === devOrigin();
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

const registerHandler = ipcMain.handle.bind(ipcMain);

/** ipcMain.handle with a sender check, so every channel fails closed. */
function secureHandle(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
): void {
  registerHandler(channel, (event, ...args) => {
    if (!isTrustedFrame(event)) {
      console.warn(`[ipc] refused ${channel} from an untrusted frame`);
      return { ok: false, error: 'untrusted sender' };
    }
    return fn(event, ...args);
  });
}

// ---------- provider credentials (main-process only) ----------

/**
 * The renderer names a provider by id; the stored base URL and API key are what
 * actually get used. Generation therefore cannot be pointed at another host (or
 * run with a key the user never saved) by editing the IPC payload.
 */
function resolveProvider(payload: any): ProviderConfig | null {
  const stored = payload?.id ? providerSecret(String(payload.id)) : null;
  if (!stored) return null;
  return {
    id: stored.id,
    name: stored.name,
    baseUrl: stored.baseUrl,
    apiKey: stored.apiKey,
    enabled: stored.enabled,
    models: stored.models,
    kind: (stored.kind as ProviderConfig['kind']) || 'auto'
  };
}

/**
 * Discovery (validate / fetch / probe / verify) can run before a provider is
 * saved, so a form's values are accepted — but for a saved provider the stored
 * endpoint and key always win.
 */
function resolveProviderForProbe(payload: Partial<ProviderConfig>): ProviderConfig {
  const stored = payload?.id ? providerSecret(String(payload.id)) : null;
  return {
    id: String(payload?.id || ''),
    name: payload?.name || stored?.name || 'provider',
    baseUrl: stored?.baseUrl || payload?.baseUrl || '',
    apiKey: stored?.apiKey || payload?.apiKey || '',
    enabled: payload?.enabled ?? true,
    models: Array.isArray(payload?.models) ? payload.models : stored?.models || [],
    kind: (stored?.kind as ProviderConfig['kind']) || payload?.kind || 'auto'
  };
}

/** Link-local addresses (cloud metadata) are never a real model provider. */
function isMetadataHost(rawUrl: string): boolean {
  try {
    const raw = String(rawUrl || '');
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    if (host === 'metadata.google.internal' || host === 'metadata.goog') return true;
    if (/^169\.254\./.test(host)) return true;
    if (host === '100.100.100.200') return true;
    if (host === '[fd00:ec2::254]' || host === 'fd00:ec2::254') return true;
    return false;
  } catch {
    return false;
  }
}

// ---------- dangerous-execution gate ----------

/**
 * Plugins and MCP servers run as the user. Approval is per exact payload: the
 * hash of the code (or the command) is what gets remembered, so editing either
 * asks again. A stored row on its own never executes anything.
 */
let trustedExec: TrustedMap = {};

function readTrust(): TrustedMap {
  try {
    return parseTrust((handleDb('getAllSettings', {}) as Record<string, string>)['trustedExec']);
  } catch {
    return {};
  }
}

function rememberTrust(kind: ExecKind, id: string, hash: string): void {
  remember(trustedExec, kind, id, hash);
  try {
    handleDb('setSetting', { key: 'trustedExec', value: JSON.stringify(trustedExec) });
  } catch { /* non-fatal: the approval still holds for this session */ }
}

function confirmExecution(kind: ExecKind, id: string, hash: string, label: string): boolean {
  if (isTrusted(trustedExec, kind, id, hash)) return true;
  const detail = kind === 'plugin'
    ? 'Plugins are JavaScript that runs with your full user privileges — files, network, everything on this machine.'
    : 'An MCP server is a program that runs with your full user privileges — files, network, everything on this machine.';
  const opts: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Run', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'OpenPlot AI',
    message: kind === 'plugin' ? `Run plugin "${label}"?` : `Start MCP server "${label}"?`,
    detail
  };
  let choice = 1;
  try {
    choice = win && !win.isDestroyed()
      ? dialog.showMessageBoxSync(win, opts)
      : dialog.showMessageBoxSync(opts);
  } catch {
    return false;
  }
  if (choice !== 0) return false;
  rememberTrust(kind, id, hash);
  return true;
}

/** Approval callback handed to loadPlugins for one reload. */
function pluginGate(interactive: boolean) {
  return (row: { id: string; name: string; code: string }): boolean => {
    const hash = trustHash('plugin', [row.code]);
    if (isTrusted(trustedExec, 'plugin', row.id, hash)) return true;
    if (interactive) return confirmExecution('plugin', row.id, hash, row.name);
    send('ui:toast', `Plugin "${row.name}" is not approved — open Settings → Plugins to run it.`);
    return false;
  };
}

/** Enabled MCP servers, minus the ones the user has not approved. */
function mcpConfigs(interactive: boolean): any[] {
  let rows: any[] = [];
  try {
    rows = (handleDb('listMcpServers', {}) as any[]) || [];
  } catch {
    return []; // database not ready yet
  }
  const out: any[] = [];
  for (const row of rows) {
    if (Number(row.enabled) !== 1) continue;
    const name = row.name || row.command;
    const hash = trustHash('mcp', [row.command, row.args, row.env]);
    const cfg = { id: row.id, name, command: row.command, args: row.args, env: row.env, enabled: 1 };
    if (isTrusted(trustedExec, 'mcp', row.id, hash)) {
      out.push(cfg);
      continue;
    }
    if (interactive && confirmExecution('mcp', row.id, hash, name)) {
      out.push(cfg);
      continue;
    }
    if (!interactive) send('ui:toast', `MCP server "${name}" is not approved — open Settings → MCP to start it.`);
  }
  return out;
}

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
      const opts = {
        type: 'error' as const,
        title: 'OpenPlot AI',
        message: 'The interface crashed and will reload.',
        detail: `Reason: ${details?.reason || 'unknown'}. Your data is safe on disk.`
      };
      if (win && !win.isDestroyed()) dialog.showMessageBoxSync(win, opts);
      else dialog.showErrorBox(opts.title, opts.message);
    } catch { /* ignore */ }
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
}

/**
 * Bring the main window to the foreground. A hidden/minimized window used to
 * make a second launch look like a no-op: the new process exited on the
 * single-instance lock while the first one stayed invisible in the background.
 */
function revealWindow(): void {
  if (revealFallback) { clearTimeout(revealFallback); revealFallback = null; }
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
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
    // Match the OS while the renderer boots; the stored theme takes over once
    // the app resolves "system".
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f6f5f1',
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
  // The studio is one document and never navigates. Refuse every navigation:
  // a `file:` link used to be allowed, which loaded a local HTML file into a
  // window that still had the preload bridge attached.
  win.webContents.on('will-navigate', (e, url) => {
    const current = win?.webContents.getURL() || '';
    if (url === current) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  win.once('ready-to-show', revealWindow);
  // If the renderer never reaches first paint (missing bundle, GPU/driver
  // failure, corrupted profile), show the window anyway instead of leaving a
  // live process with no visible UI. The page background is already dark, so
  // this is a titled window, not a white flash.
  revealFallback = setTimeout(revealWindow, 12000);
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = user/navigation aborted
    revealWindow();
    try {
      const detail = `The interface failed to load (${code}: ${description}).\n\n${url}`;
      if (win && !win.isDestroyed()) dialog.showMessageBoxSync(win, { type: 'error', title: 'OpenPlot AI', message: detail });
      else dialog.showErrorBox('OpenPlot AI', detail);
    } catch { /* no display */ }
  });

  if (process.env.INKWELL_DEV) {
    win.loadURL(DEV_URL);
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
  win.on('closed', () => {
    if (revealFallback) { clearTimeout(revealFallback); revealFallback = null; }
    win = null;
  });
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
        { label: 'Quick Switch', accelerator: 'CmdOrCtrl+P', click: () => send('ui:action', 'quick-switch') },
        { label: 'Prompt Library', accelerator: 'CmdOrCtrl+/', click: () => send('ui:action', 'open-prompts') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send('ui:action', 'new-chat') },
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('ui:action', 'new-project') },
        { label: 'Story Agent', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('ui:navigate', 'story-agent') },
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
        { label: 'Open guide', accelerator: 'F1', click: () => send('ui:action', 'guide') },
        { label: 'Keyboard shortcuts', accelerator: 'CmdOrCtrl+Shift+/', click: () => send('ui:action', 'shortcuts') },
        { type: 'separator' },
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

secureHandle('db', (_e, op: string, payload?: any) => {
  try {
    // The most destructive op gets a native confirmation: a renderer dialog can
    // be dismissed by injected code, an OS dialog cannot. An isolated test
    // profile is disposable (and headless), so it skips the prompt.
    if (op === 'resetAll' && !ISOLATED_PROFILE) {
      const opts: Electron.MessageBoxSyncOptions = {
        type: 'warning',
        buttons: ['Delete everything', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'OpenPlot AI',
        message: 'Delete all OpenPlot AI data?',
        detail: 'Chats, projects, story bible, chapters, settings and providers on this machine will be erased. This cannot be undone.'
      };
      const choice = win && !win.isDestroyed()
        ? dialog.showMessageBoxSync(win, opts)
        : dialog.showMessageBoxSync(opts);
      if (choice !== 0) return { ok: true, data: false };
    }
    const data = handleDb(op, payload ?? {});
    // Secrets are capabilities, not settings values. The renderer needs to know
    // whether a web-search key is configured, never the key itself.
    if (op === 'getAllSettings') {
      const rows = (data && typeof data === 'object' ? data : {}) as Record<string, string>;
      return {
        ok: true,
        data: settingsForRenderer(rows, !!settingSecret('webSearchApiKey'))
      };
    }
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('ai:generate', async (_e, req: any) => {
  const reqId = String(req?.reqId || crypto.randomUUID());
  // Credentials come from the database, never from this payload: a compromised
  // renderer cannot redirect a saved provider (or use a key it never had).
  const provider = resolveProvider(req?.provider);
  if (!provider) {
    return { ok: false, error: 'Unknown provider — choose one in Settings → AI Providers first.' };
  }
  if (isMetadataHost(provider.baseUrl)) {
    return { ok: false, error: 'Refusing to contact a link-local/metadata address.' };
  }
  let aborted = false;
  aborts.set(reqId, () => { aborted = true; });
  const isAborted = () => aborted;
  if (req?.chatId) busyChats.add(req.chatId);

  try {
    const result = await runGeneration(
      {
        provider,
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        topP: req.topP,
        thinkingEnabled: req.thinkingEnabled,
        thinkingBudget: req.thinkingBudget,
        toolsEnabled: req.toolsEnabled,
        projectId: req.projectId,
        chatId: req.chatId
      },
      (chunk: GenChunk) => send('ai:chunk', { reqId, chunk }),
      isAborted
    );
    // Cache reuse is only knowable from real traffic — fold it into the model
    // registry so Settings can report what the provider actually cached.
    if (result?.tokensCached != null) {
      recordCacheObservation(provider.id, req?.model || '', result.tokensCached);
    }
    return { ok: true, data: result };
  } catch (err: any) {
    if (err?.name === 'AbortedError' || /aborted/i.test(String(err?.message))) {
      return { ok: true, data: { text: '', thinking: '', toolsUsed: [], aborted: true } };
    }
    return { ok: false, error: err?.message || String(err) };
  } finally {
    aborts.delete(reqId);
    if (req?.chatId) busyChats.delete(req.chatId);
  }
});

secureHandle('ai:abort', (_e, reqId: string) => {
  aborts.get(reqId)?.();
  return true;
});

secureHandle('ai:models', async (_e, provider: ProviderConfig) => {
  try {
    const p = resolveProviderForProbe(provider);
    if (isMetadataHost(p.baseUrl)) return { ok: false, error: 'Refusing to contact a link-local/metadata address.' };
    return { ok: true, data: await fetchModels(p) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('ai:verifyModel', async (_e, provider: ProviderConfig, model: string, reqId?: string) => {
  // Optional reqId lets the renderer cancel a slow verify via ai:abort —
  // the abort map is shared with ai:generate.
  let aborted = false;
  if (reqId) aborts.set(reqId, () => { aborted = true; });
  try {
    const p = resolveProviderForProbe(provider);
    if (isMetadataHost(p.baseUrl)) return { ok: false, error: 'Refusing to contact a link-local/metadata address.' };
    return { ok: true, data: await verifyModel(p, model, () => aborted) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (reqId) aborts.delete(reqId);
  }
});

secureHandle('ai:validateKey', async (_e, provider: ProviderConfig) => {
  try {
    const p = resolveProviderForProbe(provider);
    if (isMetadataHost(p.baseUrl)) return { ok: false, error: 'Refusing to contact a link-local/metadata address.' };
    return { ok: true, data: await validateApiKey(p) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// The renderer reports a refused thinking request; the merge happens here so a
// cache observation the renderer has not loaded yet is never overwritten.
secureHandle('ai:markThinkingRejected', (_e, providerId: string, model: string) => {
  try {
    markThinkingRejected(providerId, model);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('ai:probeCapabilities', async (_e, provider: ProviderConfig, model: string) => {
  try {
    const p = resolveProviderForProbe(provider);
    if (isMetadataHost(p.baseUrl)) return { ok: false, error: 'Refusing to contact a link-local/metadata address.' };
    const caps = await probeCapabilities(p, model);
    // Persist a *successful or failed* probe alike: "this relay cannot do
    // tools" is exactly as useful tomorrow as "it can".
    recordModelCaps(p.id, model, caps);
    return { ok: true, data: caps };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('ai:providerPresets', () => ({ ok: true, data: PROVIDER_PRESETS }));

secureHandle('ai:refreshPresets', async () => {
  try {
    // Read the configured providers here: the renderer no longer holds API
    // keys, and this call needs them to reach the provider's model list.
    const rows = (handleDb('listProviders', {}) as any[]) || [];
    const configured = rows
      .map((r) => providerSecret(r.id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ ...p, kind: p.kind as ProviderConfig['kind'] }));
    return { ok: true, data: await refreshPresets(configured) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---------- MCP bridge (v1.2.3 Task 13) ----------

/**
 * Start the registry from what the database says is enabled. `interactive`
 * asks the user to approve a server that has no recorded approval; startup
 * never prompts — it leaves that server stopped and says so.
 */
function syncMcpServers(interactive = false): Promise<unknown> {
  return startMcpServers(mcpConfigs(interactive));
}

secureHandle('mcp:list', () => ({ ok: true, data: mcpStatuses() }));

secureHandle('mcp:sync', async () => {
  try {
    return { ok: true, data: await syncMcpServers(true) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('mcp:restart', async (_e, id: string) => {
  try {
    const rows = (handleDb('listMcpServers', {}) as any[]) || [];
    const row = rows.find((r) => r.id === id);
    if (!row) {
      stopMcpServer(id);
      return { ok: true, data: null };
    }
    // Restart must not be a back door around "disabled": a server the user
    // switched off stays off until it is enabled again.
    if (Number(row.enabled) !== 1) {
      stopMcpServer(id);
      return { ok: false, error: 'This MCP server is disabled. Enable it first.' };
    }
    const label = row.name || row.command;
    const hash = trustHash('mcp', [row.command, row.args, row.env]);
    if (!confirmExecution('mcp', row.id, hash, label)) {
      return { ok: false, error: 'Start cancelled.' };
    }
    const status = await restartMcpServer({
      id: row.id, name: label, command: row.command, args: row.args, env: row.env, enabled: 1
    });
    return { ok: true, data: status };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('mcp:logs', (_e, id: string) => ({ ok: true, data: mcpLogs(id) }));

// ---------- stored execution approvals ----------

/**
 * What the user has approved so far, joined with the row it belongs to.
 * `stale` = the code/command changed after approval (it will ask again),
 * `present:false` = the row was deleted but its hash is still stored.
 */
function trustEntries(): any[] {
  let plugins: any[] = [];
  let servers: any[] = [];
  try { plugins = (handleDb('listPlugins', {}) as any[]) || []; } catch { /* db not ready */ }
  try { servers = (handleDb('listMcpServers', {}) as any[]) || []; } catch { /* db not ready */ }
  return listTrust(trustedExec, plugins, servers);
}

secureHandle('trust:list', () => ({ ok: true, data: trustEntries() }));

secureHandle('trust:revoke', (_e, kind: ExecKind, id: string) => {
  try {
    if ((kind !== 'plugin' && kind !== 'mcp') || typeof id !== 'string' || !id || id.length > 200) {
      return { ok: false, error: 'Invalid approval' };
    }
    revoke(trustedExec, kind, id);
    try {
      handleDb('setSetting', { key: 'trustedExec', value: JSON.stringify(trustedExec) });
    } catch { /* session-only revoke still takes effect below */ }
    // Revoking must bite immediately, not at the next restart. No dialogs
    // here: only already-approved rows may come back up.
    if (kind === 'mcp') stopMcpServer(id);
    else loadPlugins({ isTrusted: (row) => isTrusted(trustedExec, 'plugin', row.id, trustHash('plugin', [row.code])) });
    return { ok: true, data: trustEntries() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---------- remote images ----------

// The renderer never talks to an image host: the main process fetches the
// bytes (http/https only, private hosts refused) and returns a data: URL.
secureHandle('img:fetch', async (_e, url: string) => fetchRemoteImage(String(url || '')));

secureHandle('plugins:run', (_e, pluginId: string, command: string, payload?: any) => {
  try {
    return { ok: true, data: runPluginCommand(pluginId, command, payload) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('plugins:list', () => ({ ok: true, data: listLoadedPlugins() }));

secureHandle('plugins:logs', () => ({ ok: true, data: getLogs() }));

secureHandle('plugins:reload', () => {
  try {
    // An explicit reload is the user acting on a plugin: approve anything new
    // or edited, once per exact code.
    loadPlugins({ isTrusted: pluginGate(true) });
    return { ok: true, data: listLoadedPlugins() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// OS-level attention for the `notify` automation action: flash the taskbar/
// dock icon. Deliberately no sound and no native notification — a flash is
// visible without stealing focus or interrupting a writing session.
secureHandle('ui:flashWindow', () => {
  if (win && !win.isDestroyed()) win.flashFrame(true);
  return true;
});

// Unread wins the title (messenger convention). With nothing unread the active
// chat's name is shown instead, so taskbar/task-switcher previews are useful.
secureHandle('ui:unreadCount', (_e, count: number, chatTitle?: string) => {
  const n = Math.max(0, Math.min(999, Number(count) || 0));
  if (win && !win.isDestroyed()) {
    const name = String(chatTitle || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 80);
    win.setTitle(n > 0 ? `(${n}) OpenPlot AI` : name ? `${name} — OpenPlot AI` : 'OpenPlot AI');
  }
  return true;
});

secureHandle('app:info', () => ({
  ok: true,
  data: {
    version: app.getVersion(),
    platform: process.platform,
    dataPath: dataDirForErrors || app.getPath('userData'),
    dbPath: dataDirForErrors ? path.join(dataDirForErrors, activeLibraryName(dataDirForErrors)) : '',
    dbSchema: (() => { try { return getSchemaVersion(); } catch { return null; } })(),
    donateUrl: DONATE_URL,
    encryption: safeStorage?.isEncryptionAvailable?.() === true
  }
}));

// ---------- library / database switching ----------
secureHandle('library:list', () => {
  try {
    return { ok: true, data: libraryList(dataDirForErrors) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('library:switch', (_e, name: string) => {
  try {
    const dir = dataDirForErrors;
    const target = libraryName(name);
    const file = path.join(dir, target);
    if (!fs.existsSync(file)) throw new Error(`Library not found: ${target}`);
    const schema = readSchemaVersionFile(file);
    if (schema === null) throw new Error('That file is not a readable SQLite database.');
    if (schema > SCHEMA_VERSION) {
      throw new Error(`That library was written by a newer OpenPlot AI (schema ${schema} > ${SCHEMA_VERSION}). Update the app before opening it.`);
    }
    setActiveLibrary(dir, target);
    relaunchForLibrary();
    return { ok: true, data: { name: target, schema, legacy: schema < SCHEMA_VERSION } };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('library:create', (_e, rawName: string) => {
  try {
    const dir = dataDirForErrors;
    const name = libraryName(rawName);
    if (fs.existsSync(path.join(dir, name))) throw new Error(`“${name}” already exists — pick another name.`);
    setActiveLibrary(dir, name);
    relaunchForLibrary();
    return { ok: true, data: { name } };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('library:import', async () => {
  try {
    if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
    const res = await dialog.showOpenDialog(win, {
      title: 'Import an OpenPlot library',
      properties: ['openFile'],
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }]
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' };
    const source = res.filePaths[0];
    const schema = readSchemaVersionFile(source);
    if (schema === null) throw new Error('That file is not a readable SQLite database.');
    if (schema > SCHEMA_VERSION) {
      throw new Error(`That library is newer than this app (schema ${schema} > ${SCHEMA_VERSION}).`);
    }
    const dir = dataDirForErrors;
    // The import only copies a file, but keep a discoverable copy of the
    // current library before adding another database to the profile.
    createActiveSnapshot('pre-import');
    const stem = path.basename(source, path.extname(source)) || 'library';
    let name = libraryName(`${stem}.db`);
    let n = 2;
    while (fs.existsSync(path.join(dir, name))) {
      name = libraryName(`${stem} (${n}).db`);
      n++;
    }
    fs.copyFileSync(source, path.join(dir, name));
    return { ok: true, data: { entry: libraryEntry(dir, name, activeLibraryName(dir)), source } };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/** Write one portable copy of the active library through a native save dialog. */
secureHandle('library:export', async () => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
  const dbFile = getDbFilePath();
  if (!dbFile) return { ok: false, error: 'The library is not open yet.' };
  try {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export a portable library',
      defaultPath: portableFileName(dbFile),
      filters: [{ name: 'OpenPlot library', extensions: ['db'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    const target = portableTarget(res.filePath, dbFile);
    const data = portableDatabaseBuffer();
    if (!data) throw new Error('Could not read the open library.');
    writePortableCopy(target, data);
    return { ok: true, data: { name: path.basename(target), path: target, bytes: data.length } };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('library:reveal', () => {
  try { void shell.openPath(dataDirForErrors); return true; } catch { return false; }
});

// ---------- library Time Machine ----------

function snapshotEntry(dir: string, active: string, info: any): any {
  const schema = readSchemaVersionFile(path.join(snapshotDirectory(dir, active), info.name));
  return { ...info, schema, status: schemaStatus(schema) };
}

function openedLibraryName(dir: string): string {
  const open = getDbFilePath();
  return open ? path.basename(open) : activeLibraryName(dir);
}

function snapshotState(): any {
  const dir = dataDirForErrors;
  const active = openedLibraryName(dir);
  return {
    dir: snapshotDirectory(dir, active),
    active,
    max: SNAPSHOT_MAX,
    entries: listSnapshotFiles(dir, active).map((s) => snapshotEntry(dir, active, s))
  };
}

/** Flush the 1.2s debounce, then copy the active file into its snapshot folder. */
function createActiveSnapshot(reason: string): any {
  const dbFile = getDbFilePath();
  if (!dbFile) throw new Error('The library is not open yet.');
  const dir = dataDirForErrors;
  const active = path.basename(dbFile);
  if (!persistNow(true)) throw new Error('Could not flush the active library before taking a snapshot.');
  const info = copySnapshotFile(dir, active, dbFile, reason);
  return snapshotEntry(dir, active, info);
}

/** At most one daily copy per 24 hours; failures never block startup. */
function ensureDailySnapshot(): void {
  try {
    const dir = dataDirForErrors;
    const active = openedLibraryName(dir);
    const newestDaily = listSnapshotFiles(dir, active).find((s) => s.reason === 'daily');
    if (newestDaily && Date.now() - newestDaily.savedAt < 24 * 60 * 60 * 1000) return;
    createActiveSnapshot('daily');
  } catch (e) {
    console.error('[openplot] daily snapshot failed:', e);
  }
}

secureHandle('snapshot:list', () => {
  try { return { ok: true, data: snapshotState() }; }
  catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
});

secureHandle('snapshot:create', () => {
  try { return { ok: true, data: { entry: createActiveSnapshot('manual'), state: snapshotState() } }; }
  catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
});

secureHandle('snapshot:restore', async (_e, file: string) => {
  const dir = dataDirForErrors;
  const active = openedLibraryName(dir);
  const dbFile = getDbFilePath();
  let tmp = '';
  try {
    if (!dbFile || path.basename(dbFile) !== active) {
      throw new Error('The active library is still changing. Try again after the restart.');
    }
    if (busyChats.size > 0) {
      throw new Error('Stop the current reply before restoring a snapshot.');
    }
    const info = listSnapshotFiles(dir, active).find((s) => s.name === file);
    if (!info) throw new Error('That snapshot no longer exists.');
    const source = snapshotFilePath(dir, active, info.name);
    const schema = readSchemaVersionFile(source);
    if (schema === null) throw new Error('That snapshot is not a readable SQLite database.');
    if (schema > SCHEMA_VERSION) {
      throw new Error(`That snapshot was created by a newer OpenPlot AI (schema ${schema} > ${SCHEMA_VERSION}).`);
    }

    // Keep the state being replaced, so "restore" itself is reversible.
    createActiveSnapshot('pre-restore');

    // Copy first, while the DB is open. Nothing replaces the live file until
    // a complete second copy exists beside it.
    tmp = `${dbFile}.restore.tmp`;
    fs.copyFileSync(source, tmp);
    closeDb();
    try {
      fs.renameSync(tmp, dbFile);
    } catch (err: any) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      // The live file was not replaced, so reopen it instead of leaving the
      // renderer talking to a closed database.
      try { await initDb(dir, active); } catch (reopenErr) {
        console.error('[openplot] could not reopen after a failed restore:', reopenErr);
      }
      throw new Error(`Could not replace the active library: ${messageOf(err)}. Nothing was changed.`);
    }
    relaunchForLibrary();
    return { ok: true, data: { name: info.name } };
  } catch (err: any) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* already moved or absent */ } }
    return { ok: false, error: err?.message || String(err) };
  }
});

secureHandle('shell:openExternal', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

secureHandle('export:markdown', async (_e, defaultName: string, content: string) => {
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
secureHandle('export:epub', async (_e, defaultName: string, author: string, chapters: EpubChapter[], lang?: string) => {
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
    const requested = String(lang || '').toLowerCase();
    const langTag = requested === 'en-gb' ? 'en-GB' : requested === 'en-us' ? 'en-US'
      : ['id', 'en', 'es', 'hi'].includes(requested) ? requested : 'en';
    const buf = buildEpubBuffer(title, Array.isArray(chapters) ? chapters : [], String(author || 'Unknown Author'), langTag);
    fs.writeFileSync(res.filePath, buf);
    return { ok: true, data: res.filePath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Generic save dialog for plain-text formats (TXT/MD) — one handler, many formats.
secureHandle('export:file', async (_e, defaultName: string, content: string, kind: 'txt' | 'md' | 'json') => {
  if (!win) return { ok: false, error: 'no window' };
  const ext = kind === 'txt' ? 'txt' : kind === 'json' ? 'json' : 'md';
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

secureHandle('dialog:pickFiles', async () => {
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
    // The picker is the trusted grant: the main process itself produced these
    // paths, so they become readable for this session.
    if (!res.canceled) grantPaths(res.filePaths);
    return res.canceled ? [] : res.filePaths;
  } catch {
    return [];
  }
});

// Read text files for attachments / Story Bible import. `maxBytes` is capped
// at 2 MB so a renderer bug can never ask the main process to slurp a 2 GB
// blob into memory. Chat attachments keep the historical 300 KB default.
secureHandle('files:read', (_e, paths: string[], maxBytes?: number) => readTextFiles(paths, maxBytes));

// A dropped file is a user gesture the main process never sees. The renderer
// names the exact paths it dropped and only those become readable (30 minutes),
// so a compromised renderer cannot read an arbitrary path through files:read.
secureHandle('files:grant', (_e, paths: string[]) => {
  grantPaths(paths);
  return true;
});

// ---------- libraries ----------

/**
 * A library is just a SQLite file in the profile folder. `library.json` stores
 * only a basename — never a path — so a tampered config cannot point the app at
 * an arbitrary file outside its own data directory.
 */
function libraryName(name: unknown): string {
  const base = path.basename(String(name || '').trim())
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  if (!base) return 'openplot.db';
  return /\.db$/i.test(base) ? base : `${base}.db`;
}

function activeLibraryName(dir: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, LIBRARY_CONFIG_FILE), 'utf8'));
    if (cfg && typeof cfg.active === 'string') return libraryName(cfg.active);
  } catch { /* first run or unreadable config */ }
  return 'openplot.db';
}

function setActiveLibrary(dir: string, name: string): void {
  const file = path.join(dir, LIBRARY_CONFIG_FILE);
  fs.writeFileSync(file, JSON.stringify({ active: libraryName(name) }, null, 2));
}

function schemaStatus(schema: number | null): 'current' | 'legacy' | 'newer' | 'unreadable' {
  return schema === null ? 'unreadable'
    : schema > SCHEMA_VERSION ? 'newer'
      : schema === SCHEMA_VERSION ? 'current' : 'legacy';
}

function libraryEntry(dir: string, name: string, active: string): any {
  const file = path.join(dir, name);
  let bytes = 0;
  let modified = 0;
  try {
    const st = fs.statSync(file);
    bytes = st.size;
    modified = st.mtimeMs;
  } catch { /* missing active target is created on next launch */ }
  const schema = readSchemaVersionFile(file);
  return { name, bytes, modified, schema, status: schemaStatus(schema), active: name === active };
}

function libraryList(dir: string): any {
  const active = activeLibraryName(dir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /\.db$/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
  } catch { /* profile not created yet */ }
  if (!names.includes(active)) names.push(active);
  names.sort((a, b) => (a === active ? -1 : b === active ? 1 : a.localeCompare(b)));
  return {
    dir,
    active,
    currentSchema: SCHEMA_VERSION,
    entries: names.map((name) => libraryEntry(dir, name, active))
  };
}

/** Restart after a short delay so the renderer receives the IPC result first. */
function relaunchForLibrary(): void {
  setTimeout(() => {
    // `app.exit` skips will-quit, so flush the debounced 1.2s DB write first —
    // otherwise the last edit before switching libraries could be lost.
    try { closeDb(); } catch { /* startup may have failed before init */ }
    app.relaunch();
    app.exit(0);
  }, 250);
}

// ---------- lifecycle ----------

function messageOf(err: unknown): string {
  return String((err as any)?.message || err || 'Unknown error');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/**
 * A native message box can crash an Electron process that has no window yet
 * (reproduced as 0xc0000005 in the packaged app). This tiny local page is its
 * own BrowserWindow, so a failed startup always produces something visible and
 * actionable — the old build left a windowless process in Task Manager.
 */
function showStartupError(err: unknown): void {
  const message = `The studio stopped before its main window could open.\n\n${messageOf(err)}`;
  console.error('[openplot] startup failed:', (err as any)?.stack || message);
  if (startupErrorWin && !startupErrorWin.isDestroyed()) {
    startupErrorWin.show();
    startupErrorWin.focus();
    return;
  }
  const dbFile = dataDirForErrors ? path.join(dataDirForErrors, activeLibraryName(dataDirForErrors)) : '';
  let hasDb = false;
  try { hasDb = !!dbFile && fs.existsSync(dbFile); } catch { /* ignore */ }
  const folder = escapeHtml(dataDirForErrors || '(unknown)');
  const detail = escapeHtml(messageOf(err).slice(0, 1800));
  const reset = hasDb
    ? `<a class="button danger" href="openplot://reset-library">Start with an empty library</a>
       <p class="hint">The current openplot.db is renamed with a timestamp; nothing is deleted.</p>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>OpenPlot AI could not start</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8eaf0;
      font:14px/1.55 system-ui,Segoe UI,sans-serif;padding:32px}
 main{width:min(640px,100%)}h1{font-size:22px;margin:0 0 10px;color:#fff}
 p{margin:0 0 14px;color:#b9bfcc}code{color:#f4c97a;background:#171b24;padding:2px 5px;border-radius:4px;word-break:break-all}
 .detail{white-space:pre-wrap;background:#141821;border:1px solid #272d3a;border-radius:10px;padding:14px;color:#d7dbe5;max-height:210px;overflow:auto}
 .folder{font-size:12px;color:#8f98aa;word-break:break-all;margin:12px 0 22px}
 .actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
 .button{display:inline-block;padding:9px 14px;border-radius:8px;text-decoration:none;background:#2a3040;color:#fff}
 .button.primary{background:#6c8cff;color:#081020}.button.danger{background:#3a2328;color:#ffb4b4}
 .hint{font-size:12px;color:#8f98aa;margin:8px 0 0;width:100%}
</style></head><body><main>
<h1>OpenPlot AI could not start</h1>
<p>The app is running, but its window could not open. Your data has not been modified.</p>
<div class="detail">${detail}</div>
<p class="folder">Data folder:<br><code>${folder}</code></p>
<div class="actions">
  <a class="button primary" href="openplot://open-folder">Open data folder</a>
  ${reset}
  <a class="button" href="openplot://quit">Quit</a>
</div>
</main></body></html>`;
  startupErrorWin = new BrowserWindow({
    width: 760, height: 560, minWidth: 520, minHeight: 380,
    title: 'OpenPlot AI could not start',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f6f5f1',
    show: true, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  startupErrorWin.setMenuBarVisibility(false);
  startupErrorWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  startupErrorWin.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === 'openplot://open-folder') {
      try { void shell.openPath(dataDirForErrors); } catch { /* ignore */ }
      return;
    }
    if (url === 'openplot://reset-library') {
      resetLibraryAndRestart();
      return;
    }
    if (url === 'openplot://quit') app.quit();
  });
  startupErrorWin.on('closed', () => {
    startupErrorWin = null;
    if (!restartingForRecovery) app.quit();
  });
  void startupErrorWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/** Rename, never delete, the file that prevented startup, then relaunch. */
function resetLibraryAndRestart(): void {
  const dbFile = path.join(dataDirForErrors, activeLibraryName(dataDirForErrors));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${dbFile}.unreadable-${stamp}`;
  try {
    if (fs.existsSync(dbFile)) fs.renameSync(dbFile, backup);
    restartingForRecovery = true;
    app.relaunch();
    app.exit(0);
  } catch (e: any) {
    console.error('[openplot] could not reset library:', e);
    if (startupErrorWin && !startupErrorWin.isDestroyed()) {
      const safe = JSON.stringify(`Could not move the database: ${messageOf(e)}`);
      void startupErrorWin.webContents.executeJavaScript(
        `document.querySelector('.detail').textContent = ${safe};`
      ).catch(() => {});
    }
  }
}

function startupFailure(err: unknown): void {
  const message = messageOf(err) || 'Unknown startup error';
  console.error('[openplot] startup failed:', (err as any)?.stack || message);
  if (win && !win.isDestroyed()) {
    // A window exists, so a parented native dialog is safe here.
    revealWindow();
    try {
      dialog.showMessageBoxSync(win, {
        type: 'error',
        title: 'OpenPlot AI',
        message: `The studio could not finish starting.\n\n${message.slice(0, 1800)}`
      });
    } catch { /* no display */ }
    return;
  }
  showStartupError(err);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // A second launch while the first is still initializing will be handled by
    // the first window as soon as it appears. Once startup is done, recreate a
    // missing window instead of silently focusing nothing.
    if (win && !win.isDestroyed()) revealWindow();
    else if (startupErrorWin && !startupErrorWin.isDestroyed()) {
      startupErrorWin.show();
      startupErrorWin.focus();
    }
    else if (startupComplete) createWindow();
  });

  app.whenReady().then(async () => {
    // OPENPLOT_DATA_DIR redirects the whole profile (DB + settings) — used for
    // clean-room test runs and screenshots without touching real user data.
    dataDirForErrors = process.env.OPENPLOT_DATA_DIR || app.getPath('userData');
    const dataDir = dataDirForErrors;
    // files:read may never hand the app's own database back to the renderer.
    setPrivateRoot(dataDir);
    // API keys at rest: encrypt with the OS credential vault when available.
    // Prefix-marked ciphertext keeps keys written by older versions readable.
    if (safeStorage?.isEncryptionAvailable?.()) {
      setSecretCrypto(
        (plain) => safeStorage.encryptString(plain).toString('latin1'),
        (stored) => safeStorage.decryptString(Buffer.from(stored, 'latin1'))
      );
    }
    const activeLibrary = activeLibraryName(dataDir);
    // carry over data from the pre-rename InkWell install
    try {
      const oldDb = path.join(dataDir, 'inkwell.db');
      const newDb = path.join(dataDir, 'openplot.db');
      if (activeLibrary === 'openplot.db' && fs.existsSync(oldDb) && !fs.existsSync(newDb)) fs.renameSync(oldDb, newDb);
    } catch { /* non-fatal */ }
    try {
      await initDb(dataDir, activeLibrary);
    } catch (err) {
      // Never continue into a half-initialized DB. The error window offers a
      // safe backup+relaunch instead of leaving a background process.
      showStartupError(err);
      return;
    }
    setNotify((msg) => send('ui:toast', msg));
    wireDbHooks(); // plugin hooks fire on chat:create / message:add DB events
    trustedExec = readTrust();
    buildMenu();
    rendererCrashGuard();
    createWindow();
    startupComplete = true;
    // Let the studio paint before copying a possibly large database.
    setTimeout(ensureDailySnapshot, 1500);
    // Load plugin/MCP work after the window exists: an "not approved" notice
    // sent to a null window used to be dropped, so the run looked silently
    // broken. Startup never prompts — unapproved code simply stays unloaded.
    loadPlugins({ isTrusted: pluginGate(false) });
    // A stored definition alone never spawns a process: only enabled, approved
    // servers start.
    syncMcpServers().catch((e) => console.error('MCP startup failed:', e));
    runHook('app:ready', {});
    app.on('activate', () => {
      if (win && !win.isDestroyed()) revealWindow();
      else if (startupComplete) createWindow();
    });
  }).catch(startupFailure);

  app.on('window-all-closed', () => {
    // Do NOT close the DB here: on macOS the app stays alive after all
    // windows close and any later DB call would throw "DB not ready".
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    // Children must not outlive the app: a stray MCP server would keep holding
    // ports, files and folders the user gave it access to.
    stopAllMcp();
    closeDb();
  });
}
