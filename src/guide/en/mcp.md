---
title: MCP servers
summary: Run local MCP servers and let the model call their tools.
order: 16
---

# MCP servers

MCP (Model Context Protocol) is how a model calls tools that live outside the app: a filesystem helper, a search index, a database.

## What ships

[[settings:mcp]] stores server definitions locally — name, command, arguments, environment variables and an enable flag. The bridge starts **only enabled** servers after the window is ready, speaks newline-delimited JSON-RPC 2.0 over stdio (`initialize`, `tools/list`, `tools/call`), and kills every child process on quit.

- Tools are advertised as `mcp__{server}__{tool}` and are offered only when agent tools are on for that chat. The prompt lists the exact names the server reported, never a guess.
- A tool call gets **30 seconds**, a start **10**; one response line is capped at **1 MB**, and the text handed to the model is cut at **20,000 characters** with a visible truncation note.
- Each server shows a status (starting, connected, error), its tool count, the last error and a filtered log (300 lines).

## Adding a server

1. Settings → MCP servers → **Add**, or pick one of the recommended definitions.
2. Fill the command and arguments exactly as you would type them in a terminal, for example `npx` with `["-y", "@modelcontextprotocol/server-filesystem", "D:\\Notes"]`.
3. Environment variables are a JSON object: `{"API_KEY": "…"}`.
4. Enable it. **Restart** re-runs the process; **Logs** shows what it printed.

## Safety

An MCP server is an arbitrary local command running with your permissions — the same trust level as a plugin. A stored definition never starts anything by itself; enabling it is the explicit action, and disabling it (or quitting) stops the process. Read the command before enabling, and prefer servers you wrote or audited. Use absolute paths: the process starts in the app's data directory, not in your project folder.

## Troubleshooting

- **Error on start** — run the same command in a terminal first. On Windows `npx`/`npm` are launched through `cmd.exe` automatically; other shells are not.
- **No tools** — the server answered `initialize` but listed none. Its log shows the raw lines it printed.
- **Tool fails** — the error text is returned to the model as the tool result, so it can recover instead of hanging.
