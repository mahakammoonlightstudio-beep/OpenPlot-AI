---
title: Automations
summary: When this happens, do that — without writing a plugin.
order: 15
---

# Automations

An automation is a small when/then rule kept in [[settings:automations]]. When something happens in the app, every enabled rule for that event runs its action.

## Triggers

| When | Fires |
|---|---|
| App starts | once, after the window is ready |
| Chat created | a chat row was created (from the sidebar, palette, menu or the story agent) |
| Message sent | right before a request goes out, after the user turn is stored |
| AI reply received | after an assistant message is saved |
| Chapter saved | after a chapter is written to the database |
| Project created | from the project form or Plot Smith |
| Skill enabled | whenever a skill is switched on in Settings or the palette |

## Actions

| Then | Parameter |
|---|---|
| Show a toast | optional text (defaults to the automation name) |
| Flash the window | text shown with the flash |
| Write to the plugin log | — |
| Save a memory | the memory text |
| Clear all memories | — (destructive; it wipes every long-term memory) |
| Open a page | one of the app pages |
| Create a new chat | optional chat title |
| Open URL in browser | an `http(s)` address |
| Apply a skill to the next message | the skill |

## Running and checking

- **Test** runs that single rule immediately — not every rule that shares its trigger.
- Each row shows the last run (time, success, message). The **history** button lists up to 20 runs from this session.
- Run history lives in memory only; it is gone after a restart.

## Loop protection

A rule whose action re-fires its own trigger is skipped (for example *AI reply received → create a new chat → message sent*), and a chain may not nest more than two levels deep. When a guard trips, the run is recorded as skipped instead of retrying silently.

Automations are stored in the local database with the rest of your settings and are included in a full backup. Use a **plugin** when you need real code or an outside process; use **MCP** when the model itself should pick the tool.
