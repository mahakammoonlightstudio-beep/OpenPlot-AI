---
title: Skills
summary: Reusable instruction packs, when to enable them, and per-chat control.
order: 6
---

# Skills

A skill is a named block of instructions injected into the system prompt: continuity rules, a critique protocol, a genre guide. Skills are global; each chat can mute them.

## Builtins
Six ship with the app: continuity, prose, dialogue, pacing, beta reader and architect. They are marked **Builtin**:
- you can edit the text,
- **Reset** restores the shipped version,
- you cannot delete them.

## Adding a skill
[[settings:skills]] → **Add skill** opens the editor with name, description, content and a live preview of the injected block. **Save** creates it **disabled** — nothing reaches the model until you press **Enable**, so a half-written skill can never affect a reply.

Start from a template (Blank, Line editor, Beta reader, Worldbuilding) or import a `.md` file. Export produces a portable markdown file.

## Per-chat control
The composer shows a `Skills n` chip when skills are active. The popover lists every enabled skill with a switch; turning one off stores its id in the chat's opt-out list, so it stays off for that chat only.

## Prompt size
The skills block is capped at 12,000 characters. A skill that does not fit is replaced by `[skill truncated: …]` rather than cut mid-instruction.

## When skills hurt
Three overlapping skills often contradict each other. Keep two or three enabled per project and let agent.md carry the general rules.
