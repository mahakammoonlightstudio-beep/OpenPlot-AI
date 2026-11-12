# Contributing to OpenPlot AI

Thanks for wanting to work on this. OpenPlot AI is a small, local-first Electron
app: a React renderer, a main process that owns the database and every outbound
request, and a narrow preload bridge between them.

This guide is written for someone who just cloned or forked the repo and does
not want to break the parts that are load-bearing. Read the map before you move
a file.

- [Set up](#set-up)
- [The shape of the app](#the-shape-of-the-app)
- [File map](#file-map)
- [Where do I change X?](#where-do-i-change-x)
- [Rules you should not break](#rules-you-should-not-break)
- [Tests](#tests)
- [Commits, pull requests and releases](#commits-pull-requests-and-releases)
- [Security reports](#security-reports)

## Set up

Requirements: **Node.js 18+**, npm, and a desktop session (Electron needs a
display; the headless tests do not).

```bash
npm install
npm run dev          # Vite on :5173 + Electron with hot reload
npm run typecheck    # renderer TypeScript, no emit
npm test             # headless suite (~2 min on a slow disk)
npm run test:e2e     # headless + Vite/Electron end-to-end groups
npm run build        # renderer bundle + main-process compile
```

`npm run dev` does not open DevTools; set `OPENPLOT_DEVTOOLS=1` if you want them.

Useful environment variables (all optional):

| Variable | Effect |
| --- | --- |
| `INKWELL_DEV=1` | Load the renderer from the Vite dev server |
| `OPENPLOT_DEV_URL` | Use a dev server on another port (test harnesses) |
| `OPENPLOT_DATA_DIR` | Isolate the profile (tests use a temp directory) |
| `OPENPLOT_DEVTOOLS=1` | Open DevTools on launch |
| `OPENPLOT_WEB_ALLOW_LOCAL=1` | Test-only SSRF bypass, read once at load |

## The shape of the app

Three processes, one bridge:

```
renderer (src/)  --window.inkwell.*-->  preload (electron/preload.ts)
                                              |
                                              v
                                    main process (electron/*.ts)
                                    database, providers, tools,
                                    plugins, MCP, files, images
```

- The **renderer** never touches Node, the filesystem or the network. It asks
  the main process over `window.inkwell`.
- The **preload** is the only bridge. It exposes a fixed list of methods and
  unwraps the `{ ok, data }` / `{ ok, error }` envelope.
- The **main process** validates every IPC call, owns SQLite (`sql.js`), makes
  all outbound HTTP requests, and gates plugins/MCP behind explicit approval.
- The **database** lives in the OS user-data directory. Schema changes are
  versioned migrations, never ad-hoc `ALTER TABLE` in a `try/catch`.

## File map

### Main process — `electron/`

| File | What it owns | Touch it when… |
| --- | --- | --- |
| `main.ts` | App lifecycle, window, menu, every IPC handler, provider/chat/export flows, plugin/MCP gate wiring, approval list/revoke | Adding an IPC channel or app-level behaviour |
| `preload.ts` | The `window.inkwell` API (the renderer's only door) | You add/rename an IPC method (update `src/types.ts` too) |
| `db.ts` | `sql.js` database, schema + versioned migrations, CRUD operations dispatched by `handleDb`, secret encryption and `settingSecret` | Adding a table/column, a DB operation, or migration |
| `settingsPrivacy.ts` | The IPC redaction boundary for settings credentials | Adding a secret-bearing setting |
| `libraryExport.ts` | Portable `.db` naming, target checks and staging-file writes | Changing library export |
| `snapshots.ts` | Snapshot names, retention, listing and restore copies | Changing Time Machine |
| `ai.ts` | Provider requests, SSE parsing, streaming, model listing, key/model probes | Changing how a provider is called |
| `caps.ts` | Capability inference (context window, reasoning, cache) and the persisted registry | Changing capability heuristics |
| `presets.ts` | Built-in provider presets and URL refresh | Adding a provider preset |
| `tools.ts` | Agent tools the model can call (story bible, chapters, memory, projects) | Adding/changing an agent tool |
| `prompt.ts` (in `src/lib`) | System-prompt assembly used by both sides | Changing what the model is told |
| `plugins.ts` | Plugin loader (`new Function`, explicitly not a sandbox), approval check, lifecycle hooks, commands, logs | Changing the plugin API |
| `mcp.ts` | MCP stdio bridge: spawn, handshake, tool calls, limits, teardown | Changing MCP behaviour |
| `trust.ts` | Pure approval store: hashing, parsing, stale/orphan listing, revoke | Changing how approvals are matched |
| `fileaccess.ts` | Attachment grants, realpath/symlink checks, sensitive-path and private-root refusal, bounded reads | Changing file access rules |
| `webtools.ts` | `web_search` / `web_fetch`, SSRF host + DNS guards, redirects, `settingSecret` for the search key | Changing outbound web research |
| `images.ts` | Remote-image proxy: host + DNS checks, redirects, raster-only, streaming size/time caps | Changing how Markdown images load |

### Renderer — `src/`

| Path | What it owns |
| --- | --- |
| `main.tsx` | React root, store exposed for the CDP tests |
| `App.tsx` | Routing, global key handlers, layout, toasts, "what's new" mount |
| `store.ts` | Zustand stores (`useData`, `useSettings`, `useUi`), `dbCall` helper, navigation, toasts |
| `types.ts` | Shared types, including the `window.inkwell` contract |
| `i18n.ts` | English + Indonesian dictionaries (both must be updated) |
| `i18nReact.ts` | `useT()` hook |
| `markdown.tsx` | Markdown → sanitised HTML (DOMPurify), highlight cache |
| `components/` | One file per view/major surface (see below); `CommandPalette.tsx` owns quick switch and the command palette |
| `components/settings/` | One file per Settings section + `TrustList` + `SmartSetupCard` |
| `components/chat/` | Message bubble, streaming bubble, tool log, welcome screen, save-chapter modal |
| `lib/` | Pure, testable logic (no React, no Electron), including `shortcuts.ts` |
| `guide/en/`, `guide/id/` | Bundled handbook articles (`?raw` imports, one article per slug) |
| `styles/` | Ordered CSS partials; `styles.css` imports them in order |

### Everything else

| Path | What it is |
| --- | --- |
| `scripts/` | Every test, the release helper, screenshot/visual harnesses |
| `scripts/lib/` | Shared test harness modules (CDP, mock providers, render entry) |
| `docs/` | Plugin API, handbook, stress notes, showcase screenshots, plans |
| `.github/workflows/` | CI (`ci.yml`) and tagged-release builds (`release.yml`) |
| `build/` | App icons and installer assets |
| `dist/`, `dist-electron/` | Build output (never edit, never commit) |

## Where do I change X?

| I want to… | Start here |
| --- | --- |
| Add a settings control | the matching `src/components/settings/*Section.tsx`, then `src/types.ts` (if it is persisted) and `src/lib/settingsIndex.ts` (search/grouping) |
| Add a settings section | `src/components/SettingsView.tsx`, `src/lib/settingsIndex.ts`, `src/i18n.ts` (en + id) |
| Add a chat action | `src/components/ChatView.tsx` / `Composer.tsx`, then the store |
| Change the assistant's prompt | `src/lib/prompt.ts`, then `scripts/prompt-test.mjs` |
| Add an agent tool | `electron/tools.ts` (schema + handler), `src/lib/toolProgress.ts` (label), tests in `scripts/tools-test.mjs` |
| Add an IPC channel | `electron/main.ts` (`secureHandle`), `electron/preload.ts`, `src/types.ts` |
| Add a database column | `electron/db.ts` migration list + `SCHEMA_VERSION`, then the read/write ops |
| Add a provider preset | `electron/presets.ts` |
| Change plugin behaviour | `electron/plugins.ts` + `docs/PLUGIN_API.md` |
| Change MCP behaviour | `electron/mcp.ts` + `scripts/mcp-test.mjs` |
| Add a guide article | `src/guide/en/<slug>.md` **and** `src/guide/id/<slug>.md`, then `src/guide/index.ts` |
| Change theming | `src/styles/_theme.css` tokens first, then the partial that uses them |
| Add a user-visible string | `src/i18n.ts` — both dictionaries, same keys |
| Touch approvals | `electron/trust.ts`, `electron/main.ts` (`trust:*`), `src/components/settings/TrustList.tsx` |

## Rules you should not break

These are the invariants the app and its tests rely on. A change that violates
one is a regression even if the UI looks fine.

1. **The renderer never talks to the network.** No `fetch`, `XMLHttpRequest`,
   WebSocket or remote `<img src>` from `src/`. Every request goes through
   `window.inkwell` to main. The production CSP has `connect-src 'none'`.
2. **Do not loosen the CSP** (`vite.config.ts`). Images are
   `'self' data: blob:`; remote images arrive as `data:` URLs from the main
   process. There is no `unsafe-eval` in the build.
3. **Every IPC handler validates its input** and is registered through
   `secureHandle` (sender check + argument checks). Do not add a raw `ipcMain`
   handler for renderer-facing work.
4. **Keep the preload narrow.** A method is a capability. Adding
   `readAnyFile(path)` or `runCommand(cmd)` defeats the whole model.
5. **Sanitise before the DOM.** Markdown goes through `src/markdown.tsx` /
   DOMPurify. Never `dangerouslySetInnerHTML` raw model output elsewhere.
6. **Dangerous code stays behind the approval gate.** Plugins and MCP servers
   run only after the user approves that exact payload (`electron/trust.ts`).
   Never auto-approve, never persist the payload in the approval, never remove
   the "code changed" invalidation.
7. **File reads stay grant-based.** `files:read` must keep refusing
   sensitive paths even when a path was granted. Resolve `realpath` and check
   the target, not just the spelling the renderer sent.
8. **Outbound guards stay on both checks.** SSRF rules apply to `web_fetch`
   **and** the image proxy, including every redirect hop, the DNS answers the
   socket actually uses, and the `169.254.169.254` metadata address.
9. **Database changes are migrations.** Add to the ordered migration list in
   `electron/db.ts`, bump `SCHEMA_VERSION`, and keep a database written by a
   newer app from opening.
10. **No telemetry, no cloud sync, no account.** The only outbound traffic is
    what the user configured.
11. **Secrets never reach the renderer.** Provider keys and the web-search key
    stay in main, encrypted with `safeStorage` when available and redacted at
    the IPC boundary; logs, errors and portable exports must not print them.
12. **Both languages, always.** `src/i18n.ts` has an English and an Indonesian
    block; a key in one and not the other breaks `scripts/guide-test.mjs`.

## Tests

The suite is grouped by what it needs (see `scripts/run-all-tests.mjs`):

| Group | Runs | Use it for |
| --- | --- | --- |
| `headless` | `npm test` | DB, migrations, tools, engine, parsers, security, trust, quick switch, perf, bundle budget |
| `e2e-local` | `npm run test:e2e` | boots its own Vite + Electron in an isolated profile (GUI, focus, UX, quick switch, XSS) |
| `e2e-attach` | `--include=e2e-attach` | drives an already-running dev app over CDP |
| `manual` | explicit `--include=manual` | real installed app / real profile / packaged build |

Rules of thumb:

- Logic in `src/lib/` and `electron/*.ts` should be covered headlessly — prefer
  a pure module and a test in `scripts/` over a new GUI step.
- A UI change needs at least `npm run typecheck`; if it touches focus, modals,
  Markdown or Settings, run the relevant end-to-end group.
- Headless tests import `dist-electron/*.js`, so run `npm run build:electron`
  (or let the runner auto-build) before them.
- Tests must assert behaviour, not implementation details. Do not relax a
  budget or a security assertion to make a red run green — fix the cause or
  report the failure.

## Commits, pull requests and releases

- Small, focused commits in the imperative mood (`Fix …`, `Add …`), one topic
  per PR.
- Do not bump the version or edit release assets in a feature PR; the maintainer
  bumps `package.json` and adds the changelog section at release time.
- A user-visible change gets a `CHANGELOG.md` entry under the unreleased/current
  version, written for users, not for the diff.
- Update the docs that describe the behaviour you changed (`README.md`,
  `docs/PLUGIN_API.md`, `src/guide/*`), and both i18n dictionaries.
- Run at least the checks that cover your change and say in the PR what you
  ran. CI runs typecheck plus the headless group on every push.
- By contributing you agree your work is licensed under the project's MIT
  licence.

## Security reports

Do **not** open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) and email
[mr.fauzan121314@gmail.com](mailto:mr.fauzan121314@gmail.com).
