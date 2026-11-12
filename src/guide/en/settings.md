---
title: Settings
summary: Simple vs advanced, search, and where each control lives.
order: 13
---

# Settings

Settings is grouped by what you are trying to do, not by data model:

- **AI** — providers, models, behaviour.
- **Chat** — styles, skills, agent.md.
- **Appearance** — theme (follows your system by default), accent, font size, language.
- **Data** — libraries, Time Machine snapshots, memory, usage, backup and reset.
- **Extend** — plugins, automations, MCP *(advanced mode)*.
- **About** — version, data path, credential vault, guide.

## Search
The search box above the nav finds controls, not just sections: type `cache` to land on the cache rows of the models page. `↑`/`↓` move, `Enter` jumps and focuses the control, `Esc` clears.

## Language
Appearance → Language switches the interface between English (US), English (UK), Bahasa Indonesia, Español and हिन्दी. English (UK) uses British spelling; Spanish and Hindi are beta, so their core screens are translated while advanced settings fall back to English and say so.

## Simple vs advanced
Simple mode hides advanced model parameters and the Extend group. Nothing is removed — *Show advanced settings*, also in the palette, brings everything back, and the choice is remembered.

## Time Machine
[[settings:data]] keeps up to 12 whole-library snapshots. One is taken before a schema upgrade, an import, a reset or a restore, plus a daily copy and any *Snapshot now*. Restoring asks first, saves the current state as another snapshot, then restarts into the chosen copy. Snapshots are per library, so restoring one library never touches another.

## Reset
Each section can reset its own defaults. *Reset all data* in [[settings:data]] deletes everything; a *Before reset* snapshot is taken automatically, but export first if the data matters.
