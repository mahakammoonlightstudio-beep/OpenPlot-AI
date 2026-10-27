---
title: Privacy and data
summary: What stays local, what is sent, and where the files are.
order: 17
---

# Privacy and data

## Local by default
Everything is stored in a SQLite file in your user data folder, shown in [[settings:data]]: chats, messages, attachments, projects, story bible, chapters, prompts, skills, settings.

No analytics, no telemetry, no account.

## What leaves the machine
Only the request you send: the system prompt (which may include agent.md, project context, skills and attached files), the conversation history, and your message. It goes directly to the provider you configured — there is no proxy in between.

Images and files are sent as text. Binary files are rejected rather than uploaded.

## API keys
Keys are stored encrypted when the OS credential vault is available; otherwise the app says so in [[settings:data]]. They never appear in exports, logs or error messages.

## Deleting
*Reset all data* deletes every row and the file contents. Backups written during a schema migration (`.bak`) stay next to the database — remove them manually for a clean slate.
