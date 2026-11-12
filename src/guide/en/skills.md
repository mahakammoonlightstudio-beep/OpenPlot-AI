---
title: Skills
summary: Reusable instruction packs, when to enable them, and per-chat control.
order: 6
---

# Skills

A skill is a named block of instructions injected into the system prompt: continuity rules, a critique protocol, a genre guide. Skills are global; each chat can mute them.

## Builtins
Nine ship with the app: continuity, prose, dialogue, pacing, beta reader, architect, voice, hook and line editor. They are marked **Builtin**:
- you can edit the text,
- **Reset** restores the shipped version,
- you cannot delete them.

## Adding a skill
[[settings:skills]] → **Add skill** opens the editor with name, description, content and a live preview of the injected block. **Save** creates it **disabled** — nothing reaches the model until you press **Enable**, so a half-written skill can never affect a reply.

Start from a template (Blank, Line editor, Beta reader, Worldbuilding) or import a `.md` file. Export produces a portable markdown file.

## Per-chat control
The composer shows a `Skills n` chip when skills are active. The popover puts the **Chat** or **Agent** desk's skills first and folds the other desks into *Other desks* — an active skill from another desk still shows there, so it can never be hidden by a filter. Turning a skill off stores its id in the chat's opt-out list, so it stays off for that chat only.

The **Writing** workspace has no chat row, so its AI editor uses the globally enabled Writing skills; the editor header shows how many are riding along.

## Skill Lab
Open a skill in [[settings:skills]] to see its **Skill Lab**:
- the exact block added to the system prompt,
- its character and token estimate,
- how much of the 12,000-character budget the active set uses,
- a warning when another active skill has duplicate instructions, shares its focus, or pulls in a different direction (shorter vs longer, rewrite vs preserve, ask vs don't ask, formal vs casual),
- **Use in current chat** to switch it on without leaving Settings.

Token counts are a 4-character estimate, not a provider tokenizer, but they are consistent with the composer's counter.

## Agent mode picks skills
In Agent mode the model can switch skills on and off itself, per chat. Before a task it calls `list_skills`, then `use_skill` for the packs that fit — continuity before checking canon, prose while drafting, beta reader while critiquing — and `drop_skill` when one stops applying. Each switch shows up in the tool log and as a toast, and the composer chip updates, so an automatic change is never silent. Because the choice is stored on the chat, the skill stays active for the following turns.

## Prompt size
The skills block is capped at 12,000 characters. A skill that does not fit is replaced by `[skill truncated: …]` rather than cut mid-instruction.

## When skills hurt
Three overlapping skills often contradict each other. Keep two or three enabled per project and let agent.md carry the general rules.
