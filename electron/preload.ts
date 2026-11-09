import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  platform: process.platform,
  // Absolute path of a dragged File — webUtils must run in the preload
  // (renderer File.path was removed in newer Electron). Powers drag & drop.
  pathForFile: (file: File) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  dbCall: (op: string, payload?: any) => ipcRenderer.invoke('db', op, payload),
  generate: (req: any) => ipcRenderer.invoke('ai:generate', req),
  abort: (reqId: string) => ipcRenderer.invoke('ai:abort', reqId),
  fetchModels: (provider: any) => ipcRenderer.invoke('ai:models', provider),
  verifyModel: (provider: any, model: string, reqId?: string) => ipcRenderer.invoke('ai:verifyModel', provider, model, reqId),
  validateKey: (provider: any) => ipcRenderer.invoke('ai:validateKey', provider),
  probeCapabilities: (provider: any, model: string) => ipcRenderer.invoke('ai:probeCapabilities', provider, model),
  markThinkingRejected: (providerId: string, model: string) => ipcRenderer.invoke('ai:markThinkingRejected', providerId, model),
  providerPresets: () => ipcRenderer.invoke('ai:providerPresets'),
  refreshPresets: (providers: any[]) => ipcRenderer.invoke('ai:refreshPresets', providers),
  runPlugin: (pluginId: string, command: string, payload?: any) =>
    ipcRenderer.invoke('plugins:run', pluginId, command, payload),
  listLoadedPlugins: () => ipcRenderer.invoke('plugins:list'),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  pluginLogs: () => ipcRenderer.invoke('plugins:logs'),
  // MCP bridge: statuses, (re)start from the stored definitions, per-server log.
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSync: () => ipcRenderer.invoke('mcp:sync'),
  mcpRestart: (id: string) => ipcRenderer.invoke('mcp:restart', id),
  mcpLogs: (id: string) => ipcRenderer.invoke('mcp:logs', id),
  // Stored execution approvals (plugins/MCP) — read and revoke from Settings.
  trustList: () => ipcRenderer.invoke('trust:list'),
  trustRevoke: (kind: 'plugin' | 'mcp', id: string) => ipcRenderer.invoke('trust:revoke', kind, id),
  // Markdown images are fetched by the main process, never by the renderer,
  // so CSP can keep connect-src 'none'. Private hosts are refused there.
  fetchImage: (url: string) => ipcRenderer.invoke('img:fetch', url),
  // Unwrap the {ok, data} envelope: every consumer (About, Settings, tests)
  // expects the AppInfo object itself — the wrapper used to leak through and
  // made info.version / info.dataPath silently undefined.
  appInfo: () => ipcRenderer.invoke('app:info').then((r: any) => (r && r.data) ? r.data : r),
  setUnreadCount: (count: number, chatTitle?: string) => ipcRenderer.invoke('ui:unreadCount', count, chatTitle),
  /** Flash the window (taskbar/dock) — used by the `notify` automation action. */
  flashWindow: () => ipcRenderer.invoke('ui:flashWindow'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  exportMarkdown: (name: string, content: string) => ipcRenderer.invoke('export:markdown', name, content),
  exportFile: (name: string, content: string, kind: 'txt' | 'md' | 'json') => ipcRenderer.invoke('export:file', name, content, kind),
  // EPUB is assembled in the main process (zlib); the renderer sends chapter data.
  exportEpub: (name: string, author: string, chapters: { title: string; content: string }[], lang?: string) =>
    ipcRenderer.invoke('export:epub', name, author, chapters, lang),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  readFiles: (paths: string[], maxBytes?: number) => ipcRenderer.invoke('files:read', paths, maxBytes),
  // Registers the files the user just dropped, so `files:read` will accept
  // them. The path comes from webUtils for a real File; a synthetic File (no
  // filesystem entry) yields '' and grants nothing, so this bridge cannot be
  // used to widen access to an arbitrary path by name.
  grantDroppedFiles: (files: File[]) => {
    const paths: string[] = [];
    for (const f of Array.isArray(files) ? files.slice(0, 40) : []) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch { /* not a real dropped file */ }
    }
    return paths.length
      ? ipcRenderer.invoke('files:grant', paths)
      : Promise.resolve(false);
  },
  onAiChunk: (cb: (data: { reqId: string; chunk: any }) => void) => {
    const handler = (_e: unknown, data: any) => cb(data);
    ipcRenderer.on('ai:chunk', handler);
    return () => ipcRenderer.removeListener('ai:chunk', handler);
  },
  onUi: (channel: string, cb: (payload: any) => void) => {
    const handler = (_e: unknown, data: any) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
};

contextBridge.exposeInMainWorld('inkwell', api);
