# Changelog

All notable changes to OpenPlot AI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases/tag/v1.0.0
