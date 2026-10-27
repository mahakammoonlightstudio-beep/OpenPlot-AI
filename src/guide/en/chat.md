---
title: Chat basics
summary: Sending, stopping, regenerating and per-chat overrides.
order: 2
---

# Chat basics

## Sending
- `Enter` sends; `Shift+Enter` inserts a newline.
- The composer grows to about eight lines, then scrolls.
- `Esc` closes the model or skills popover.

## Stopping and regenerating
While a reply streams the send button becomes **Stop**. Stopping keeps the partial text — it is a real message, not a discard.

**Regenerate** re-runs the last assistant turn. The previous reply stays in the message menu so you can compare.

## Per-chat overrides
The header shows the model, the token meter and the project chip. Each chat keeps its own:
- model and temperature override,
- system prompt (replaces the global one for this chat only),
- thinking setting and budget,
- session goal — a pinned instruction injected into every prompt,
- per-chat skill opt-outs.

## Organising
- **Folders** group chats in the sidebar; move a chat into a folder from its menu.
- **Pin** keeps a chat at the top.
- **Rename** from the chat row or the header.
- Deleting a chat deletes its messages and attached files. There is no undo — export from [[settings:data]] first if the chat matters.

## What the model actually sees
Open [[settings:agentmd]] and press **Preview prompt** to inspect the exact system prompt for your next message: system, agent.md, project, memory, skills, goal, style, tools, attachments.
