# OpenPlot AI Plugin API

_Applies to OpenPlot AI 1.2.x — reviewed for 1.2.3 (2026-10-26)._

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
| `message:new` | `{ chatId, messageId, role }` | After a message is saved |
| `chat:new` | `{ chatId, title }` | When a chat is created |
| `app:ready` | `{}` | After the app finished loading |

Hooks run synchronously and in registration order. Errors thrown by one plugin are logged
and never break the other plugins, the chat or the database.

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

Skills (Settings → Skills, plus the skills chip in the composer) are `skill.md`-style
instruction packs. Only **enabled** skills are injected into a chat, as `# Active skills`
system context:

```md
## skill: Fantasy prose
Write in an elevated, sensory prose style. Avoid modern slang.
Always name locations exactly as they appear in the Story Bible.
```

Two behaviours matter when you ship a skill pack:

- A newly added skill is stored **disabled** and must be enabled by the user before it can
  change a reply. Do not assume `enabled` defaults to on.
- Skills can be switched off per chat from the composer; the chat-level opt-out wins over
  the global toggle.

The built-in skills (Continuity Guardian, Prose Polisher, Dialogue Coach, Pacing Analyst,
Beta Reader, Worldbuilding Architect) use stable ids and are seeded idempotently, so an
upgrade never duplicates or overwrites an edited built-in. Reset, rather than delete, is
the supported way to restore one.

## agent.md

Settings → agent.md holds global instructions (Markdown) injected as high-priority system
context in **every** chat. Use it for voice, style, formatting rules and hard constraints.

The default is versioned: an untouched 1.2.x default upgrades once to the newer text, while
any edited text is preserved exactly. The editor previews the compiled system prompt
(agent.md + project + skills + reply style + memory) so you can see the result before saving.

## Agent tools

When agent tools are enabled in a chat, the model can call the built-in story tools:
`save_memory`, `list_memories`, `create_story_entry`, `update_story_entry`, `search_story`,
`read_story_bible`, `read_story_file`, `create_chapter`, `update_chapter`,
`append_to_chapter`, `list_chapters`, `read_chapter`, `list_projects`, `read_project`.

Tools are executed in the main process against the same SQLite database; write tools refresh
the open views through IPC events. Plugin hooks fire for messages and chats created by the
agent, so a plugin cannot tell an AI-created chat from a user-created one.

## MCP servers

Settings → MCP Servers stores stdio JSON-RPC server definitions (`name`, `command`, `args`,
`enabled`). The bridge spawns **only enabled** servers, lists their tools and exposes them to
the model as `mcp__{server}__{tool}`, with a 30 s call timeout and a capped response size.
A stored definition alone never starts a process; enabling it is an explicit action because
MCP servers are arbitrary local commands. The bridge is implemented per
[`docs/superpowers/plans/2026-10-26-v1.2.3-studio-ux.md`](superpowers/plans/2026-10-26-v1.2.3-studio-ux.md)
(Task 13); until that lands, the registry is configuration only.

## Notes & limitations

- Plugin code runs in the **main process** — treat plugins as trusted code. `new Function`
  is a convenience boundary, not a security boundary: a plugin has the same file and network
  access as the app.
- Hooks run synchronously; long work will block. Keep handlers fast and do not await inside
  a hook.
- The plugins table also stores `enabled`; toggling it reloads the plugin registry.
- Logs are kept in a 300-line ring buffer (Settings → Plugins).
- `context.settings` values are JSON strings; parse them yourself.

## See also

- [Changelog](../CHANGELOG.md)
- [Stress test notes](STRESS_TEST.md)
- [In-app guide](../README.md#new-in-123) — shipped inside the app from 1.2.3
