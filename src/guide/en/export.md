---
title: Export
summary: Markdown, plain text, JSON backup and EPUB.
order: 12
---

# Export

## Chat
- **Markdown** — the whole conversation with roles and timestamps.
- **JSON** — messages plus metadata, for processing elsewhere.
- Both are available from the palette (`Ctrl+K`) and the chat header.

## Chapters and projects
A project exports as one Markdown file or an EPUB, chapters in order, with the story bible appended as an appendix when you ask for it.

## Full backup
[[settings:data]] exports everything as JSON: chats, projects, story bible, chapters, prompts, styles, skills, settings. API keys are stripped.

Restoring is a merge, not a replace: rows with the same id are updated, new rows are added, nothing is deleted.

> Export before a version upgrade. It costs one click and it is the only backup the app does not make for you.
