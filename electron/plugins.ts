import { handleDb } from './db';

type HookFn = (payload: any) => void;

interface LoadedPlugin {
  id: string;
  name: string;
  enabled: boolean;
  hooks: Record<string, HookFn[]>;
  commands: { name: string; fn: HookFn }[];
}

const loaded = new Map<string, LoadedPlugin>();
let notifyFn: ((msg: string) => void) | null = null;
const logs: string[] = [];

export function setNotify(fn: (msg: string) => void): void {
  notifyFn = fn;
}

export function log(msg: string): void {
  logs.push(`[${new Date().toISOString()}] ${msg}`);
  if (logs.length > 300) logs.shift();
}

export function getLogs(): string[] {
  return [...logs];
}

/**
 * Fire a hook on all enabled plugins. Errors in one hook never break the app.
 */
export function runHook(hook: string, payload: any): void {
  for (const p of loaded.values()) {
    if (!p.enabled) continue;
    for (const fn of p.hooks[hook] || []) {
      try {
        fn(payload);
      } catch (e) {
        log(`Plugin ${p.name} hook ${hook} error: ${e}`);
      }
    }
  }
}

/**
 * Wire plugin hooks to real DB events. db.ts calls the global
 * `__pluginHook` after createChat / addMessage so hooks like
 * `message:new`, `chat:new` actually fire.
 */
export function wireDbHooks(): void {
  (globalThis as any).__pluginHook = runHook;
}

function makeSandbox(id: string, name: string): { plugin: LoadedPlugin; context: any } {
  const plugin: LoadedPlugin = { id, name, enabled: true, hooks: {}, commands: [] };
  const context = {
    db: {
      call: (op: string, payload: any) => handleDb(op, payload)
    },
    settings: {
      get: (key: string) => (handleDb('getAllSettings', {}) as Record<string, string>)[key],
      set: (key: string, value: string) => handleDb('setSetting', { key, value })
    },
    toast: (msg: string) => notifyFn?.(`[plugin:${name}] ${msg}`),
    log,
    registerHook: (hook: string, fn: HookFn) => {
      if (!plugin.hooks[hook]) plugin.hooks[hook] = [];
      plugin.hooks[hook].push(fn);
    },
    registerCommand: (name: string, fn: HookFn) => plugin.commands.push({ name, fn })
  };
  return { plugin, context };
}

export function loadPlugins(): void {
  loaded.clear();
  try {
    const rows = handleDb('listPlugins', {}) as any[];
    for (const row of rows) {
      try {
        const { plugin, context } = makeSandbox(row.id, row.name || row.id);
        plugin.enabled = !!row.enabled;
        // The plugin file is a script that receives a `context` object.
        // eslint-disable-next-line no-new-func
        const factory = new Function('context', `"use strict";\n${row.code}`);
        factory(context);
        loaded.set(row.id, plugin);
        log(`Loaded plugin ${plugin.name}`);
      } catch (e) {
        log(`Plugin ${row.name || row.id} failed to load: ${e}`);
        console.error(`Plugin ${row.id} failed:`, e);
      }
    }
  } catch (e) {
    console.error('loadPlugins failed:', e);
  }
}

export function runPluginCommand(pluginId: string, commandName: string, payload: any): string {
  const p = loaded.get(pluginId);
  if (!p) return `Plugin ${pluginId} not loaded`;
  if (!p.enabled) return `Plugin ${p.name} is disabled`;
  const cmd = p.commands.find((c) => c.name === commandName);
  if (!cmd) return `Command ${commandName} not found in ${p.name}`;
  try {
    cmd.fn(payload);
    return 'ok';
  } catch (e) {
    return String(e);
  }
}

export function listLoadedPlugins(): any[] {
  return [...loaded.values()].map((p) => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    commands: p.commands.map((c) => c.name),
    hooks: Object.keys(p.hooks)
  }));
}
