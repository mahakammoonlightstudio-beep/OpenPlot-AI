---
title: MCP servers
summary: What the stored server definitions do today, and what they will do next.
order: 15
---

# MCP servers

MCP (Model Context Protocol) is how a model calls tools that live outside the app: a filesystem helper, a search index, a database.

## Status in this version

[[settings:mcp]] stores server definitions locally — name, command, arguments, environment variables and an enable flag. **The bridge that starts those processes, lists their tools and exposes them to the model is not part of this version.** A stored definition never runs anything; enabling one is configuration for the release that ships the bridge.

The plan, and the protocol details, live in `docs/PLUGIN_API.md` and the release plan under `docs/superpowers/plans/`.

## What you can do today

- Keep the registry ready: add the servers you want, with the exact command and arguments, so enabling them later is one switch.
- Read the command before saving it. An MCP server runs as a local process with your permissions; treat a definition like a script you are about to run.

## What the bridge will do

- Spawn only enabled servers, after the window is ready, and kill them on quit.
- Speak newline-delimited JSON-RPC 2.0 over stdio: `initialize`, `tools/list`, `tools/call`.
- Advertise their tools as `mcp__{server}__{tool}` when tools are enabled, with a call timeout and a capped response size.
- Show a status dot per server (starting, connected, error), the tool count, the last error and a filtered log.

Until then, the app's own story tools are the ones the model can actually call — see the skills and story bible articles.
