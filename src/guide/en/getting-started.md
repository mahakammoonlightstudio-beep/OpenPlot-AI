---
title: Getting started
summary: Install, add one API key, send your first message.
order: 1
---

# Getting started

OpenPlot AI is a local-first chat and story studio. Your chats, projects, story bible and settings live in one SQLite file on your machine — only the model request leaves the app.

## 1. Add a provider
Open [[settings:providers]] and either use **Smart setup** (pick a preset → paste a key → test) or add a provider manually.

Every provider row needs:
- **Base URL** — the API root, for example `https://api.openai.com/v1`.
- **API key** — stored encrypted when your OS vault is available.
- **Models** — fetched with *Test & fetch*, or typed by hand.

## 2. Pick a model
Settings → [[settings:models]] lists every model with its capability chips. Choose one as the default, or leave **Auto (recommended)** and let each chat decide.

## 3. Start a chat
`Ctrl+N` creates a chat. Type, press `Enter` to send, `Shift+Enter` for a new line. `Ctrl+K` opens the command palette from anywhere.

## 4. Give it a project (optional)
A project holds a story bible, chapters and a context block. Attach a project to a chat and the model sees your canon instead of guessing.

> Continue with the chat, files, skills and story bible articles, in that order.
