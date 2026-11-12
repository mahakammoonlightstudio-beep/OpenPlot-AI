---
title: Export
summary: Markdown, plain text, EPUB and a portable whole library.
order: 12
---

# Export

## Chat
- **Markdown** — the whole conversation with roles and timestamps.
- **JSON** — messages plus metadata, for processing elsewhere.
- Both are available from the palette (`Ctrl+K`) and the chat header.

## Chapters and projects
A project exports as one Markdown file or an EPUB, chapters in order, with the story bible appended as an appendix when you ask for it.

## Full library
[[settings:data]] → **Export portable copy** writes one `.db` holding every chat, project, story-bible entry, chapter, attachment, prompt, style, skill and setting. On another machine, use **Import .db** and press **Use** to open it.

Several things deliberately stay behind: provider API keys and the web-search key (the OS credential vault ties them to this machine, so re-enter them after importing), MCP environment variables (often tokens), and stored plugin/MCP execution approvals. Time Machine snapshots are not part of the file either.

> This is a copy, not a sync. Importing adds a separate library and never merges into or overwrites the one you have open.

> Export before a version upgrade. It costs one click and it is the only backup the app does not make for you.
