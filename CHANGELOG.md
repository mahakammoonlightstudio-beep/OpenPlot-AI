# Changelog

All notable changes to OpenPlot AI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.3] — 2026-10-26

> **Status: scope locked.** This is the “Studio UX” release: the version number says
> patch, the payload is a rebuild of the studio’s ergonomics. Implementation plan:
> [`docs/superpowers/plans/2026-10-26-v1.2.3-studio-ux.md`](docs/superpowers/plans/2026-10-26-v1.2.3-studio-ux.md).
> Verify each line against the build before tagging.

### Added
- **Files that live in the chat.** Attaching a file now puts a card with its name and size above the composer; click it to read the content before sending. After send, the cards stay in the transcript, click one for a popup with the full text, copy and download. Files are stored with the message (8 per message, 256 KB each, 1 MB per message), survive restarts, and are deleted with their message or chat.
- **An in-app guide.** A bundled, searchable handbook (English and Bahasa Indonesia) covering chat, files, models and cache, thinking, skills, `agent.md`, the Story Bible, chapters, flow, stats, export, settings, plugins, MCP, privacy, troubleshooting and every shortcut — reachable from the sidebar, the command palette, `F1` and contextual help buttons. Plus a “What’s new” card on the first launch of a new version.
- **Thinking only where it exists.** The thinking control is driven by the model’s capability (probed once, remembered): reasoning models show the toggle, budget and their trace with a “thought for…” duration; models without reasoning hide the control (a preference can keep the plain on/off switch) and never receive thinking parameters; unverified models say so instead of guessing.
- **Smart model configuration that reports memory.** The model card now states context window, max output, reasoning support, and prompt-cache capacity (“up to ~N tokens, automatic / explicit breakpoints / unknown”), plus the cached tokens your last reply actually reused. Anthropic requests use `cache_control`; OpenAI, DeepSeek and Gemini caching is picked up from provider usage. Cached tokens are stored per message and summarized in Settings → Usage.
- **Skills v2.** Six builtin skills ship with the app (Continuity Guardian, Prose Polisher, Dialogue Coach, Pacing Analyst, Beta Reader, Worldbuilding Architect), seeded idempotently so upgrades never duplicate or overwrite edits. **Adding a skill creates it disabled**: it does nothing until you press **Enable**. Skills get descriptions, a card grid with labelled switches, a template gallery, duplicate, import/export and a reset-to-builtin action, plus a per-chat opt-out in the composer.
- **A rewritten `agent.md`.** A structured default (instruction priority, tool protocol, memory policy, writing standards, response format, safety) replaces the ten-line persona. Existing edits are never overwritten; only an untouched v1 default upgrades, once, with a notice. The editor gains a compiled-prompt preview, templates, a token counter, unsaved-changes protection and “Restore default”.
- **Settings that explain themselves.** 14 sections grouped into six areas with a global settings search, a Simple/Advanced switch (advanced reveals top-p, thinking budget, probe details and the Extend group), capability-aware model table, per-section reset, and a guided Smart setup flow (preset → key → fetch models → verify → default).
- **A motion system.** GPU-only micro-interactions built on shared tokens — route fade, modal and popover entry, toast slide-up, the newest message bubble only, disabled-toggle and nav transitions, file-card hover lift — with a Motion setting (follow the system / always / reduced) and a `prefers-reduced-motion` kill switch. Only opacity and transform animate.
- **A chat that shows its state.** Model chip with capability dots and a context meter, message actions (copy, edit, regenerate any turn, save to chapter), cached/token chips, localized empty and error states, and a welcome screen with quick starts and recent chats.
- **The MCP bridge.** Enabled stdio servers are spawned after the window is ready, handshaken (`initialize` + `tools/list`) and exposed to the model as `mcp__{server}__{tool}` when agent tools are on. Startup gets 10 s, a call 30 s, a response line 1 MB and a result 20,000 characters; every child is killed on quit, restart or a failed start. Settings → MCP shows a live status dot, tool count, last error, restart and a 300-line log, and warns that a definition is an arbitrary local command.
- **Automations v2.** Seven triggers (`app:ready`, `chat:new`, `chat:send`, `message:new`, `chapter:saved`, `project:created`, `skill:enabled`) and nine actions (toast, window flash, log, save/clear memory, open page, new chat, open URL, apply skill). Each row shows its last run and a session history, **Test** runs only that row, and guards stop self-triggering chains and chains deeper than two levels.
- **A palette that reaches more.** Models (grouped by provider, with a thinking hint) can be switched from `Ctrl/Cmd+K`, skills toggled, and every registered plugin command run — alongside guide articles, settings sections, exports and theme cycling.
- **A prompt library you can carry.** Export your prompts to a JSON bundle and import someone else's: entries are validated (title + template required), categories normalised, duplicates skipped by title+category, and the batch capped at 500. Any prompt can be duplicated, the insert preview expands the first `{placeholder}` live, and each row counts how often it was used in the open chat.
- **Styles you can fork.** A builtin style can be duplicated into an editable custom copy, and the styles list shows each style's first line so similarly named ones are distinguishable.
- **Small review wins.** About shows a dismissible “new in this version” card (per version), and the window title shows the active chat when nothing is unread — unread count still wins.

### Changed
- **Versioned database migrations.** `PRAGMA user_version` with an ordered migration list, a one-time `.bak` before the first change, an in-memory rollback snapshot and a refusal to open a database written by a newer app. The new tables and columns (`message_files`, skills v2, `chats.skills_off`, `messages.tokens_cached`) ride on it.
- **Long chats stay small.** Transcripts load one page at a time from the main process and the renderer keeps at most 200 messages in memory; “load earlier” keeps the scroll position. Views are code-split, hot components subscribe to narrow store slices, and the highlight cache has a byte budget instead of only an entry count.
- **Docs are versioned with the app.** README, changelog, landing pages, plugin API and the new in-app guide all describe 1.2.3, and the plugin/MCP pages state what is actually shipped: MCP server definitions are stored, the bridge that runs them is not in this release, and only the `chat:new` and `message:new` plugin hooks fire today.
- The story prompt builder moved into a testable module, and reply-style/skill/attachment/agent.md blocks are labelled with their priority and truncation state.
- Plugin commands can be reloaded without restarting (**Reload all plugins**) and are runnable from the palette; the guide grew an automations article and its MCP page now describes the shipped bridge instead of a placeholder.

### Fixed
- Adding a skill used to save it **enabled** — a new skill could change every reply before the user ever read it. New skills now start disabled and must be enabled explicitly.
- Builtin skills and styles were seeded only when the table was empty, so new builtins never appeared for existing users; seeding is now idempotent by stable id.
- Toast timers were never cleared on dismiss, the per-chat scroll map kept ids for deleted chats, highlight results could hold tens of megabytes, and last-read/write-stat records outlived the chats and projects they referenced.
- Per-chat attachments were only alive in the composer; there was no way to re-read a file after sending it.

### Tests
- New suites: migrations (fresh, legacy, interrupted, newer-than-app, backup-once, agent.md v1→v2 and custom-text preservation), model capability inference and cache profiles, chat files (limits, lazy read, cascade delete), prompt building (order, gating, truncation, agent.md labelling), guide parsing/parity/search/tokens, a paging + performance suite on a real 5,000-message database (page size, walk-back integrity, write/persist budgets) and bundle-size budgets on the built assets.
- Added suites for the MCP bridge (handshake, tool listing, call timeout, response cap, restart/quit lifecycle against a mock stdio server) and for prompt-library bundles (shape tolerance, required fields, category normalisation, de-duplication inside a file and against the library, size cap).
- Not covered yet: the automation guards and per-run log live in the renderer store, so they are exercised only by the UI smoke render; there is no headless suite for them.

## [1.2.1] — 2026-10-25

A small user-experience patch on top of 1.2.0: one crash fixed, and the Story Bible now stays in sync with the agent.

### Fixed
- **Story Bible no longer blanks the window.** Opening an entry whose `tags` or `links` had been stored as a plain string crashed the whole view with `TypeError: e.map is not a function`. Tool arguments are not validated, so a model replying `"tags": "fantasy"` (instead of an array) could write that shape into the database. Both columns are now normalised in the main process on write **and** on read, and the renderer parses them defensively — existing databases with bad rows open safely, no migration needed.
- Reloading the window no longer throws away your place. The app remembers the current route, chat and project, restores them on boot, and silently discards ids whose row was deleted.
- The Story Bible header, category tabs and empty-state cards printed the raw icon name (`globe World`, `person Character`, …) instead of drawing the icon. They now render the SVG icons.

### Changed
- **The Story Bible refreshes itself after the agent writes.** Creating or editing a profile through chat tools updates the view in the background (debounced, no toast, no navigation) instead of requiring an app reload.
- **Projects have their own icon.** The “new project” and “new folder” buttons in the sidebar were both a folder-with-plus; projects now use a layered stack and project rows use it too, so the two are distinguishable at a glance.

### Tests
- Added regression coverage for legacy/corrupted story `tags`/`links` rows (write normalisation, read normalisation and a simulated old database) plus the renderer-side array guard.

## [1.2.0] — 2026-10-24

The “smoother studio” release: a guided story agent, reference files in the Story Bible, and a lighter, more careful core.

### Added
- **Plot Smith — the story agent.** A four-step, option-driven wizard: brief (genre, tone, POV, length, format, audience, story language, must-haves) → **three premise options** → cast & world (4–6 characters, locations, lore, all individually includable) → three-act outline with concrete beats and a chapter plan. Plans are saved locally and can be reopened; **Create project** builds the project, bible entries, chapters and flow beats from the plan. Each step explains what it does and every generation can be cancelled. New route, sidebar entry and command-palette action.
- **Reference files in the Story Bible.** Attach `.md`, `.txt`, `.json` or `.csv` files to any entry with the file picker or by dropping them on the editor. Files are stored with the entry (2 MB each, binary files refused), listed as chips with a read-only preview, searchable by name and content, and readable by the agent through the new `read_story_file` tool (safely truncated for very large files). No more copy-pasting notes into entries.
- **Bulk import into the Story Bible.** Turn Markdown/JSON/CSV/TXT files into entries in one pass, with a preview, category inference from filenames/headings/columns, duplicate-title skipping and a hard cap. One IPC call handles the whole batch.
- **Settings → Data → storage card.** Shows the database size on disk and row counts, and adds a safe **Compact database** action (VACUUM + orphan cleanup).
- Story-agent attachment awareness: `read_story_bible`, `search_story` and `read_project` now list attached file names, `search_story` matches text inside attachments, and `read_story_file` returns the file body.
- New test groups: Story Bible import parser (25 checks), Plot Smith engine (31 checks), story vault/data-layer tests including bulk creation and compaction, and a headless server-render smoke test for the app shell and every main view.

### Changed
- **Database writes are cheaper and safer.** Persistence now runs only when a write actually happened (read-only work no longer rewrites the file), writes through a temp file + atomic rename, and avoids an extra full-size Buffer copy on each save. Added indexes for messages, story entries, chapters, flow beats, versions and attachments.
- **Bulk operations are one round-trip.** Importing entries and creating a Plot Smith project no longer fire one IPC call per row; each is a single validated operation with one persistence pass.
- **Long chats mount less.** Only the visible window of messages is mounted (older turns collapse into one spacer) and message bubbles are memoized, so a streaming reply no longer reconciles the whole transcript. Chat and app shells use narrow store subscriptions; the toast strip is isolated; the composer attaches its prompt-library shortcut once instead of on every keystroke.
- Model-health history is capped at 60 models with 40 events each, both in memory and localStorage (previously every model ever probed stayed forever).
- `search_story` now returns `{ entries, files }` so attachment hits are visible to the model.
- Story Bible import and attachment limits are enforced in the main process, not just the UI.
- Version 1.2.0 across the app, README, changelog and landing pages.

### Fixed
- Copy-button timers now clear on unmount, and the health-history cache can no longer grow without bound.
- Story-bible attachments are deleted with their entry or project (no orphaned rows or blobs), and are included in “reset all”.
- `read_story_file` prefers files from the active project, so two projects with the same filename cannot resolve to the wrong canon.
- Attaching an unreadable/empty/binary file reports a clear error instead of silently creating an empty entry.
- Server-render/test environments without a DOM no longer crash inside the Markdown sanitizer.

## [1.1.1] — 2026-10-01

### Fixed
- **App could exit instantly while validating an API key** against a misbehaving relay or local endpoint. Windows Event Log showed V8 fast-fail crashes (`0xc0000409`) with the same fault offset since v1.0.2. The main-process HTTP layer now caps buffered response bodies at 8 MB (a hostile/buggy endpoint streaming gigabytes used to exhaust the heap), `fetchModels` caps the rendered model list at 400 entries (some relays return absurd lists that froze the renderer), `updateProvider` tolerates partial payloads instead of throwing on undefined bindings, and the main process installs `uncaughtException`/`render-process-gone` guards so a future internal error shows a message instead of killing the app silently.

## [1.1.0] — 2026-09-30

### Added
- **Reply styles (Claude-style)** — six builtin personas (Default, Concise, Explanatory, Editorial, Empathetic, Formal) seeded into a new `prompt_styles` table and injected under “# Reply style”. Pick one from the composer's sparkle button; edit builtins or add custom styles in Settings → Styles. Builtins can be edited in place but never deleted; `resetAll` re-seeds them.
- **Attachments as chips** — files attached via the ADD panel now land as removable chips above the composer instead of being pasted into the input as inline text. At send time they ride in the system prompt as fenced blocks.
- **Drag & drop onto the chat** — drop OS files onto the message area, or drag a story-bible entry or chapter straight from the Story/Chapters views (custom `application/x-openplot-*` payload types); the drop target highlights.
- **Token accounting** — `tokens_in`/`tokens_out` captured from provider usage when reported (OpenAI `usage`, Anthropic `message_start`/`message_delta`), estimated from the payload otherwise, stored per assistant message, shown as a compact chip on the bubble, and summarized per model and per chat in the new Settings → Usage section.
- **Agent tools extended** — `read_story_bible` (whole bible in one call), `append_to_chapter` (safe end/beginning append), `list_projects` and `read_project`. The advertised tool list in the system prompt now matches the real registry.
- **Default skills seeded** — Continuity Guardian, Prose Polisher, Dialogue Coach and Pacing Analyst ship in Settings → Skills on first run; editable and deletable like user skills.
- **Pinned chats** — pin important conversations so they float to the top of the sidebar (persisted in the DB, works inside folders and search results).
- **Zen mode for chat** — the header and composer dim to 35% while reading or writing; focus or hover brings them back, `Esc` exits. The sidebar can slide away too (`Esc` restores).
- EPUB export now takes the author name from Settings → Chat Behavior and validates the language tag (`en`/`id`) instead of hard-coding `dc:language=en`.
- `OPENPLOT_DATA_DIR` env var redirects the whole profile (DB + settings) for clean-room test runs and screenshots.
- New icons: `expand`, `panelLeft`. Full EN + ID translations for every new string.

### Fixed
- Deep search (search inside message content) leaked LIKE wildcards in the per-chat match-count subquery — searches containing `%` or `_` returned wrong match counts.
- Deleting a message while a reply is generating is now refused (in the main process, not just the UI) so an in-flight reply can never be stranded out of order.
- `updateMessage` used COALESCE semantics that made clearing `content`/`thinking` impossible; it is now tri-state (undefined = keep, null = clear).
- Chat rows found via deep search but not by title had no rename/delete affordances and no unread badge in the sidebar.
- Scroll-position memory for deleted chats is now freed instead of accumulating.
- Plugin sandbox documented honestly: `new Function` execution is a convenience boundary, not a security boundary — plugins run with full Node access and must be trusted.
- Style button active state used accent-on-accent text that failed the 3:1 contrast minimum on the Nord theme (accent dot + normal text now, matching the thinking toggle).

### Changed
- Settings navigation gained Styles and Usage sections (12 total).

## [1.0.2] — 2026-09-29

### Added
- Universal macOS binaries: the disk image and the main macOS zip now contain both Intel and Apple silicon builds in a single download. A smaller arm64-only zip remains available.

### Changed
- The README downloads table reflects the real v1.0.2 asset names.
- Launch-promotion content (X, LinkedIn, YouTube Community, Reddit, hook A/B variations) now lives in the repository under `promo/`.

## [1.0.1] — 2026-09-29

### Fixed
- Keyboard focus reliability. Confirmations previously used `window.confirm()`, which steals keyboard focus and never returns it — the reported symptom was that typing stopped working "everywhere, sometimes". All 17 call sites now use an in-app confirm dialog with Enter/Escape/backdrop handling and localized buttons.
- Focus rescue when closing the command palette, modals and popovers, so focus never ends up on `document.body`.
- The root container now accepts focus (`tabIndex=-1`) as a recovery target, and reorder buttons stay visible while focused.

### Added
- The macOS Intel disk image promised in v1.0.0.

## [1.0.0] — 2026-09-28

Initial public release. A local-first AI chat and story-writing studio for Windows, macOS and Linux.

### Added
- Chat with any provider: OpenAI, Anthropic, OpenRouter, Groq, Ollama, LM Studio, or any OpenAI-compatible `/v1` endpoint. Streaming responses, reasoning display, agent tools, prompt library, @-mentions, per-chat overrides and a context guard.
- Story bible: worlds, locations, characters, items and lore with tags, links, search and category counts.
- Chapters: draft/revising/done statuses, reordering, focus mode, scene boards, and version history (snapshots on save, before AI edits and before restores; last 30 kept per chapter).
- One-click AI actions on the open chapter: continue writing, critique, beat outline.
- Story flow: a three-act outline board linked to chapters.
- Statistics: daily goal, streaks, a 90-day heatmap, and per-project stakes with AI arc analysis.
- Export: whole-project Markdown, plain-text manuscript and EPUB (assembled in the main process with no external dependencies), plus per-chat Markdown export.
- Organization: projects binding chats, bible, chapters and stats; collapsible chat folders; full-text chat search; command palette.
- Extensibility: `agent.md` instructions, skill packs, sandboxed JavaScript plugins, when/then automations and an MCP server registry.
- Privacy: local SQLite storage, OS credential vault for API keys (DPAPI/Keychain/libsecret), no account, no cloud, no telemetry, deletable memories.
- Interface: ten themes, ten accent colors, English and Bahasa Indonesia.
- Distribution: Windows NSIS/zip, macOS dmg/zip, Linux AppImage/tar.gz via tagged GitHub Actions builds.

### Changed
- Slimmed the highlight.js bundle from the full 386-language barrel to core plus 13 languages (renderer bundle roughly 1386 kB to ~500 kB).
- Markdown rendering during streaming is throttled to animation frames.
- Database persistence debounced to 1200 ms; DevTools no longer open automatically in development (opt-in with `OPENPLOT_DEVTOOLS=1`).

[Unreleased]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.2.1...v1.2.3
[1.2.1]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.1.0...v1.1.1
[1.0.2]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases/tag/v1.0.0
