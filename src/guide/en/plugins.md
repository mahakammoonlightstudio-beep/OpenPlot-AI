---
title: Plugins
summary: Local JS extensions, their hooks and their limits.
order: 14
---

# Plugins

A plugin is a local JavaScript snippet stored in the app and executed in the main process. Plugins run with the same access as the app: install only code you wrote or read.

## Shape
```js
context.registerHook('message:new', (payload) => {
  context.log('New message in chat ' + payload.chatId);
});
context.registerCommand('hello', () => {
  context.toast('Hello from my plugin!');
});
```

## Hooks
Fired by the app: `app:ready` (window ready), `chat:new` (a chat row is created), `message:new` (a message is saved — user, assistant or error).

Errors thrown by one handler are caught and written to that plugin's log; a broken plugin never breaks chat or the database.

## Commands
`context.registerCommand(name, fn)` adds a command that runs on demand:

- listed on the plugin's row in Settings → Plugins, with a button per command;
- searchable in the command palette (`Ctrl/Cmd+K`) as *plugin name: command*.

**Reload all plugins** re-reads every enabled plugin from the database after you edit code, so there is no restart. Save from the editor does the same automatically.

## Safety
- A disabled plugin is never loaded — not loaded and then blocked.
- Plugin code can read files, reach the network and write the database. `new Function` is a convenience boundary, not a security boundary.
- Keep hooks fast: they run synchronously on the main process.

See `docs/PLUGIN_API.md` in the repository for the full `context` surface.

If you only need "on this event, do that" without writing code, use **automations** instead — same triggers, ready-made actions.
