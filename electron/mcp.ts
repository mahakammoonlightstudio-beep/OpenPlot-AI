/**
 * MCP bridge (v1.2.3 Task 13).
 *
 * Speaks Model Context Protocol over stdio — newline-delimited JSON-RPC 2.0 —
 * to servers the user registered in Settings → MCP. Deliberately free of
 * Electron imports so the whole bridge can be exercised by a headless test with
 * a mock server.
 *
 * Safety rules that are enforced here, not in the docs:
 *  - a stored definition never spawns anything; only `enabled` servers start,
 *    and only when `startMcpServers` is called (after the window is ready),
 *  - every child is killed on quit, on restart and on a failed start,
 *  - startup gets 10 s, a tool call 30 s, and a single response line is capped
 *    at 1 MB so a chatty server cannot exhaust memory,
 *  - results handed to the model are capped at 20k characters,
 *  - logs are a 300-line ring buffer per server.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_START_TIMEOUT_MS = 10_000;
/** Overridable so tests do not have to wait 30 s for a timeout path. */
export const mcpCallTimeoutMs = () => Number(process.env.OPENPLOT_MCP_CALL_TIMEOUT_MS) || 30_000;
export const MCP_RESPONSE_CAP_BYTES = 1024 * 1024;
export const MAX_MCP_RESULT_CHARS = 20_000;
const MAX_LOG_LINES = 300;
const TOOL_PREFIX = 'mcp__';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  /** JSON array string, as stored in the database. */
  args?: string;
  /** JSON object string of extra environment variables. */
  env?: string;
  enabled?: number | boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  input_schema: any;
  /** Server id + original tool name, for routing and error messages. */
  server: string;
  tool: string;
}

export interface McpStatus {
  id: string;
  name: string;
  status: 'stopped' | 'starting' | 'connected' | 'error';
  tools: number;
  /** Real tool names as advertised to the model, so the prompt cannot lie. */
  toolNames: string[];
  lastError: string | null;
  command: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class McpServer {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  private args: string[] = [];
  private env: Record<string, string> = {};
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools: McpToolDef[] = [];
  private logs: string[] = [];
  private lastError: string | null = null;
  /** True once initialize + tools/list answered — a server with zero tools is
   *  still connected, which "tools.length > 0" could never express. */
  private ready = false;

  constructor(cfg: McpServerConfig) {
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.command = cfg.command || '';
    this.args = safeJson(cfg.args, []);
    this.env = safeJson(cfg.env, {});
  }

  private log(line: string): void {
    this.logs.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
  }

  status(): McpStatus {
    const status: McpStatus['status'] = this.ready && this.child
      ? 'connected'
      : this.child
        ? 'starting'
        : this.lastError
          ? 'error'
          : 'stopped';
    return {
      id: this.id,
      name: this.name,
      status,
      tools: this.tools.length,
      toolNames: this.tools.map((t) => t.name),
      lastError: this.lastError,
      command: this.command
    };
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  async start(): Promise<McpStatus> {
    this.stop();
    this.tools = [];
    this.ready = false;
    this.lastError = null;
    if (!this.command.trim()) {
      this.lastError = 'No command configured.';
      return this.status();
    }
    const spec = spawnSpec(this.command, this.args);
    try {
      this.log(`spawn ${spec.command} ${spec.args.join(' ')}`.trim());
      this.child = spawn(spec.command, spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env },
        windowsHide: true
      }) as ChildProcessWithoutNullStreams;
    } catch (e: any) {
      this.lastError = `Could not start: ${e?.message || e}`;
      this.child = null;
      return this.status();
    }

    const child = this.child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) this.log(`stderr: ${line.trim()}`);
    });
    child.on('error', (err) => {
      this.lastError = err.message;
      this.log(`error: ${err.message}`);
      this.failPending(err.message);
    });
    child.on('exit', (code, signal) => {
      this.log(`exit code=${code} signal=${signal}`);
      if (this.child === child) this.child = null;
      this.ready = false;
      const reason = code === 0 ? 'Server stopped.' : `Server exited with code ${code}.`;
      // A non-zero exit before the handshake is the whole story the user needs.
      if (code !== 0 && !this.tools.length) this.lastError = reason;
      this.failPending(reason);
    });

    try {
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'OpenPlot AI', version: '1.2.3' }
      }, MCP_START_TIMEOUT_MS);
      this.notify('notifications/initialized', {});
      const listed = await this.request('tools/list', {}, MCP_START_TIMEOUT_MS);
      this.tools = normalizeTools(this, listed?.tools || []);
      this.ready = true;
      this.lastError = null;
      this.log(`ready with ${this.tools.length} tool(s)`);
    } catch (e: any) {
      this.ready = false;
      // Keep the exit reason when the process died mid-handshake: "exited with
      // code 3" is far more useful than "Server stopped".
      this.lastError = this.lastError && /exited with code/.test(this.lastError)
        ? this.lastError
        : (e?.message || String(e));
      this.log(`handshake failed: ${this.lastError}`);
      this.stop();
    }
    return this.status();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MCP_RESPONSE_CAP_BYTES) {
      this.log(`response exceeded ${MCP_RESPONSE_CAP_BYTES} bytes — dropping the connection`);
      this.lastError = 'Server sent an oversized response (over 1 MB) and was disconnected.';
      // Fail the waiting call with the real reason before tearing the child
      // down, so the model (and the log) learn why instead of "stopped".
      this.failPending(this.lastError);
      this.stop();
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`ignored non-JSON line: ${line.slice(0, 120)}`);
        continue;
      }
      if (msg.id == null) continue; // notification (e.g. logs/notifications/message)
      const entry = this.pending.get(Number(msg.id));
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(Number(msg.id));
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    }
  }

  private failPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private send(payload: any): void {
    if (!this.child) throw new Error('Server is not running.');
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  private notify(method: string, params: any): void {
    try { this.send({ jsonrpc: '2.0', method, params }); } catch { /* no server */ }
  }

  private request(method: string, params: any, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(e?.message || String(e)));
      }
    });
  }

  /** Start with up to three attempts and a small backoff between them. */
  async startWithRetries(attempts = 3): Promise<McpStatus> {
    let status = await this.start();
    for (let i = 1; i < attempts && status.status === 'error'; i++) {
      this.log(`retry ${i}`);
      await delay(200 * i);
      status = await this.start();
    }
    return status;
  }

  async call(tool: string, input: any): Promise<string> {
    if (!this.child) throw new Error(`MCP server "${this.name}" is not running.`);
    const result = await this.request('tools/call', { name: tool, arguments: input ?? {} }, mcpCallTimeoutMs());
    return renderResult(result);
  }

  toolDefs(): McpToolDef[] {
    return this.tools;
  }

  stop(): void {
    this.failPending('Server stopped.');
    const child = this.child;
    this.child = null;
    this.buf = '';
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  }
}

/**
 * How to launch a configured command.
 *
 * Windows ships `npx`, `uvx` and friends as `.cmd` shims, which cannot be
 * executed directly — they need `cmd.exe /c`. Routing through `cmd.exe`
 * explicitly (instead of `shell: true`) keeps Node's own argument quoting, so a
 * path with spaces survives; a plain executable is spawned directly on every
 * platform so signals and stdin reach the real process.
 */
function spawnSpec(command: string, args: string[]): { command: string; args: string[] } {
  const needsCmdShim = process.platform === 'win32'
    && (/["']?[^\\/]+$/i.test(command) && !/\.exe$/i.test(command))
    && (/\.(cmd|bat)$/i.test(command) || !/[\\/]/.test(command));
  if (!needsCmdShim) return { command, args };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function normalizeTools(server: McpServer, tools: any[]): McpToolDef[] {
  return tools
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      // Provider-safe name: `mcp__{server}__{tool}` with anything odd replaced.
      name: `${TOOL_PREFIX}${sanitize(server.name || server.id)}__${sanitize(t.name)}`,
      description: typeof t.description === 'string' && t.description.trim()
        ? `[MCP:${server.name}] ${t.description}`
        : `MCP tool ${t.name} from ${server.name}.`,
      input_schema: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} },
      server: server.id,
      tool: t.name
    }));
}

const sanitize = (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

/** MCP returns content blocks; flatten to text and cap what reaches the model. */
function renderResult(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .map((b: any) => (typeof b?.text === 'string' ? b.text : b?.type === 'image' ? '[image omitted]' : ''))
    .filter(Boolean)
    .join('\n');
  const body = text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : '');
  const value = body || '(no output)';
  if (result?.isError) return `Error from MCP tool: ${value}`.slice(0, MAX_MCP_RESULT_CHARS);
  return value.length > MAX_MCP_RESULT_CHARS
    ? value.slice(0, MAX_MCP_RESULT_CHARS) + `\n[truncated: showing the first ${MAX_MCP_RESULT_CHARS} characters]`
    : value;
}

// ------------------------------------------------------------------ registry ---

const servers = new Map<string, McpServer>();

/**
 * Start (or restart) the registry for the given definitions. Servers that are
 * no longer enabled are stopped, and their processes never outlive this call.
 */
export async function startMcpServers(configs: McpServerConfig[]): Promise<McpStatus[]> {
  const wanted = new Map((configs || []).filter((c) => Number(c.enabled) === 1).map((c) => [c.id, c]));

  for (const [id, server] of [...servers]) {
    if (!wanted.has(id)) {
      server.stop();
      servers.delete(id);
    }
  }

  const statuses = await Promise.all([...wanted.values()].map(async (cfg) => {
    const existing = servers.get(cfg.id);
    const server = new McpServer(cfg);
    servers.set(cfg.id, server);
    existing?.stop();
    return server.startWithRetries();
  }));
  return statuses;
}

export function stopMcpServer(id: string): McpStatus | null {
  const server = servers.get(id);
  if (!server) return null;
  server.stop();
  servers.delete(id);
  return server.status();
}

export function stopAllMcp(): void {
  for (const [, server] of servers) server.stop();
  servers.clear();
}

export async function restartMcpServer(cfg: McpServerConfig): Promise<McpStatus | null> {
  const existing = servers.get(cfg.id);
  existing?.stop();
  servers.delete(cfg.id);
  if (Number(cfg.enabled) !== 1) return null;
  const server = new McpServer(cfg);
  servers.set(cfg.id, server);
  return server.startWithRetries();
}

export function mcpStatuses(): McpStatus[] {
  return [...servers.values()].map((s) => s.status());
}

export function mcpLogs(id: string): string[] {
  return servers.get(id)?.getLogs() || [];
}

/** Every tool from every connected server, ready for the provider's schema. */
export function mcpToolDefs(): McpToolDef[] {
  return [...servers.values()].flatMap((s) => (s.status().status === 'connected' ? s.toolDefs() : []));
}

export function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(TOOL_PREFIX);
}

/** Route a `mcp__…` call to its server. Errors are returned, not thrown. */
export async function callMcpTool(name: string, input: any): Promise<string> {
  const def = mcpToolDefs().find((t) => t.name === name);
  if (!def) {
    const known = [...servers.values()];
    const described = known.map((s) => `${s.name} (${s.status().status})`).join(', ');
    return JSON.stringify({
      error: known.length
        ? `MCP tool "${name}" is not available. Configured servers: ${described}.`
        : `MCP tool "${name}" is not available — no MCP server is connected.`
    });
  }
  const server = servers.get(def.server);
  if (!server) return JSON.stringify({ error: `MCP server for "${name}" is no longer running.` });
  try {
    const out = await server.call(def.tool, input);
    return out;
  } catch (e: any) {
    return JSON.stringify({ error: `MCP call failed: ${e?.message || e}` });
  }
}
