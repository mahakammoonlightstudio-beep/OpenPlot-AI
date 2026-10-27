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
