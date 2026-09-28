import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  dbCall: (op: string, payload?: any) => ipcRenderer.invoke('db', op, payload),
  generate: (req: any) => ipcRenderer.invoke('ai:generate', req),
  abort: (reqId: string) => ipcRenderer.invoke('ai:abort', reqId),
  fetchModels: (provider: any) => ipcRenderer.invoke('ai:models', provider),
  verifyModel: (provider: any, model: string, reqId?: string) => ipcRenderer.invoke('ai:verifyModel', provider, model, reqId),
  validateKey: (provider: any) => ipcRenderer.invoke('ai:validateKey', provider),
  probeCapabilities: (provider: any, model: string) => ipcRenderer.invoke('ai:probeCapabilities', provider, model),
  providerPresets: () => ipcRenderer.invoke('ai:providerPresets'),
  refreshPresets: (providers: any[]) => ipcRenderer.invoke('ai:refreshPresets', providers),
  runPlugin: (pluginId: string, command: string, payload?: any) =>
    ipcRenderer.invoke('plugins:run', pluginId, command, payload),
  listLoadedPlugins: () => ipcRenderer.invoke('plugins:list'),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  pluginLogs: () => ipcRenderer.invoke('plugins:logs'),
  // Unwrap the {ok, data} envelope: every consumer (About, Settings, tests)
  // expects the AppInfo object itself — the wrapper used to leak through and
  // made info.version / info.dataPath silently undefined.
  appInfo: () => ipcRenderer.invoke('app:info').then((r: any) => (r && r.data) ? r.data : r),
  setUnreadCount: (count: number) => ipcRenderer.invoke('ui:unreadCount', count),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  exportMarkdown: (name: string, content: string) => ipcRenderer.invoke('export:markdown', name, content),
  exportFile: (name: string, content: string, kind: 'txt' | 'md') => ipcRenderer.invoke('export:file', name, content, kind),
  // EPUB is assembled in the main process (zlib); the renderer sends chapter data.
  exportEpub: (name: string, author: string, chapters: { title: string; content: string }[]) =>
    ipcRenderer.invoke('export:epub', name, author, chapters),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  readFiles: (paths: string[]) => ipcRenderer.invoke('files:read', paths),
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
