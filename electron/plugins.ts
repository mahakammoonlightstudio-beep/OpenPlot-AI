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

// SECURITY NOTE: this is a CONVENIENCE sandbox, not a security boundary.
// `new Function` runs plugin code with full Node access (fs, net, process) —
// a malicious plugin can do anything the user can. Only install plugins you
// trust; the Settings → Plugins docs should say the same. True isolation
// would require a utilityProcess/iframe split, deliberately out of scope.
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

export interface PluginLoadOptions {
  /**
   * Approval gate for the code about to run. Returning false skips the row
   * entirely, so unapproved code is never even evaluated. The main process
   * supplies this from its trust registry; omitted means "load everything".
   */
  isTrusted?: (row: { id: string; name: string; code: string }) => boolean;
}

export function loadPlugins(opts: PluginLoadOptions = {}): void {
  loaded.clear();
  try {
    const rows = handleDb('listPlugins', {}) as any[];
    for (const row of rows) {
      // A disabled plugin must not run at all. The top-level code used to be
      // evaluated before `enabled` was consulted, which made "disabled" purely
      // cosmetic: the code still ran on every start.
      if (!row.enabled) {
        log(`Plugin ${row.name || row.id} is disabled — not loaded`);
        continue;
      }
      const name = row.name || row.id;
      const code = String(row.code || '');
      if (opts.isTrusted && !opts.isTrusted({ id: row.id, name, code })) {
        log(`Plugin ${name} is not approved — not loaded`);
        continue;
      }
      try {
        const { plugin, context } = makeSandbox(row.id, name);
        plugin.enabled = true;
        // The plugin file is a script that receives a `context` object.
        // eslint-disable-next-line no-new-func
        const factory = new Function('context', `"use strict";\n${code}`);
        factory(context);
        loaded.set(row.id, plugin);
        log(`Loaded plugin ${plugin.name}`);
      } catch (e) {
        log(`Plugin ${name} failed to load: ${e}`);
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
