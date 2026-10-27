---
title: Files in chat
summary: Attach files, the limits, and how their content reaches the model.
order: 3
---

# Files in chat

The paperclip in the composer attaches a file to your **next message** only. Attachments appear as cards above the input — they are not pasted into the text box, so nothing is sent twice by accident.

## Limits
| Limit | Value |
| --- | --- |
| Files per message | 8 |
| Per file | 256 KB |
| Per message, total | 1 MB |

The limits are enforced before the message is written: an oversized or binary file is rejected with one readable message and your composer stays intact.

## What can be attached
- Text-like files: `.md`, `.txt`, `.json`, `.csv`, source code, `.srt`.
- Story entries and chapters from the current project, attached as their own card.

Binary files (images, PDF, `.docx`) are not parsed; export the text first.

## How it reaches the model
Attached content is appended to the system prompt under *Attached files*, with name, kind and byte count. Long files are bounded and the prompt says when content was cut.

Files are stored with the message, so reopening a chat still shows the cards. Deleting the message or chat deletes its files.
