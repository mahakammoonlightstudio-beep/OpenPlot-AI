---
title: Plugins
summary: Local JS extensions, their hooks and their limits.
order: 14
---

# Plugins

A plugin is a local JavaScript file with hooks. Plugins run in the main process with the same access as the app: install only code you wrote or read.

## Shape
```js
module.exports = {
  name: 'word-count-logger',
  hooks: {
    'message:new': (payload, api) => api.log('message ' + payload.role)
  }
}
```

## Hooks
Fired by the app today: `chat:new` (a chat row is created) and `message:new` (a message is saved).

`app:ready`, `chat:send`, `chapter:saved`, `project:created` and `skill:enabled` belong to the plugin API but are not wired yet — treat them as planned, and fire your own hook names if you need them now.

## Behaviour
- Disabled plugins are never loaded, not loaded and then blocked.
- Errors are caught per hook and written to the plugin's log; a broken plugin does not break chat.
- A plugin registers commands with `context.registerCommand`; the row list in Settings → Plugins shows its log.

See `docs/PLUGIN_API.md` in the repository for the full surface.
