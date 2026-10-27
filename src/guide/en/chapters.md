---
title: Chapters
summary: Drafting, statuses, word counts and version history.
order: 9
---

# Chapters

Chapters hold the manuscript. Each chapter has a title, content, status (`draft`, `revising`, `done`), a position and a word count.

## Writing in the app
The editor saves when you press **Save** — nothing is written behind your back mid-sentence. Version history keeps a snapshot per save so you can compare or roll back.

## With the model
Ask for a scene and the model can `create_chapter`, `update_chapter`, `append_to_chapter` and `read_chapter`. Appending is safer than rewriting: it never touches what you already wrote.

Agents write to chapters, not to the chat, when the output is long-form. That keeps prose out of the transcript and out of the prompt history.

## Status and flow
Chapter status feeds [[route:flow]], which turns beats into chapters. Word counts feed [[route:stats]].
