---
title: Chapters
summary: Drafting, statuses, word counts and version history.
order: 9
---

# Chapters

Chapters hold the manuscript. Each chapter has a title, content, status (`draft`, `revising`, `done`), a position and a word count.

## Writing in the app
The editor saves when you press **Save** — nothing is written behind your back mid-sentence. Each save keeps a snapshot of the previous text.

**History** opens the chapter's Revision Timeline: every saved snapshot and every displaced passage from an AI edit, newest first. Open a row to see the before/after diff with added/removed word counts, copy either side, or restore it. Restoring a snapshot first saves the current text to history, so the restore itself can be undone. **Timeline** at the top of the Chapters page shows the same line for the whole manuscript, with a chapter filter. The Writing board has the same button beside Save.

## With the model
Ask for a scene and the model can `create_chapter`, `update_chapter`, `append_to_chapter` and `read_chapter`. Appending is safer than rewriting: it never touches what you already wrote.

Every AI rewrite or manual save also leaves the displaced prose in **Text Dump**, in the sidebar. Preview or copy it, restore it to its old slot, or delete selected entries permanently. Restore asks before overwriting newer text, and the agent can search the bin with `search_text_dump` when you ask it to bring a cut line back.

Agents write to chapters, not to the chat, when the output is long-form. That keeps prose out of the transcript and out of the prompt history.

## Status and flow
Chapter status feeds [[route:flow]], which turns beats into chapters. Word counts feed [[route:stats]].
