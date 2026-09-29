# Changelog

All notable changes to OpenPlot AI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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
