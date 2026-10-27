---
title: agent.md
summary: The rules that outrank styles, skills and memory.
order: 7
---

# agent.md

agent.md is your permanent instruction file. It is injected into every chat under the label *Agent instructions (highest priority after the system prompt)*.

## What belongs there
- Voice and craft rules that apply to everything you write.
- Tool etiquette: read before write, ask before destructive edits.
- What the model must never do.

What does **not** belong there: story facts (story bible), reusable workflows (skills), one-off instructions (the message itself).

## Priority
1. System prompt and provider safety rules.
2. agent.md.
3. Project context.
4. Skills.
5. Reply style.
6. Memory.
7. Your message.

When two rules conflict the higher one wins; the model is told to say so in one line instead of silently picking.

## Editing
[[settings:agentmd]]: edit, then **Preview prompt** to see the compiled result. **Restore default** loads the shipped text, templates give you a novelist, editor or minimal starting point, and the counter shows characters and approximate tokens.

Drafts survive switching sections; **Discard** throws them away.

## Upgrades
When a new version ships a better default, the app replaces agent.md **only if it still matches the old shipped text exactly**. If you changed a single character, nothing is touched — a one-time toast tells you the default moved on.
