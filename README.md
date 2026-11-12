<div align="center">

<img src="docs/og-image.png" alt="OpenPlot AI — a local-first story studio" width="860" />

# OpenPlot AI

**Your story deserves a studio, not five browser tabs.**

A free, open-source, local-first AI writing studio for Windows, macOS and Linux.
Chat with any model, keep your canon in a structured story bible, outline in
three acts, write chapters, and watch the book grow — in one desktop window.

[**Download the latest release**](https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases/latest) ·
[Website](https://mahakammoonlightstudio-beep.github.io/OpenPlot-AI/) ·
[Changelog](CHANGELOG.md) ·
[Security](SECURITY.md) ·
[Contributing](CONTRIBUTING.md)

[![Release](https://img.shields.io/github/v/release/mahakammoonlightstudio-beep/OpenPlot-AI?style=flat-square)](https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/mahakammoonlightstudio-beep/OpenPlot-AI/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/mahakammoonlightstudio-beep/OpenPlot-AI?style=flat-square)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/mahakammoonlightstudio-beep/OpenPlot-AI/total?style=flat-square&logo=github)](https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white&style=flat-square)
![Local-first](https://img.shields.io/badge/local--first-no%20telemetry-2ea043?style=flat-square)

</div>

---

## The room where the book happens

Most AI writing tools give you a chat box and hope. OpenPlot AI gives the model
your actual story — and gives you the room to shape it.

| | |
| --- | --- |
| **One window, one project** | Chat, story bible, outline board, chapters and statistics share the same project. No copy-pasting canon between tabs, no “which doc has the latest version?” |
| **Canon that is data, not a prompt** | Worlds, locations, characters, items and lore are real records with tags, links and reference files. The agent reads all of it with native tools. |
| **The model you already pay for** | OpenAI, Anthropic, OpenRouter, Groq, Ollama, LM Studio, or any OpenAI-compatible `/v1` endpoint. One provider card per service, any model per chat. |
| **Local by default** | SQLite on your disk, keys in the OS credential vault, no account, no cloud sync, no telemetry. The renderer cannot even open a socket. |

## Screenshots

_Captured from a demo workspace using a local mock provider._

<table>
  <tr>
    <td colspan="2">
      <img src="docs/showcase/14-home.png" alt="Home screen with a time-based greeting, quick starts, recent chats and model health" />
      <sub><b>Home first.</b> A greeting that follows the clock, four quick starts, recent chats and the live model-health strip.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/showcase/01-chat.png" alt="Chat with streaming replies, model health, reasoning and token counts" />
      <sub><b>Chat that stays out of the way.</b> Streaming replies, reasoning display, agent tools, per-message tokens and model health.</sub>
    </td>
    <td width="50%">
      <img src="docs/showcase/02-story.png" alt="Story Bible entries with tags, categories and reference files" />
      <sub><b>Canon you can browse.</b> Structured Story Bible entries with tags, links and attached reference files.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/showcase/03-chapters.png" alt="Chapter editor with statuses, word counts and version history" />
      <sub><b>Write where the book lives.</b> Draft, revise and finish chapters with version history and a scene board.</sub>
    </td>
    <td width="50%">
      <img src="docs/showcase/04-flow.png" alt="Three-act story flow board with beats linked to chapters" />
      <sub><b>The shape of the story.</b> A three-act board of beats you can link to chapters and move between acts.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/showcase/06-stats.png" alt="Writing statistics with daily goal, streaks, heatmap and project totals" />
      <sub><b>Progress you can see.</b> Daily goal, streaks, weekly totals, a 90-day heatmap and per-project progress.</sub>
    </td>
    <td width="50%">
      <img src="docs/showcase/11-theme-light-paper.png" alt="The light-paper theme" />
      <sub><b>Light or dark, your call.</b> Follows your system by default, with 14 themes and 10 accents in English or Bahasa Indonesia.</sub>
    </td>
  </tr>
</table>

## New in 1.3.0

**One studio, many libraries — and a faster way to move around it.**

- **Separate libraries.** **Settings → Data** lists every library in your profile
  with its schema and size, and switches with a restart. Import a portable `.db`
  without touching the source, or start a new, empty one.
- **Library Time Machine.** Up to 12 whole-library snapshots per library:
  before a migration, import, reset or restore, plus one daily and any manual
  copy. Restore confirms, snapshots the current state first, then restarts into
  the chosen copy.
- **Portable library export.** One `.db` carries chats, projects, canon,
  chapters, attachments, prompts, styles, skills and settings to another
  machine. Provider keys, the web-search key, MCP environment variables and
  execution approvals stay behind.
- **Quick switch.** `Ctrl/Cmd+P` opens a chats-and-projects palette from
  anywhere: every chat is searchable, results name their project, and the
  current chat and project lead the list.
- **Revision Timeline.** Chapter snapshots and passages displaced by AI edits
  in one newest-first timeline, with a word-level before/after diff and a
  one-click restore that is itself undoable.
- **Skill Lab.** Categories for Chat, Agent and Writing desks, a full
  instruction inspector, a live preview of the prompt block, a 12,000-character
  budget, and duplicate/overlap/tension warnings.
- **Appearance controls.** Follows your system light/dark preference by
  default, plus a font stack, whole-UI zoom, comfortable/compact density and
  corner radius — applied immediately and stored locally.

[Full changelog →](CHANGELOG.md)

## What the studio does

### Chat

- **Multi-provider, multi-model.** Pick a different model for every chat, with
  streaming replies, reasoning traces, per-message tokens and a model-health
  strip.
- **Reply styles.** Builtin personas (Default, Concise, Explanatory, Editorial,
  Empathetic, Formal) or your own, injected as a system fragment.
- **Agent tools.** The model can read the whole Story Bible in one call, search
  entries, create or update canon, write and append chapters, and save
  memories — with write actions refreshing the Bible immediately.
- **A prompt library.** `/` templates with `{placeholders}`, `@`-mentions that
  expand entries and chapters into context, edit-and-resend, regenerate,
  delete, and Markdown export.
- **Files in the chat.** Attach up to 8 files per message; they become cards
  you can read before sending, stay in the transcript, and open in a popup
  after a restart.
- **Context guard.** Old turns are trimmed from the request when a chat exceeds
  the model's window; nothing is deleted from the transcript.

### Canon and writing

- **Story Bible** — worlds, locations, characters, items and lore with tags,
  cross-links, full-text search, per-category counts, reference files and bulk
  import from Markdown, JSON or CSV.
- **Chapters** — draft / revising / done, reading-order reordering, focus mode,
  a scene board, and version history (snapshots on save, before an AI append
  and before a restore; the last 30 are kept).
- **Story Flow** — a three-act board of beats linked to chapters.
- **Plot Smith** — a guided four-step story agent (brief → premises → cast &
  world → three-act outline) that can create the whole project in one click.
- **Writing statistics** — daily goal, current and best streak, weekly totals, a
  90-day heatmap, per-project stakes and an AI arc analysis.

### Extensions — with a gate

- **Skills.** Six builtin skills (Continuity Guardian, Prose Polisher, Dialogue
  Coach, Pacing Analyst, Beta Reader, Worldbuilding Architect) plus your own.
  A new skill starts disabled; switch any skill off per chat.
- **Plugins.** JavaScript lifecycle hooks and palette commands, with full Node
  access. They run only after you approve that exact code.
- **MCP bridge.** Enabled stdio servers are spawned, handshaken, listed and
  callable as `mcp__{server}__{tool}`, with status, restart and logs. An MCP
  definition is an arbitrary local command — it runs only after approval.
- **Automations.** Seven triggers and nine actions with per-row **Test**, a run
  history and loop guards.

## Bring your own model

| Provider | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |

Open **Settings → AI Providers → Add provider**, paste the key, run **Fetch
models**, then choose a model in the chat header. Ollama and LM Studio need no
key. A `404 model not found` from the model list still counts as a valid key, so
hosted gateways that reject probe models work too.

## Install

Prebuilt binaries for **v1.3.0** are attached to the
[GitHub releases](https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases).
Each platform has a full installer/app and a portable folder build.

| Platform | Full app | Folder |
| --- | --- | --- |
| Windows | `OpenPlot.AI.Setup.1.3.0.exe` (NSIS installer) | `OpenPlot.AI-1.3.0-win.zip` |
| macOS | `OpenPlot.AI-1.3.0-universal.dmg` (universal) | `OpenPlot.AI-1.3.0-universal-mac.zip` / `OpenPlot.AI-1.3.0-arm64-mac.zip` |
| Linux (x64) | `OpenPlot.AI-1.3.0.AppImage` | `openplot-ai-1.3.0.tar.gz` |
| Linux (arm64) | `OpenPlot.AI-1.3.0-arm64.AppImage` | `OpenPlot.AI-1.3.0-arm64.tar.gz` |

The macOS disk image and the main macOS zip are universal (Intel + Apple
silicon); the `arm64-mac.zip` is smaller and Apple-silicon only.

Every Linux AppImage release also ships a matching `.zsync` file for
[AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate) delta
downloads.

## Build from source

Requirements: **Node.js 18+** and npm.

```bash
npm install          # install dependencies
npm run dev          # Vite + Electron, hot reload
npm run typecheck    # TypeScript, no emit
npm run build        # renderer bundle + main-process compile
npm start            # run the built app
npm test             # headless suite
npm run test:e2e     # headless + GUI end-to-end

npm run dist:win     # Windows NSIS + zip
npm run dist:linux   # Linux x64 AppImage + tar.gz
npm run dist:mac     # macOS dmg + zip
```

The release workflow also cross-builds Linux **arm64** AppImage and tarball
(`OpenPlot.AI-<version>-arm64.*`); `npm run dist:linux` locally stays x64.

macOS builds are signed with the hardened runtime and notarized automatically
when the repository has `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets. Without them the
macOS build is unsigned and Gatekeeper asks you to open it once.

DevTools stay closed in development; set `OPENPLOT_DEVTOOLS=1` to open them.

## Tests

`npm test` runs the headless group — mock HTTP servers and temp SQLite
databases, no GUI, no real keys. It rebuilds `dist-electron` when
`electron/*.ts` is newer than the build output.

```bash
npm test                                  # headless (~2 min)
npm run test:e2e                          # + Vite/Electron GUI groups
node scripts/run-all-tests.mjs --list     # list every group
node scripts/run-all-tests.mjs --include=e2e-attach   # drive a RUNNING app (:9222)
```

| Group | What it covers |
| --- | --- |
| `headless` | DB and migrations, engine and parsers, tools, prompt assembly, guide, MCP, security, approvals, perf and bundle budgets, fuzz |
| `e2e-local` | boots its own Vite + Electron in an isolated profile: chat/tools/prompts, keyboard focus, studio UX, hostile-markdown XSS |
| `e2e-attach` | drives an already-running dev app over CDP (skipped when it is not running) |
| `manual` | real installed app / real profile / packaged build; only with an explicit flag |

## Project map

```text
electron/          main process: database, providers, tools, plugins, MCP,
                   files, images, approvals, IPC
src/               React renderer
  components/      one file per view + chat/ and settings/ subfolders
  lib/             pure testable logic (prompt, imports, paging, progress)
  guide/           bundled English + Indonesian handbook
  styles/          ordered CSS partials
scripts/           headless, UI-render, GUI and end-to-end tests
docs/              plugin API, handbook, stress notes, showcase screenshots
```

Every file, what it owns, and the invariants that keep it safe are listed in
[CONTRIBUTING.md](CONTRIBUTING.md#file-map). Read that before renaming or moving
something under `electron/`.

## Privacy and security

OpenPlot AI stores its database in the OS user-data path
(`%APPDATA%/openplot-ai` on Windows, `~/Library/Application Support/openplot-ai`
on macOS, `~/.config/openplot-ai` on Linux). Uninstalling does not delete it;
**Settings → Data** can reset everything, including memories and chapters.

Provider API keys and the web-search key are encrypted at rest with the OS
credential vault when available (DPAPI, Keychain or libsecret). The web-search
key is also redacted from every renderer reply; the UI learns only that a key is
stored. There is no account, no analytics and no background update ping.
Attachments are read only through grants, `web_fetch` refuses private addresses
both by hostname and by the DNS answer it actually connects to, and plugins/MCP
run only after explicit approval.

Portable library copies deliberately strip provider keys, the web-search key,
MCP environment variables and stored execution approvals. See
[SECURITY.md](SECURITY.md#data-at-rest) for the full boundary.

The full threat model, scope, hardening details and disclosure timeline are in
[**SECURITY.md**](SECURITY.md). To report a vulnerability, email
[mr.fauzan121314@gmail.com](mailto:mr.fauzan121314@gmail.com) — please do not
open a public issue.

## Documentation

- [Security policy](SECURITY.md)
- [Contributing and file map](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Plugin API](docs/PLUGIN_API.md)
- [Handbook](docs/HANDBOOK.md) · [Panduan (ID)](docs/HANDBOOK.id.md)
- [Stress test notes](docs/STRESS_TEST.md)

## License

[MIT](LICENSE) — Mahakam Moonlight Studio.

## Support

Development is funded through
[PayPal](https://www.paypal.com/paypalme/mrfozan),
[SociaBuzz](https://sociabuzz.com/mahakam_moonlight_studio/tribe) and
[Saweria](https://saweria.co/MahakamMoonStudio). Starring the repo, filing a
clear bug report and telling another writer about it help just as much.
