---
title: Troubleshooting
summary: The failures you will actually hit, and the fastest fix.
order: 17
---

# Troubleshooting

## "No model selected"
The chat has no model and Auto could not resolve one. Pick a default in [[settings:models]], or choose a model in the composer.

## 401 / 403 from a provider
The key is wrong, expired, or lacks access to that model. Re-paste it, then **Verify** the model.

## 404 or "model not found"
The model name does not exist for that provider, or the base URL is missing `/v1`. Use *Test & fetch* to see the real list.

## Empty replies with tools enabled
Some models emit a tool call and no text. The app retries once; if it persists, turn tools off for that chat or switch to a model with reliable tool use.

## Rate limits
Wait, or switch provider. The provider's error text is shown verbatim so you can see the reset time.

## The app feels slow
Long chats load the newest 80 messages first. If typing lags, close model popovers and check that the chat is not carrying dozens of attachments.

## Database problems
A failed migration leaves the file untouched and reports the error. Restore a `.bak` copy next to the database, or export from another machine.

Still stuck? The repository issue tracker is the fastest route: include the version from [[settings:about]] and the exact error text.
