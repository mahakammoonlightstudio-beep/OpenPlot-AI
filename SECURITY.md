# Security policy

OpenPlot AI is a local-first desktop app. It stores your story, your settings and
your API keys on your own machine, and it runs code you explicitly approve
(plugins and MCP servers). That makes the trust boundary worth stating plainly.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.2.x (latest release) | Yes — security fixes ship here |
| 1.1.x and older | No — please upgrade |

Only the latest `1.2.x` release receives security fixes. If you build from
`main`, reproduce the issue on the latest release before reporting it.

## Report a vulnerability

**Email: [mr.fauzan121314@gmail.com](mailto:mr.fauzan121314@gmail.com)**

Please use the subject line `[SECURITY] OpenPlot AI — <short summary>` and do
**not** open a public GitHub issue for a vulnerability.

Include, as far as you can:

- the OpenPlot AI version (About screen or `package.json`) and your OS;
- the affected component (renderer, preload bridge, main process, database,
  plugin/MCP gate, image proxy, importer, export);
- clear reproduction steps or a proof of concept;
- the impact you believe it has, and any suggested fix.

If you prefer GitHub, you can also use **Security → Report a vulnerability** on
the repository. Email is the primary channel and is checked first.

### What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | within 72 hours |
| Initial triage and severity | within 7 days |
| Fix or mitigation plan | within 30 days for high/critical issues |
| Coordinated disclosure | 90 days after the report, or sooner by agreement |

I will keep you updated, credit you in the release notes if you want credit, and
tell you before anything is published. Please give me a reasonable window to
ship a fix before disclosing details publicly.

## Scope

In scope:

- the Electron boundary: `contextIsolation`, the preload bridge, IPC sender
  checks, navigation/window-open guards;
- the renderer: Markdown/HTML sanitisation, stored XSS, `javascript:` URLs,
  hostile tool-step content;
- network guards: `web_fetch` SSRF rules, redirect checks, the remote-image
  proxy, provider URL handling;
- local file access: attachment grants, sensitive-path refusal, export paths;
- the plugin/MCP execution gate and stored approvals;
- the database layer: SQL injection shapes, prototype pollution, hostile
  payload types, import/export parsers;
- secret handling: API keys at rest, key redaction, logs;
- update/release artifacts, if something in the published binaries does not
  match the tagged source.

Out of scope:

- a plugin or MCP server **you approved** doing what its code says (that is the
  point of the approval dialog; only install code you trust);
- an attacker who already has your OS account, your unlocked keychain/credential
  vault, or your disk;
- vulnerabilities in third-party providers, models, or the servers you connect
  to;
- denial of service that requires the victim to import a gigantic local file or
  paste gigabytes of text;
- missing hardening headers that have no demonstrated impact in an Electron
  desktop app.

## How the app is hardened (as shipped)

These are implementation facts, not promises about future versions:

- **The renderer has no Node and no network.** `nodeIntegration` is off,
  `contextIsolation` is on, and the only bridge is a narrow, validated preload
  API. The production CSP is `default-src 'self'`, `script-src 'self'`,
  `connect-src 'none'`, `object-src 'none'`, `frame-src 'none'`,
  `base-uri 'none'`, `form-action 'none'`, with images limited to
  `'self' data: blob:`.
- **Markdown is sanitised.** DOMPurify strips scripts, event handlers, iframes,
  inline styles and `javascript:` URLs before anything reaches the DOM; links
  are hardened with `target=_blank rel=noopener`.
- **Every IPC handler checks its caller and its input.** Channels are
  registered through a wrapper that verifies the sender is the app's own
  document and validates argument shapes and sizes.
- **Attachments are grant-based.** `files:read` only reads paths the app's own
  picker returned or the user just dropped (30-minute grant), and refuses secret
  shapes (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.env`, credential stores, private
  keys, `.pem`/`.key`/`.pfx`/`.kdbx`) even when granted.
- **Outbound fetches refuse your own network.** `web_fetch` rejects loopback,
  private ranges, CGNAT, link-local metadata (`169.254.169.254`), decimal/hex/
  shorthand IP spellings and single-label intranet hosts, and re-checks every
  redirect. The only bypass is the test-only `OPENPLOT_WEB_ALLOW_LOCAL=1`, read
  once at load.
- **Remote images go through the same gate.** The renderer never fetches; main
  accepts public http(s) only, refuses credentials in the URL, re-checks each
  redirect, allows raster types only (SVG is rejected), and caps a fetch at 5 MB
  / 15 s.
- **Dangerous execution is opt-in and exact.** A plugin (JavaScript) or MCP
  server (a local command) runs only after you approve that exact payload. The
  approval is the hash of the code/command, so editing it asks again; Settings
  lists every approval and revoking one stops it immediately.
- **Keys are encrypted at rest when the OS can.** API keys are sealed with
  DPAPI, Keychain or libsecret through `safeStorage`; the database itself never
  contains the plaintext key, and keys never cross to the renderer.
- **Local-first means no telemetry.** No account, no analytics, no background
  update ping; the only outbound traffic is what you configure (your provider,
  web research you enable, and an image host when a Markdown image points at
  one).

## Safe harbour

Good-faith security research is welcome. I will not pursue legal action for
research that stays within this scope, avoids privacy violations and data
destruction, does not degrade other users' experience, and gives me a chance to
fix the issue before public disclosure. Testing against your own installation
and your own data is expected; do not test against other people's machines or
data.

## Credit

Reporters are credited in the changelog and release notes unless they ask to
stay anonymous.
