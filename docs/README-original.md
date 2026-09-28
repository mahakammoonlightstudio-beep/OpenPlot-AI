# OpenPlot AI

**A local-first AI chat & story-writing studio for Windows, Linux and macOS.**

OpenPlot AI is a desktop app (Electron + React + SQLite) that connects to *any* AI provider —
OpenAI, Anthropic Claude, OpenRouter, Groq, Ollama, LM Studio, or any OpenAI-compatible `/v1`
endpoint — and pairs it with a full **story-building suite**: worlds, locations, characters,
items, lore, chapters and long-term memory. Everything is stored **on your laptop**.

> Support development: **[saweria.co/MahakamMoonStudio](https://saweria.co/MahakamMoonStudio)**

Formerly known as **InkWell**.

---

## Features

### Chat
- **Prompt Library** — type `/` in the composer for curated writing prompts (craft, story bible, revision, chat) with `{placeholder}` templates
- Multi-provider, multi-model — pick any model from any connected provider per chat
- Streaming responses, **thinking / reasoning display** (Anthropic extended thinking, DeepSeek-style `reasoning`, `<think>` tags)
- **Agent tools** — the AI can save memories, create/update/search story entries and chapters natively
- Markdown + syntax-highlighted code blocks with copy buttons
- Edit & resend, regenerate last reply, delete messages, export chat to `.md`
- Per-chat **advanced settings**: system prompt, temperature, max tokens, top-p, thinking toggle + budget, tools toggle, memory toggle, project binding

### Story Bible (made for storytellers)
- **World**, **Location**, **Character**, **Item** and **Lore** entries with tags
- Chapters with status (draft / revising / done) and word count
- "Ask AI about this", "Continue writing with AI", "Ask AI to critique" — the agent reads and *updates* your bible via its tools

### Organization
- **Folders** for chats (collapsible), **Projects** with always-visible context
- Full-text search over chats, command palette (`Ctrl/Cmd+K`)
- Menu accelerators: `Ctrl+N` new chat, `Ctrl+Shift+N` new project, `Ctrl+,` settings

### Memory
- Manual memories + auto-memory (the agent saves facts via the `save_memory` tool)
- Injected into every chat, manageable in Settings → Memory

### Extensibility
- **agent.md** — Markdown instructions injected into every chat
- **skills** (skill.md-style packs) — reusable instruction sets
- **Plugins** — sandboxed JS with hooks (`message:new`, `chat:new`, `app:ready`) and commands (see [docs/PLUGIN_API.md](PLUGIN_API.md))
- **Automations** — when/then rules on app events
- **MCP servers** registry — register stdio tool servers (JSON-RPC)

### Appearance
- **10 themes** (Dark Classic, Midnight Ink, Nord, Dracula, Solarized, Forest, Rose Dawn, Ocean, Sepia, Light Paper)
- English (default) + Bahasa Indonesia
- **10 accent colors** + adjustable chat font size

### Local and private
- All data in SQLite at your OS user-data folder — no cloud, no telemetry
- API keys **encrypted at rest** with your OS credential vault (DPAPI / Keychain / libsecret) when available

---

## Getting started

```bash
npm install        # install dependencies
npm run dev        # dev mode (Vite + Electron hot reload)
```

### Production build and packaging

```bash
npm run build              # build renderer + main process
npm start                  # run the built app

npm run dist:win           # Windows installer (NSIS)
npm run dist:linux         # Linux AppImage + deb
npm run dist:mac           # macOS dmg
```

## Connect your first provider

1. **Settings → AI Providers → Add provider**
2. Base URL examples:
   - OpenAI: `https://api.openai.com/v1`
   - Anthropic: `https://api.anthropic.com/v1`
   - OpenRouter: `https://openrouter.ai/api/v1`
   - Ollama: `http://localhost:11434/v1`
   - LM Studio: `http://localhost:1234/v1`
   - Groq: `https://api.groq.com/openai/v1`
3. Paste your API key → **Fetch models** → pick a model in the chat header → chat!

## Project structure

```
electron/          main process: db, ai engine, tools, plugins, IPC
src/               React renderer
  components/      ChatView, StoryBible, Chapters, Settings, Sidebar, …
docs/              plugin API & skills reference
```

## License

MIT — © MahakamMoonStudio
