---
title: Models and prompt cache
summary: Capability detection, per-model tuning and what the cache chips mean.
order: 4
---

# Models and prompt cache

## Capability chips
Every model row shows what it can do, from three sources:
1. **Known presets** — shipped facts for common models: context, output, reasoning, cache.
2. **Probe** — the *Verify* button asks the provider what it accepts.
3. **Observation** — usage numbers from real replies.

Chips are advisory. A model that claims no reasoning still works; the thinking control simply hides itself in `auto` mode.

## Per-model tuning
[[settings:models]] → *Edit* opens the model card: context window, output cap, temperature override, reasoning support, cache mode. Overrides are stored per `provider::model` pair.

## Prompt cache
Some providers reuse an unchanged prompt prefix and bill it cheaper. The chat footer shows cached tokens when the provider reports them:

- `cache 0%` — nothing reused.
- `cache 62%` — most of the prompt prefix came from cache.

Hits depend on a stable prefix. Editing older messages or changing the system prompt invalidates it — expected, not a bug.
