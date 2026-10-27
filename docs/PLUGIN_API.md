# OpenPlot AI Plugin API

_Applies to OpenPlot AI 1.2.x — reviewed for 1.2.3 (2026-10-27)._

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
| `context.registerCommand` | `(name, fn) => void` | Register a runnable command (appears in Settings → Plugins **and** the command palette) |

## Hooks

| Hook | Payload | Fired |
|---|---|---|
| `message:new` | `{ chatId, messageId, role }` | After a message is saved |
| `chat:new` | `{ chatId, title }` | When a chat is created |
| `app:ready` | `{}` | After the app finished loading |

Hooks run synchronously and in registration order. Errors thrown by one plugin are logged
and never break the other plugins, the chat or the database.

Those three are the complete hook list: events such as “message sent”, “chapter saved”,
“project created” and “skill enabled” are automation triggers, not plugin hooks — see
[Automations](#automations). A plugin that needs one can register a command and let an
automation toast, or poll with `context.db.call`.

## Commands

Registered commands are listed per plugin in Settings → Plugins (one button each) and are
searchable in the command palette (`Ctrl/Cmd+K`) as *plugin name: command*. **Reload all
plugins** — a button in Settings and an IPC call (`reloadPlugins`) — re-reads every enabled
plugin from the database, so editing code needs no app restart.

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

Settings → MCP servers stores stdio JSON-RPC server definitions (`name`, `command`, `args`,
`env`, `enabled`). The bridge spawns **only enabled** servers after the window is ready,
performs `initialize` + `tools/list`, and exposes their tools to the model as
`mcp__{server}__{tool}`. Limits: 10 s to start, 30 s per call, 1 MB per response line and
20,000 characters per result handed to the model (with a truncation note). Every child is
killed on quit, on restart and on a failed start; each server keeps a 300-line log.

A stored definition alone never starts a process — enabling it is an explicit action,
because an MCP server is an arbitrary local command with your permissions (same trust
level as a plugin). MCP tools are advertised only when agent tools are enabled for the
chat, and the prompt lists the exact tool names the server reported.

## Automations

Automations are the declarative sibling of plugins: a row stores `trigger`, `action`,
`param` and `enabled` in the `automations` table.

Triggers: `app:ready`, `chat:new`, `chat:send`, `message:new`, `chapter:saved`,
`project:created`, `skill:enabled`.
Actions: `toast`, `notify`, `log`, `addMemory`, `clearMemory`, `navigate`, `newChat`,
`openExternal`, `runSkill`.

Guards, in the renderer (`runAutomations`): a chain may not nest deeper than two levels, and
an action that would re-fire its own trigger is skipped and recorded as such. Each run is
recorded in a session-only log (20 entries per automation) surfaced in Settings →
Automations, where **Test** runs exactly one rule.

## Notes & limitations

- Plugin code runs in the **main process** — treat plugins as trusted code. `new Function`
  is a convenience boundary, not a security boundary: a plugin has the same file and network
  access as the app.
- Hooks run synchronously; long work will block. Keep handlers fast and do not await inside
  a hook.
- The plugins table also stores `enabled`; toggling it (or **Reload all plugins**) reloads the plugin registry.
- Logs are kept in a 300-line ring buffer (Settings → Plugins).
- `context.settings` values are JSON strings; parse them yourself.

## See also

- [Changelog](../CHANGELOG.md)
- [Stress test notes](STRESS_TEST.md)
- [In-app guide](../README.md#new-in-123) — shipped inside the app from 1.2.3
