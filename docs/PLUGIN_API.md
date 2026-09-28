# OpenPlot AI Plugin API

Plugins are plain JavaScript files that receive a `context` object. They run inside a
function sandbox in the Electron main process.

```js
// My first plugin
context.registerHook('message:new', (payload) => {
  context.log('AI replied in chat ' + payload.chatId);
});

context.registerCommand('hello', () => {
  context.toast('Hello from my plugin! 🎉');
});
```

## context API

| Property | Signature | Description |
|---|---|---|
| `context.db.call` | `(op, payload) => any` | Run any DB operation (same ops as the IPC `db` channel), e.g. `context.db.call('addMemory', { content: '…', source: 'my-plugin' })` |
| `context.settings.get` | `(key) => string \| undefined` | Read a stored setting (raw JSON string) |
| `context.settings.set` | `(key, value) => void` | Write a setting |
| `context.toast` | `(msg) => void` | Show a toast in the UI |
| `context.log` | `(msg) => void` | Write to the plugin log (visible in Settings → Plugins) |
| `context.registerHook` | `(name, fn) => void` | Subscribe to a hook |
| `context.registerCommand` | `(name, fn) => void` | Register a runnable command (appears in Settings → Plugins) |

## Hooks

| Hook | Payload | Fired |
|---|---|---|
| `message:new` | `{ chatId, role, content }` | After a message is saved |
| `chat:new` | `{ chatId }` | When a chat is created |
| `app:ready` | `{}` | After the app finished loading |

## Example: auto-log every AI reply

```js
context.registerHook('message:new', (p) => {
  if (p.role === 'assistant') {
    const msgs = context.db.call('getMessages', { chatId: p.chatId });
    context.log(`chat has ${msgs.length} messages now`);
  }
});
```

## Example: writing skill files

Skills (Settings → Skills) are `skill.md`-style instruction packs. When enabled, they are
injected into every chat as `# Active skills` system context:

```md
## skill: Fantasy prose
Write in an elevated, sensory prose style. Avoid modern slang.
Always name locations exactly as they appear in the Story Bible.
```

## agent.md

Settings → agent.md holds global instructions (Markdown) injected as high-priority system
context in **every** chat. Use it for voice, style, formatting rules and hard constraints.

## Notes & limitations

- Plugin code runs in the **main process** — treat plugins as trusted code.
- Hooks run synchronously; long work will block. Keep handlers fast.
- The plugins table also stores `enabled`; toggling it re-runs `loadPlugins()` on next save.
- MCP servers (Settings → MCP Servers) are a registry for stdio JSON-RPC tool servers;
  full MCP handshake/tool-bridge is on the roadmap.
