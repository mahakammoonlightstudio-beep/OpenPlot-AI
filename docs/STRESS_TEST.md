# Engine stress test

How the AI engine (`electron/ai.ts`) behaves when a real provider or relay
misbehaves: broken SSE, sockets cut mid-reply, stalls, HTML landing pages,
oversized payloads and concurrent load.

```bash
node scripts/stress-test.mjs
```

The suite runs against local mock servers; no API key or network access is
needed. It currently performs **12 assertions**, all passing on 2026-11-12.

## Scenarios

| # | Scenario | Mock | What is checked |
|---|---|---|---|
| S1 | Malformed SSE | `malformed` — garbage lines, broken JSON, no sensible ordering | The parser does not crash; valid deltas before the damage are still delivered (`survivor`) |
| S2 | Socket cut mid-reply | `midcut` — `res.destroy()` after one delta | The promise settles with an error or the partial text; it never hangs |
| S3 | Stall, then die | `stall` — open SSE, comment pings only, then destroy | Settles as an error well under the 30 s timeout |
| S4 | HTML page on a chat endpoint | `html` — every path serves a landing page | HTTP 200 HTML is rejected with a readable error |
| S5 | 20 concurrent generations | `good` | All 20 results arrive intact and identical; no state bleed |
| S6 | Abort storm | `good` — ten started, all aborted after 60 ms | Every promise settles; no deadlock |
| S7 | ~400 KB reply | `slow_big` — 12,000 tokens in bursts | The full reply arrives; streaming chunks are counted |
| S8 | 30 rapid sequential runs | `good` | 30/30 consistent results, no leaked keep-alive or socket |
| S9 | `verifyModel` / `validateKey` against hostile modes | `html` → `good` | HTML is reported gracefully; the healthy endpoint recovers |

## Bugs found and fixed by this harness

1. **Streaming could hang the UI.** A mid-stream failure left the composer
   waiting forever. `ChatView.send()` now uses `try/finally` and `abort()`
   releases the UI immediately.
2. **Keep-alive poisoning.** A hostile response could poison a reused socket.
   Each request uses a clean socket (`agent: false`-style), and the mock forces
   `Connection: close`.
3. **HTTP 200 HTML looked like a reply.** `isHtmlBody()` now runs on any
   successful body before parsing.
4. **`verifyModel` knew one response shape.** Non-standard relays
   (`{content:[…]}`, `{response}`, `{output_text}`) now parse correctly.
5. **`providers.kind` was lost on restart.** A migration and the update path
   persist the column, so Anthropic/OpenAI detection survives a reboot.
6. **Rigid base-URL candidates.** `baseUrlCandidates()` tries the common
   variants (full endpoint, no `/v1`, `/v1/extra`) instead of failing on 404.

## Known limits

- **30 s hard request timeout.** Slow reasoning models can hit it; it is not
  configurable per provider.
- **Health status is local.** `openplot.modelHealth.v1` (max 40 events per model,
  degraded threshold 6 s) is a client observation, not provider uptime.
- **The transcript renders 60 messages at a time.** Long chats page backward
  with a skeleton and a "Load N earlier" button.
- **Abort mid-stream is covered separately** by `scripts/engine-test.mjs`; S6
  only proves the abort storm settles.
- **Mocks speak the OpenAI wire format.** Quasi-OpenAI variants (odd `usage`,
  empty SSE without `[DONE]`) are only partly covered by S1.

## Related checks

- `node scripts/engine-test.mjs` — incremental streaming, tool calls, abort.
- `node scripts/url-fix-test.mjs` — base-URL candidates and error extraction.
- `node scripts/security-test.mjs` — SSRF/DNS, secrets, files, plugins/MCP,
  images and database hostile input.
- `npm test` — the whole headless group.
