# Security policy

OpenPlot AI is a local-first desktop app. Your manuscript, settings and API
credentials live on your machine, and the app can run code you explicitly
approve (plugins and MCP servers). This document states the trust boundary, what
ships as a control, and what remains out of scope.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.3.x (latest release) | Yes — security fixes ship here |
| 1.2.x and older | No — please upgrade |

Only the latest `1.3.x` release receives security fixes. If you build from
`main`, reproduce the issue against the latest release before reporting it.

## Report a vulnerability

**Email: [mr.fauzan121314@gmail.com](mailto:mr.fauzan121314@gmail.com)**

Use the subject line `[SECURITY] OpenPlot AI — <short summary>` and do **not**
open a public GitHub issue. If you prefer GitHub, **Security → Report a
vulnerability** on the repository also works; email is checked first.

Please include:

- the OpenPlot AI version (About screen or `package.json`) and your OS;
- the affected component (renderer, preload bridge, main process, database,
  plugin/MCP gate, image proxy, importer, export);
- clear reproduction steps or a proof of concept;
- the impact you believe it has, and any suggested fix.

### What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | within 72 hours |
| Initial triage and severity | within 7 days |
| Fix or mitigation plan | within 30 days for high/critical issues |
| Coordinated disclosure | 90 days after the report, or sooner by agreement |

You will be kept updated, credited in the release notes if you want credit, and
told before anything is published.

## Scope

In scope:

- the Electron boundary: `contextIsolation`, the preload bridge, IPC sender
  checks, navigation and window-open guards;
- the renderer: Markdown/HTML sanitisation, stored XSS, `javascript:` URLs,
  hostile tool-step content;
- outbound network guards: `web_fetch` SSRF/DNS rules, redirect checks, the
  remote-image proxy, provider URL handling;
- local file access: attachment grants, symlink resolution, sensitive-path and
  private-root refusal, export paths;
- the plugin/MCP execution gate and stored approvals;
- the database layer: SQL injection shapes, prototype pollution, hostile
  payload types, import/export parsers;
- secret handling: keys at rest, renderer redaction, logs, portable exports;
- published release artifacts, if a binary does not match the tagged source.

Out of scope:

- a plugin or MCP server **you approved** doing what its code says — approval is
  the security boundary, and the code runs with your permissions;
- an attacker who already has your OS account, unlocked keychain/credential
  vault, or disk;
- vulnerabilities in third-party providers, models, or servers you connect to;
- denial of service that requires importing a gigantic local file or pasting
  gigabytes of text;
- missing hardening headers that have no demonstrated impact in an Electron
  desktop app.

## How the app is hardened

These are implementation facts for the shipped 1.3.x build, not promises about
future versions.

### Process boundary

- `nodeIntegration` is off, `contextIsolation` is on, and the renderer reaches
  the main process only through the fixed `window.inkwell` preload API.
- The production CSP is `default-src 'self'`, `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'` (the UI sets inline widths/colours),
  `connect-src 'none'`, `img-src 'self' data: blob:`, `object-src 'none'`,
  `frame-src 'none'`, `base-uri 'none'` and `form-action 'none'`.
- The renderer cannot open a socket, load a remote script or navigate the
  window to an arbitrary origin. External links are handed to the OS browser.
- Renderer-facing IPC is registered through `secureHandle`, which checks the
  sender frame. Handlers that accept paths, URLs or content add their own
  length, type and range checks.

### Untrusted content

- Markdown is sanitised with DOMPurify before it reaches the DOM. The project
  pins **DOMPurify 3.4.17 or newer**; the `npm audit` production tree is clean.
- Scripts, event handlers, iframes, `javascript:` URLs, SVG and inline styles
  are stripped. Links are hardened with `target="_blank" rel="noopener"`.
- Tool-step detail, attachment names and model output are rendered as text, not
  as HTML.

### Network egress

- `web_fetch` rejects loopback, private ranges, CGNAT, link-local metadata
  (`169.254.169.254`), multicast/reserved ranges, decimal/hex/shorthand IP
  spellings, single-label intranet hosts, `.local`/`.internal` names and
  credentials in URLs.
- A hostname check alone is not enough. The actual DNS answers are checked at
  connection time and the socket is pinned to those addresses, so a public name
  that resolves to `127.0.0.1` or a metadata address is refused rather than
  followed (DNS rebinding). Every redirect repeats the check.
- `web_search` goes through the same request path. The search key is read only
  in the main process.
- The remote-image proxy applies the same host and DNS checks, accepts raster
  types only, refuses SVG and URL credentials, re-checks each redirect, and caps
  a response at **5 MB while it streams** and **15 seconds** end to end. A
  missing or lying `Content-Length` cannot make the app buffer an unbounded
  body.
- The only bypass is the test-only `OPENPLOT_WEB_ALLOW_LOCAL=1`, read once at
  module load. The packaged app never sets it.

### Data at rest

- Provider API keys and the web-search key are encrypted with the OS credential
  vault through Electron `safeStorage` when available (DPAPI, Keychain or
  libsecret). The database stores an `enc:v1:` envelope, not the plaintext.
- Legacy plaintext web-search rows are re-sealed once at startup. If encryption
  is unavailable, the app keeps working with a plaintext fallback and uses the
  OS file permissions as the remaining boundary.
- Secret settings are redacted at the IPC boundary. The renderer receives
  `webSearchApiKey: ''` and a `webSearchHasKey` flag, never the key. Provider
  rows likewise expose `has_key`, never `api_key`.
- A **portable library copy** removes provider keys, the web-search key and
  stored execution approvals, and empties MCP environment objects. It is a data
  handoff, not a credential handoff.
- Local Time Machine snapshots contain the same database file, so any encrypted
  credentials inside it remain tied to the same OS account and credential vault.
  When the vault is unavailable, the fallback applies there too.

### Local files

- `files:read` is grant-based: only paths returned by the app's own picker or
  explicitly dropped by the user are readable, for 30 minutes.
- Secret-shaped paths (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.azure`, `.docker`,
  `.env*`, `.npmrc`, credential stores, `id_*` keys, `.pem`/`.key`/`.pfx`/
  `.kdbx`/`.ovpn`, and similar) are refused even when granted.
- The app's own data directory is refused even when granted, because it contains
  every chat, the story bible and the encrypted key material.
- The path is resolved with `realpath` and the **target** is checked for secret
  shapes, private roots and grants, so an innocent-looking symlink cannot become
  a read of a private key. Case folding covers Windows and macOS. Reads go
  through an open descriptor, use `O_NOFOLLOW` where the platform provides it,
  and are capped at 40 files / 2 MB each.

### Dangerous execution

- A plugin (JavaScript) or MCP server (a local command) runs only after the user
  approves that exact payload. Approvals are hashes of the code or command;
  editing either invalidates the approval.
- Disabling a plugin prevents evaluation, not just execution of its hooks.
  Settings lists every approval, flags changed or orphaned entries, and can
  revoke one immediately.
- Plugin code and MCP servers are **trusted code**. They run with the app's
  permissions and can read files, reach the network and write the database.
  `new Function` is a convenience boundary, not a sandbox. Only install code you
  wrote or audited.

### Database and local-only operation

- SQL identifiers are allow-listed and values are parameterised; hostile keys
  cannot rewrite a statement.
- Schema changes are ordered migrations with a pre-migration backup and a
  refusal to open a database written by a newer app.
- No account, analytics, telemetry, crash upload or background update ping. The
  only outbound traffic is the provider, web research and image hosts the user
  configured, plus links the user explicitly opens.

## Known residual risks

No desktop app can honestly claim to be “totally safe”. These are the remaining
boundaries in 1.3.0:

- **A renderer compromise is serious.** CSP and DOMPurify are layered defences,
  not a proof. If script execution is achieved in the renderer, the attacker can
  use the preload capabilities available to the page.
- **Local provider probes are user-directed.** The model/probe channels accept
  the base URL the user enters (including Ollama/LM Studio). Cloud metadata
  hostnames are refused, but the app does not ask for a native per-origin
  confirmation for private endpoints. A successful XSS could therefore attempt
  to reach a local HTTP service.
- **MCP environment variables are not OS-vault encrypted.** The MCP editor needs
  to show and edit them, so they are stored in the local database and are
  removed from portable exports. Avoid long-lived production secrets there, or
  use an OS-encrypted disk.
- **Approved code is code.** A malicious plugin or MCP server can do anything
  the app can. Approval is a user decision, not a sandbox.
- **Prompt injection is a content problem.** A web page or model output can ask
  the model to call tools. The tools still run inside the app's capabilities;
  review tool actions and use a narrow model for untrusted content.
- **Release provenance.** Binaries are built by the project's GitHub Actions
  workflow. Building from the tagged source is the strongest way to verify what
  you run.

## Security test coverage

`npm test` includes `scripts/security-test.mjs`, which attacks the compiled
main-process code and a real temporary database. The current suite covers:

- SSRF host guards and DNS answers that resolve to loopback/private space;
- protocol and file-scheme refusals;
- SQL identifier injection, prototype pollution, hostile payload types and NUL
  bytes;
- tool-step floods and long-term storage growth, including compaction;
- provider-key and web-search-key encryption plus renderer redaction;
- portable-export stripping of keys, MCP environment variables and approvals;
- attachment grants, private roots, path-length limits and symlink escapes;
- disabled/unapproved plugins and disabled MCP servers;
- remote-image scheme, host, credential, redirect, MIME and size caps.

`scripts/gui-test.mjs` and `scripts/xss-test.mjs` boot the real renderer for
keyboard, focus and stored-XSS checks. Run `npm run test:e2e` for both GUI
groups. A green suite is evidence, not a guarantee; report a failing check
rather than weakening it.

## Safe harbour

Good-faith security research is welcome. I will not pursue legal action for
research that stays within this scope, avoids privacy violations and data
destruction, does not degrade other users' experience, and gives me a chance to
fix the issue before public disclosure. Test against your own installation and
your own data; do not test other people's machines or data.

## Credit

Reporters are credited in the changelog and release notes unless they ask to
stay anonymous.
