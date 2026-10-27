---
title: Thinking and reasoning
summary: Reasoning budgets, where the output goes, and how to tune it.
order: 5
---

# Thinking and reasoning

Models that support reasoning can spend tokens before answering. OpenPlot exposes that as **Thinking**.

## The control
The brain icon in the composer has three states: off, on, and *auto* (on for models that support it). With `thinkingUi = auto`, models that cannot reason do not see the control at all.

## Budget
The budget is the maximum reasoning tokens for this chat, clamped by the model's context window. A larger budget is not automatically better: it costs latency and money, and most tasks finish reasoning well before the cap.

## Where the output goes
Reasoning streams into a collapsible block above the reply. `thinkingDisplay` decides:
- **auto** — expands while streaming, collapses when the answer starts.
- **expanded** / **collapsed** — pinned.

Reasoning text is stored with the message and is never injected back into later prompts.

## Practical settings
| Task | Budget |
| --- | --- |
| Quick edits, chat | off |
| Planning, critique | 1–2k |
| Hard continuity or plot problems | 4k+ |
