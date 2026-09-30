import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { toolDefsForApi, executeTool, ToolCall } from './tools';

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: string[];
  kind?: 'auto' | 'openai' | 'anthropic';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface GenOptions {
  provider: ProviderConfig;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  toolsEnabled?: boolean;
  projectId?: string | null;
}

export interface GenChunk {
  type: 'text' | 'thinking' | 'replaceText' | 'tool' | 'info' | 'error';
  text?: string;
  tool?: { name: string; result: string };
}

export interface GenResult {
  text: string;
  thinking: string;
  toolsUsed: string[];
  /** Prompt tokens actually billed (from provider usage) or estimated. */
  tokensIn?: number;
  /** Completion tokens actually billed (from provider usage) or estimated. */
  tokensOut?: number;
}

// ~4 chars per token is a decent cross-model heuristic for the FALLBACK
// estimate (used when the provider doesn't report usage).
function estimateTokens(s: string): number {
  return Math.ceil((s || '').length / 4);
}

export class AbortedError extends Error {
  constructor() { super('aborted'); this.name = 'AbortedError'; }
}

// ---------- low-level HTTP with live SSE ----------

interface HttpResult { status: number; body: string; aborted: boolean }

/**
 * Incremental SSE parser: feed raw network chunks, get complete events
 * out as soon as they arrive (so the renderer can render live).
 */
class SseParser {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n\r?\n/);
    this.buf = parts.pop() || '';
    return parts;
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest.trim() ? [rest] : [];
  }
}

function dataLines(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
}

// A stream that goes silent (proxy cut the tunnel, provider crash, laptop
// sleep) used to hang forever — res.on('end') never fires. The watchdog
// destroys the connection after IDLE_TIMEOUT_MS without any bytes.
const IDLE_TIMEOUT_MS = 90_000;

function httpRequest(
  urlStr: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
  onData: ((chunk: string) => void) | null,
  getSignal?: () => boolean
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      url,
      {
        method: opts.method,
        headers: { 'Content-Type': 'application/json', ...opts.headers }
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
          armIdleWatchdog();
          if (onData) {
            try { onData(chunk); } catch { /* never kill the stream over a parse hiccup */ }
          }
        });
        res.on('end', () => {
          if (idleTimer) clearTimeout(idleTimer);
          resolve({ status: res.statusCode || 0, body, aborted: false });
        });
        res.on('error', (err) => {
          if (idleTimer) clearTimeout(idleTimer);
          reject(err);
        });
      }
    );
    // Guard against hung connections (firewalled endpoints, dead hosts):
    // give up after 30s so the UI shows an error instead of "Fetching…" forever.
    const timeout = setTimeout(() => {
      req.destroy(new Error('Connection timed out after 30s — the endpoint did not respond.'));
    }, 30000);
    // Once a streaming response has started, the connect-timeout no longer
    // protects us: a stream that stalls mid-generation (SSE keepalives stop,
    // proxy dies silently) would hang the chat forever. Watchdog restarts on
    // every received byte and fires only after IDLE_TIMEOUT_MS of silence.
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        req.destroy(new Error('The stream went silent for 90s and was aborted. Usually a dropped connection — retry.'));
      }, IDLE_TIMEOUT_MS);
    };
    req.on('response', () => {
      clearTimeout(timeout);
      armIdleWatchdog();
    });
    req.on('error', (err: any) => {
      clearTimeout(timeout);
      if (getSignal && getSignal()) {
        resolve({ status: 0, body: '', aborted: true });
      } else {
        reject(err);
      }
    });
    if (getSignal) {
      const timer = setInterval(() => {
        if (getSignal()) {
          clearInterval(timer);
          req.destroy(new AbortedError());
        }
      }, 120);
    const clear = () => clearInterval(timer);
    req.on('close', () => { clear(); if (idleTimer) clearTimeout(idleTimer); });
    req.on('error', () => { clear(); if (idleTimer) clearTimeout(idleTimer); });
    }
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------- OpenAI-compatible streaming ----------

/**
 * Non-streaming fallback for endpoints that reject `stream:true`. Returns null
 * when the endpoint fails for a non-streaming reason (caller then reports the
 * original error). Emits one text chunk at the end so the UI still works.
 */
async function runOpenAINonStream(
  opts: GenOptions,
  allowTools: boolean,
  onChunk: (c: GenChunk) => void,
  aborted: () => boolean
): Promise<GenResult | null> {
  const { provider } = opts;
  const bases = baseUrlCandidates(provider.baseUrl);
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const messages = [...opts.messages];
  const toolsUsed: string[] = [];
  let text = '';
  let thinking = '';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;

  for (let round = 0; round < 10; round++) {
    if (aborted()) break;
    const body: any = {
      model: opts.model,
      stream: false,
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 1,
      messages
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (allowTools && opts.toolsEnabled) {
      body.tools = toolDefsForApi().map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    const outcome = await tryHttpRequest((b) => `${b}/chat/completions`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, null, aborted);
    if ('networkError' in outcome) return null;
    const res = outcome.res;
    if (res.aborted) break;
    if (res.status >= 400 || isHtmlBody(res.body)) return null;
    let json: any;
    try { json = JSON.parse(res.body); } catch { return null; }
    if (json.error) return null;

    const msg = json.choices?.[0]?.message || {};
    // Usage is cumulative per round in the non-stream path (each round re-sends
    // everything) — capture the LAST reported values, not the sum.
    if (json.usage && (json.usage.prompt_tokens != null || json.usage.completion_tokens != null)) {
      tokensIn = json.usage.prompt_tokens ?? tokensIn;
      tokensOut = json.usage.completion_tokens ?? tokensOut;
    }
    const thinkPiece: string | undefined = msg.reasoning || msg.reasoning_content;
    if (thinkPiece) { thinking += thinkPiece; onChunk({ type: 'thinking', text: thinkPiece }); }
    const piece = String(msg.content || '');
    if (piece) { text += piece; onChunk({ type: 'text', text: piece }); }

    if (msg.tool_calls?.length && allowTools && opts.toolsEnabled) {
      messages.push({ role: 'assistant', content: piece || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        if (!tc?.function?.name) continue;
        let input: any = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        const result = executeTool({ name: tc.function.name, input } as ToolCall, { projectId: opts.projectId });
        toolsUsed.push(tc.function.name);
        onChunk({ type: 'tool', tool: { name: tc.function.name, result } });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }
    break;
  }
  return { text, thinking, toolsUsed, tokensIn, tokensOut };
}

async function runOpenAI(
  opts: GenOptions,
  allowTools: boolean,
  onChunk: (c: GenChunk) => void,
  aborted: () => boolean
): Promise<GenResult> {
  const { provider } = opts;
  const bases = baseUrlCandidates(provider.baseUrl);
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const body: any = {
    model: opts.model,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.topP ?? 1
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (allowTools && opts.toolsEnabled) {
    body.tools = toolDefsForApi().map((t) => ({ type: 'function', function: t }));
    body.tool_choice = 'auto';
  }

  const toolsUsed: string[] = [];
  let text = '';
  let thinking = '';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  const messages = [...opts.messages];

  for (let round = 0; round < 10; round++) {
    if (aborted()) break;
    body.messages = messages;
    const parser = new SseParser();
    let streamErr: Error | null = null;
    const outcome = await tryHttpRequest(
      (b) => `${b}/chat/completions`,
      bases,
      { method: 'POST', headers, body: JSON.stringify(body) },
      // parse & emit chunks LIVE as they arrive
      (raw) => {
        if (streamErr) return;
        for (const ev of parser.push(raw)) {
          for (const payload of dataLines(ev)) {
            if (payload === '[DONE]') continue;
            let json: any;
            try { json = JSON.parse(payload); } catch { continue; }
            // Providers that report usage mid-stream (OpenAI with
            // include_usage, most relays' final chunk) — remember the latest.
            if (json.usage && (json.usage.prompt_tokens != null || json.usage.completion_tokens != null)) {
              tokensIn = json.usage.prompt_tokens ?? tokensIn;
              tokensOut = json.usage.completion_tokens ?? tokensOut;
            }
            if (json.type === 'error' || json.error) {
              // Capture instead of throwing: this callback runs inside the
              // socket 'data' handler, where a throw was silently swallowed —
              // the stream then "ended normally" and a truncated reply was
              // saved as if it were the model's full answer.
              streamErr = new Error(json.error?.message || json.message || 'stream error');
              return;
            }
            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            const thinkPiece: string | undefined = delta.reasoning || delta.reasoning_content;
            if (thinkPiece) onChunk({ type: 'thinking', text: thinkPiece });
            if (delta.content) onChunk({ type: 'text', text: delta.content });
          }
        }
      },
      aborted
    );
    if ('networkError' in outcome) throw outcome.networkError;
    const res = outcome.res;
    if (res.aborted) break;
    if (streamErr) throw streamErr;
    if (res.status >= 400) {
      const msg = extractError(res.body);
      // Endpoint can't do SSE (or rejects stream:true)? Retry once without
      // streaming — broadens model compatibility with minimal complexity.
      if (body.stream && (res.status === 400 || res.status === 404 || res.status === 405 || res.status === 422 || /stream/i.test(msg))) {
        const nonStream = await runOpenAINonStream(opts, allowTools, onChunk, aborted);
        if (nonStream !== null) return nonStream;
      }
      if (allowTools && opts.toolsEnabled && /tool/i.test(msg)) {
        return runOpenAI(opts, false, onChunk, aborted);
      }
      throw new Error(statusHint(res.status, msg));
    }
    // Safety net: some hosts serve an HTML page with status 200
    if (isHtmlBody(res.body)) {
      throw new Error(
        'The endpoint answered with a web page, not an API response. Check the Base URL — it should point to the API root (e.g. https://host/v1).'
      );
    }

    // Re-parse the accumulated body for the authoritative result
    // (tool-call assembly needs the full event list anyway).
    const allEvents = splitEvents(res.body);
    let accText = '';
    let accThink = '';
    let finish = '';
    const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};

    for (const ev of allEvents) {
      for (const payload of dataLines(ev)) {
        if (payload === '[DONE]') continue;
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage && (json.usage.prompt_tokens != null || json.usage.completion_tokens != null)) {
          tokensIn = json.usage.prompt_tokens ?? tokensIn;
          tokensOut = json.usage.completion_tokens ?? tokensOut;
        }
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const thinkPiece: string | undefined = delta.reasoning || delta.reasoning_content;
        if (thinkPiece) accThink += thinkPiece;
        if (delta.content) accText += delta.content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const slot = (toolAcc[tc.index] ||= { args: '' });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    text += accText;
    thinking += accThink;

    if (finish === 'tool_calls' && Object.keys(toolAcc).length) {
      // Order matters for the OpenAI API: first the assistant message that
      // requested the calls, THEN the tool results.
      const tcMessages: any[] = [];
      const toolResults: any[] = [];
      for (const k of Object.keys(toolAcc).map(Number).sort((a, b) => a - b)) {
        const t = toolAcc[k];
        if (!t.name) continue;
        let input: any = {};
        try { input = JSON.parse(t.args || '{}'); } catch { input = {}; }
        tcMessages.push({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } });
        const result = executeTool({ name: t.name, input } as ToolCall, { projectId: opts.projectId });
        toolsUsed.push(t.name);
        onChunk({ type: 'tool', tool: { name: t.name, result } });
        toolResults.push({ role: 'tool', tool_call_id: t.id, content: result });
      }
      if (tcMessages.length) messages.push({ role: 'assistant', content: accText || '', tool_calls: tcMessages });
      messages.push(...toolResults);
      continue; // next round with tool results
    }
    break;
  }

  return {
    text, thinking, toolsUsed,
    tokensIn: tokensIn ?? estimateTokens(JSON.stringify(messages)),
    tokensOut: tokensOut ?? (estimateTokens(text) + estimateTokens(thinking))
  };
}

// ---------- Anthropic streaming ----------

async function runAnthropic(
  opts: GenOptions,
  allowTools: boolean,
  onChunk: (c: GenChunk) => void,
  aborted: () => boolean,
  allowThinking: boolean = true
): Promise<GenResult> {
  const { provider } = opts;
  const bases = baseUrlCandidates(provider.baseUrl);
  const headers: Record<string, string> = {
    'x-api-key': provider.apiKey,
    'anthropic-version': '2023-06-01'
  };

  const systemParts: string[] = [];
  const chatMsgs: any[] = [];
  for (const m of opts.messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else chatMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  const maxTokens = Math.max(opts.maxTokens || 4096, 1024);
  const body: any = {
    model: opts.model,
    max_tokens: maxTokens,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.topP ?? 1,
    messages: chatMsgs
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (opts.thinkingEnabled && allowThinking) {
    const budget = Math.max(1024, opts.thinkingBudget || 4096);
    body.thinking = { type: 'enabled', budget_tokens: budget };
    body.max_tokens = Math.max(maxTokens, budget + 2048);
    delete body.temperature;
    delete body.top_p;
  }
  if (allowTools && opts.toolsEnabled) {
    body.tools = toolDefsForApi();
  }

  const toolsUsed: string[] = [];
  let text = '';
  let thinking = '';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;

  for (let round = 0; round < 10; round++) {
    if (aborted()) break;
    body.messages = chatMsgs;
    const parser = new SseParser();
    let streamErr: Error | null = null;
    const outcome = await tryHttpRequest(
      (b) => `${b}/messages`,
      bases,
      { method: 'POST', headers, body: JSON.stringify(body) },
      (raw) => {
        if (streamErr) return;
        for (const ev of parser.push(raw)) {
          for (const payload of dataLines(ev)) {
            if (!payload || payload === '[DONE]') continue;
            let json: any;
            try { json = JSON.parse(payload); } catch { continue; }
            // Anthropic reports usage on message_start (input) and every
            // message_delta (cumulative output).
            if (json.type === 'message_start' && json.message?.usage?.input_tokens != null) {
              tokensIn = json.message.usage.input_tokens;
            }
            if (json.type === 'message_delta' && json.usage?.output_tokens != null) {
              tokensOut = json.usage.output_tokens;
            }
            if (json.type === 'error') {
              // Same rationale as the OpenAI path: a throw inside the socket
              // 'data' handler is swallowed upstream, so capture and fail
              // after the request settles instead.
              streamErr = new Error(json.error?.message || 'stream error');
              return;
            }
            if (json.type === 'content_block_delta') {
              const d = json.delta || {};
              if (d.type === 'text_delta') onChunk({ type: 'text', text: d.text });
              else if (d.type === 'thinking_delta') onChunk({ type: 'thinking', text: d.thinking });
            }
          }
        }
      },
      aborted
    );
    if ('networkError' in outcome) throw outcome.networkError;
    const res = outcome.res;
    if (res.aborted) break;
    if (streamErr) throw streamErr;
    if (res.status >= 400) {
      const msg = extractError(res.body);
      if (allowTools && opts.toolsEnabled && /tool/i.test(msg)) {
        return runAnthropic(opts, false, onChunk, aborted, allowThinking);
      }
      // Extended thinking unsupported (older Claude models, proxies): retry
      // once without it so thinking-default-ON never hard-fails a chat.
      if (allowThinking && opts.thinkingEnabled && /thinking|budget/i.test(msg)) {
        return runAnthropic(opts, allowTools, onChunk, aborted, false);
      }
      throw new Error(statusHint(res.status, msg));
    }

    const events = splitEvents(res.body);
    // blocks keyed by index
    const blocks: Record<number, { type: string; text: string; json: string; id?: string; name?: string }> = {};
    let stopReason = '';

    for (const ev of events) {
      for (const payload of dataLines(ev)) {
        if (!payload || payload === '[DONE]') continue;
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.type === 'message_start' && json.message?.usage?.input_tokens != null) tokensIn = json.message.usage.input_tokens;
        if (json.type === 'message_delta' && json.usage?.output_tokens != null) tokensOut = json.usage.output_tokens;
        if (json.type === 'content_block_start') {
          const i = json.index;
          blocks[i] = {
            type: json.content_block?.type || 'text',
            text: '',
            json: '',
            id: json.content_block?.id,
            name: json.content_block?.name
          };
          if (json.content_block?.type === 'thinking') onChunk({ type: 'info', text: 'thinking…' });
        } else if (json.type === 'content_block_delta') {
          const i = json.index;
          const b = blocks[i] || (blocks[i] = { type: 'text', text: '', json: '' });
          const d = json.delta || {};
          if (d.type === 'text_delta') {
            b.text += d.text;
          } else if (d.type === 'thinking_delta') {
            b.text += d.thinking;
          } else if (d.type === 'input_json_delta') {
            b.json += d.partial_json;
          }
        } else if (json.type === 'message_delta') {
          stopReason = json.delta?.stop_reason || stopReason;
        } else if (json.type === 'error') {
          throw new Error(json.error?.message || 'stream error');
        }
      }
    }

    let roundText = '';
    let roundThink = '';
    const toolUses: any[] = [];
    for (const i of Object.keys(blocks).map(Number).sort((a, b) => a - b)) {
      const b = blocks[i];
      if (b.type === 'text') roundText += b.text;
      if (b.type === 'thinking') roundThink += b.text;
      if (b.type === 'tool_use') {
        let input: any = {};
        try { input = JSON.parse(b.json || '{}'); } catch { input = {}; }
        toolUses.push({ id: b.id, name: b.name, input });
      }
    }
    text += roundText;
    thinking += roundThink;

    if (stopReason === 'tool_use' && toolUses.length) {
      // Extended thinking requires thinking blocks to be preserved in the
      // assistant turn when continuing after tool use.
      const contentBlocks: any[] = [];
      if (roundThink) contentBlocks.push({ type: 'thinking', thinking: roundThink });
      if (roundText) contentBlocks.push({ type: 'text', text: roundText });
      for (const t of toolUses) contentBlocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
      chatMsgs.push({ role: 'assistant', content: contentBlocks });
      const results: any[] = [];
      for (const t of toolUses) {
        const result = executeTool({ name: t.name, input: t.input } as ToolCall, { projectId: opts.projectId });
        toolsUsed.push(t.name);
        onChunk({ type: 'tool', tool: { name: t.name, result } });
        results.push({ type: 'tool_result', tool_use_id: t.id, content: result });
      }
      chatMsgs.push({ role: 'user', content: results });
      continue;
    }
    break;
  }

  return {
    text, thinking, toolsUsed,
    tokensIn: tokensIn ?? estimateTokens(JSON.stringify(chatMsgs) + systemParts.join('\n')),
    tokensOut: tokensOut ?? (estimateTokens(text) + estimateTokens(thinking))
  };
}

function splitEvents(body: string): string[] {
  return body.split(/\r?\n\r?\n/).filter((e) => e.trim());
}

function extractError(body: string): string {
  const trimmed = (body || '').trim();
  try {
    const json = JSON.parse(trimmed);
    return json.error?.message || json.message || trimmed.slice(0, 300);
  } catch {
    // Not JSON — most likely the endpoint answered with an HTML page
    // (wrong base URL path, blocked gateway, login wall). Show a short,
    // human-readable reason instead of dumping raw markup into the toast.
    if (/^<!doctype html\b|^<html\b/i.test(trimmed)) {
      const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim().slice(0, 80) : '';
      return `The endpoint answered with a web page${pageTitle ? ` ("${pageTitle}")` : ''}, not an API response. Check the Base URL — it should point to the API root (e.g. https://host/v1), not a full chat/completions link.`;
    }
    return trimmed.slice(0, 200) || 'unknown error';
  }
}

/**
 * Human explanation for HTTP status codes returned by AI providers.
 * The raw provider message is appended when available — some providers
 * (e.g. Chinese relays) reply with opaque bodies like "openai_error".
 */
function statusHint(status: number, providerMsg: string): string {
  const raw = providerMsg && providerMsg !== 'unknown error' ? ` (provider said: "${providerMsg.slice(0, 120)}")` : '';
  switch (status) {
    case 400:
      return `The provider rejected the request as invalid (400).${raw} This usually means the model id doesn't exist on this endpoint — run "Save & test" to load the exact model list, or check the model name spelling.`;
    case 401:
    case 403:
      return `Authentication failed (${status}).${raw} Check that the API key is correct for this Base URL and has not expired.`;
    case 404:
      return `The API path was not found (404).${raw} The Base URL or the model id doesn't match this endpoint. Verify the Base URL points to the API root (e.g. https://host/v1) and pick a model from "Save & test".`;
    case 408:
      return `The provider timed out (408).${raw} Try again or use a smaller request.`;
    case 429:
      return `Rate limit or quota exceeded (429).${raw} Wait a moment before retrying, or check your plan/billing on the provider dashboard.`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `The provider server had an internal error (${status}).${raw} This is on the provider's side — retry later or switch models/providers.`;
    default:
      return `Provider error ${status}.${raw}`;
  }
}

// ---------- base URL normalization & fallback ----------

/**
 * Users often paste either the full endpoint (…/v1/chat/completions) or a
 * bare host without the /v1 suffix. Normalize the pasted URL to a probable
 * API root and produce candidate base URLs to try in order.
 */
export function baseUrlCandidates(rawUrl: string): string[] {
  const raw = (rawUrl || '').trim();
  if (!raw) return [];
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return [];
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
  const origin = u.origin;
  const path = u.pathname.replace(/\/+$/, ''); // ignore trailing slashes
  const candidates: string[] = [];
  const push = (s: string) => {
    const clean = String(s).replace(/\/+$/, '');
    if (clean && !candidates.includes(clean)) candidates.push(clean);
  };

  // Case 1: full endpoint pasted (…/v1/chat/completions, …/v1/messages, …)
  const epMatch = path.match(/(?:\/chat\/completions|\/messages|\/completions|\/models|\/embeddings)$/i);
  if (epMatch) {
    const withoutEp = path.slice(0, path.length - epMatch[0].length); // e.g. "/v1"
    const versionMatch = withoutEp.match(/\/(v\d+|api)$/i);
    if (versionMatch) {
      push(origin + withoutEp); // …/v1
      push(origin + withoutEp.slice(0, withoutEp.length - versionMatch[0].length)); // host root
    } else {
      push(origin + withoutEp); // whatever remains before the endpoint
      push(origin);
    }
    return candidates;
  }

  // Case 2: already a versioned API root (…/v1, …/api/v1, …/api)
  if (/\/(v\d+|api)$/i.test(path)) {
    push(origin + path);
    return candidates;
  }

  // Case 3: bare host or arbitrary path: try as-is, plus /v1 for bare hosts
  push(path ? origin + path : origin);
  if (!path) push(`${origin}/v1`);
  return candidates;
}

function isHtmlBody(body: string): boolean {
  return /^\s*(<!doctype html|<html)\b/i.test(body || '');
}

async function tryHttpRequest(
  buildUrl: (base: string) => string,
  baseCandidates: string[],
  opts: { method: string; headers: Record<string, string>; body?: string },
  onData: ((chunk: string) => void) | null,
  getSignal?: () => boolean
): Promise<{ res: HttpResult; base: string } | { networkError: Error }> {
  let lastError: Error | null = null;
  let lastRes: HttpResult | null = null;
  let lastBase = baseCandidates[0] || '';
  for (const base of baseCandidates) {
    if (getSignal && getSignal()) return { res: { status: 0, body: '', aborted: true }, base };
    lastBase = base;
    try {
      const res = await httpRequest(buildUrl(base), opts, onData, getSignal);
      if (res.aborted) return { res, base };
      // 4xx/5xx AND 200-with-an-HTML-page both mean "wrong place" —
      // fall through to the next candidate base URL.
      if (res.status >= 400 || isHtmlBody(res.body)) { lastRes = res; continue; }
      return { res, base };
    } catch (err: any) {
      // Abort wins immediately, network errors move on to the next candidate
      if (err instanceof AbortedError) return { res: { status: 0, body: '', aborted: true }, base };
      lastError = err;
    }
  }
  if (lastRes) return { res: lastRes, base: lastBase };
  return { networkError: lastError || new Error('No candidate base URL could be reached') };
}

export function isAnthropicStyle(p: ProviderConfig): boolean {
  if (!p?.baseUrl) return false;
  if (p.kind === 'anthropic') return true;
  if (p.kind === 'openai') return false;
  return /anthropic/i.test(p.baseUrl);
}

export async function runGeneration(
  opts: GenOptions,
  onChunk: (c: GenChunk) => void,
  aborted: () => boolean
): Promise<GenResult> {
  const style = isAnthropicStyle(opts.provider) ? runAnthropic : runOpenAI;
  const result = await style(opts, true, onChunk, aborted);

  // Post-process: some models wrap thinking in <think> tags in plain text
  const m = result.text.match(/<think>([\s\S]*?)<\/think>/);
  if (m) {
    const cleaned = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    onChunk({ type: 'thinking', text: m[1] });
    onChunk({ type: 'replaceText', text: cleaned });
    result.thinking = (result.thinking || '') + m[1];
    result.text = cleaned;
  }
  return result;
}

// ---------- model listing ----------

export async function fetchModels(provider: ProviderConfig): Promise<string[]> {
  const bases = baseUrlCandidates(provider.baseUrl);
  if (!bases.length) {
    throw new Error(
      `Invalid Base URL: "${provider.baseUrl || '(empty)'}". Example: https://api.openai.com/v1`
    );
  }
  if (isAnthropicStyle(provider)) {
    const outcome = await tryHttpRequest(
      (b) => `${b}/models?limit=100`,
      bases,
      { method: 'GET', headers: { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' } },
      null
    );
    if ('networkError' in outcome) {
      throw new Error(`Could not reach ${provider.baseUrl}: ${outcome.networkError.message}`);
    }
    if (outcome.res.status >= 400 || isHtmlBody(outcome.res.body)) {
      throw new Error(extractError(outcome.res.body));
    }
    const json = JSON.parse(outcome.res.body);
    return (json.data || []).map((m: any) => m.id).filter(Boolean);
  }
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const outcome = await tryHttpRequest(
    (b) => `${b}/models`,
    bases,
    { method: 'GET', headers },
    null
  );
  if ('networkError' in outcome) {
    throw new Error(`Could not reach ${provider.baseUrl}: ${outcome.networkError.message}`);
  }
  if (outcome.res.status >= 400 || isHtmlBody(outcome.res.body)) {
    throw new Error(extractError(outcome.res.body));
  }
  let json: any;
  try {
    json = JSON.parse(outcome.res.body);
  } catch {
    throw new Error(
      `The endpoint answered with a non-JSON response. Check the Base URL — it should point to the API root (e.g. https://host/v1).`
    );
  }
  const list = json.data || json.models || [];
  return list.map((m: any) => m.id || m.name).filter(Boolean);
}

// ---------- API key validation ----------

export interface KeyValidationResult {
  ok: boolean;
  /** What the check actually did: 'models-list' | 'chat-probe' | 'models-forbidden-but-reachable' */
  method: string;
  message: string;
}

/**
 * Validates an API key without burning tokens: try GET /models (free on most
 * providers). If the endpoint hides /models behind 403 but the key is fine,
 * fall back to a 1-token chat probe so the answer stays meaningful.
 */
export async function validateApiKey(provider: ProviderConfig): Promise<KeyValidationResult> {
  const bases = baseUrlCandidates(provider.baseUrl);
  if (!bases.length) {
    return { ok: false, method: '', message: `Invalid Base URL: "${provider.baseUrl || '(empty)'}"` };
  }
  const anthropic = isAnthropicStyle(provider);
  const authHeaders: Record<string, string> = anthropic
    ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
    : provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};

  if (provider.apiKey.trim()) {
    // One retry on transient statuses (rate limit / provider hiccup) so a
    // momentary 429 doesn't get reported as "your key is broken".
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await tryHttpRequest(
        (b) => (anthropic ? `${b}/models?limit=1` : `${b}/models`),
        bases,
        { method: 'GET', headers: authHeaders },
        null
      );
      if ('networkError' in outcome) {
        return { ok: false, method: 'models-list', message: `Could not reach ${provider.baseUrl}: ${outcome.networkError.message}` };
      }
      if (outcome.res.status < 400 && !isHtmlBody(outcome.res.body)) {
        return { ok: true, method: 'models-list', message: 'Key accepted (models list accessible).' };
      }
      if ((outcome.res.status === 429 || outcome.res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      if (outcome.res.status !== 403 && outcome.res.status !== 404) {
        return { ok: false, method: 'models-list', message: statusHint(outcome.res.status, extractError(outcome.res.body)) };
      }
      // /models hidden on this relay — fall through to a minimal chat probe
      break;
    }
  }

  // Minimal chat probe (costs ~1 token, works on relays that hide /models).
  // Prefer a model this provider actually hosts: relays reject unknown ids
  // before checking auth, which made a perfectly good key look invalid.
  const hosted = (provider.models || []).map((m) => String(m).trim()).filter(Boolean);
  const probeModel = hosted[0] || (anthropic ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini');
  const probeRes = anthropic
    ? await tryHttpRequest(
        (b) => `${b}/messages`,
        bases,
        { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) },
        null
      )
    : await tryHttpRequest(
        (b) => `${b}/chat/completions`,
        bases,
        { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) },
        null
      );
  if ('networkError' in probeRes) {
    return { ok: false, method: 'chat-probe', message: `Could not reach ${provider.baseUrl}: ${probeRes.networkError.message}` };
  }
  if (probeRes.res.status < 400 && !isHtmlBody(probeRes.res.body)) {
    return { ok: true, method: 'chat-probe', message: 'Key accepted (probe request succeeded).' };
  }
  const errMsg = extractError(probeRes.res.body);
  // A bad-model error means auth PASSED but the probe model isn't on this
  // relay — the key itself is valid. Covers both 400 and relays that answer
  // 404 for unknown models (several OpenAI-compatible gateways do).
  if ((probeRes.res.status === 400 || probeRes.res.status === 404) && /model|not found|invalid model/i.test(errMsg)) {
    return { ok: true, method: 'chat-probe', message: 'Key accepted (auth passed; probe model not hosted here).' };
  }
  if (probeRes.res.status === 401 || probeRes.res.status === 403) {
    return { ok: false, method: 'chat-probe', message: statusHint(probeRes.res.status, errMsg) };
  }
  return { ok: false, method: 'chat-probe', message: statusHint(probeRes.res.status, errMsg) };
}

// ---------- capability probe (Smart Mode) ----------

export interface ModelCapabilities {
  model: string;
  /** tool-calling roundtrip worked */
  tools: boolean;
  /** SSE streaming worked */
  streaming: boolean;
  /** reasoning/thinking field present */
  thinking: boolean;
  /** largest prompt echoed back correctly, in tokens (approx) */
  contextTokens: number;
  /** how the probe went */
  ok: boolean;
  error?: string;
  probedAt: number;
}

const CONTEXT_LADDER = [1024, 4096, 8192, 16384, 32768, 65536, 131072];

function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Smart Mode probe: figures out what a model/endpoint actually supports with
 * a handful of tiny requests:
 *  1. tools      — a tool_call roundtrip (declared + executed)
 *  2. streaming  — stream:true request, does any SSE chunk arrive
 *  3. thinking   — reasoning field in the delta
 *  4. context    — binary-ladder echo test: fill the prompt with filler to
 *                  approx N tokens and ask the model to echo a marker. The
 *                  largest N that survives is the practical context window.
 * All probes are capped so the whole sweep costs a few hundred tokens.
 */
export async function probeCapabilities(provider: ProviderConfig, model: string): Promise<ModelCapabilities> {
  const caps: ModelCapabilities = {
    model, tools: false, streaming: false, thinking: false,
    contextTokens: 0, ok: false, probedAt: Date.now()
  };
  const bases = baseUrlCandidates(provider.baseUrl);
  if (!bases.length) {
    caps.error = `Invalid Base URL: "${provider.baseUrl || '(empty)'}"`;
    return caps;
  }
  const anthropic = isAnthropicStyle(provider);
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
    : provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};

  // ---- 1. tools roundtrip (OpenAI-style; Anthropic checked via API shape) ----
  try {
    if (anthropic) {
      const body = {
        model,
        max_tokens: 256,
        tools: [{ name: 'echo_probe', description: 'Echo back the input', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
        messages: [{ role: 'user', content: 'Call the echo_probe tool with text "ok".' }]
      };
      const outcome = await tryHttpRequest((b) => `${b}/messages`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, null);
      if ('res' in outcome && outcome.res.status < 400) {
        const json = JSON.parse(outcome.res.body);
        caps.tools = (json.content || []).some((c: any) => c?.type === 'tool_use' && c?.name === 'echo_probe');
      }
    } else {
      const body = {
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Call the echo_probe tool with text "ok".' }],
        tools: [{ type: 'function', function: { name: 'echo_probe', description: 'Echo back the input', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }],
        tool_choice: 'auto'
      };
      const outcome = await tryHttpRequest((b) => `${b}/chat/completions`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, null);
      if ('res' in outcome && outcome.res.status < 400) {
        const json = JSON.parse(outcome.res.body);
        const msg = json.choices?.[0]?.message;
        caps.tools = !!msg?.tool_calls?.length;
      }
    }
  } catch { caps.tools = false; }

  // ---- 2 + 3. streaming & thinking (one SSE request) ----
  try {
    let sawChunk = false;
    let sawThinking = false;
    const parseChunk = (raw: string) => {
      if (raw.includes('data:')) sawChunk = true;
      if (/"reasoning"|"reasoning_content"|"thinking_delta"/.test(raw)) sawThinking = true;
    };
    if (anthropic) {
      const body = { model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Say OK.' }] };
      const outcome = await tryHttpRequest((b) => `${b}/messages`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, parseChunk);
      if ('res' in outcome && outcome.res.status < 400) { caps.streaming = sawChunk; caps.thinking = sawThinking; }
    } else {
      const body = { model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Say OK.' }] };
      const outcome = await tryHttpRequest((b) => `${b}/chat/completions`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, parseChunk);
      if ('res' in outcome && outcome.res.status < 400) { caps.streaming = sawChunk; caps.thinking = sawThinking; }
    }
  } catch { caps.streaming = false; }

  // ---- 4. context memory ladder (echo test, largest passing rung wins) ----
  try {
    const MARKER = 'XQ7MARKER42';
    for (const rung of CONTEXT_LADDER) {
      // filler sized so filler+question ≈ rung tokens (4 chars/token heuristic)
      const fillerLen = Math.max(0, rung * 4 - 256);
      const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(fillerLen / 27)).slice(0, fillerLen);
      const prompt = `${filler}\n\nIgnore the text above. Reply with exactly this single word: ${MARKER}`;
      let passed = false;
      if (anthropic) {
        const body = { model, max_tokens: 32, messages: [{ role: 'user', content: prompt }] };
        const outcome = await tryHttpRequest((b) => `${b}/messages`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, null);
        if ('res' in outcome && outcome.res.status < 400) {
          const json = JSON.parse(outcome.res.body);
          const reply = (json.content || []).map((c: any) => c?.text || '').join('');
          passed = reply.includes(MARKER);
        }
      } else {
        const body = { model, max_tokens: 32, messages: [{ role: 'user', content: prompt }] };
        const outcome = await tryHttpRequest((b) => `${b}/chat/completions`, bases, { method: 'POST', headers, body: JSON.stringify(body) }, null);
        if ('res' in outcome && outcome.res.status < 400) {
          const json = JSON.parse(outcome.res.body);
          passed = String(json.choices?.[0]?.message?.content || '').includes(MARKER);
        }
      }
      if (passed) caps.contextTokens = rung;
      else break;
    }
  } catch { /* keep whatever ladder rung passed */ }

  caps.ok = caps.streaming || caps.contextTokens > 0;
  return caps;
}

export interface ModelVerifyResult {
  ok: boolean;
  latencyMs: number;
  reply: string;
  error?: string;
}

/**
 * Cheap end-to-end check that a specific model actually works on this
 * provider: a minimal chat request (max_tokens capped) measuring latency.
 * Uses the non-streaming API for simplicity and a deterministic probe.
 */
export async function verifyModel(
  provider: ProviderConfig,
  model: string,
  getSignal?: () => boolean
): Promise<ModelVerifyResult> {
  const started = Date.now();
  const bases = baseUrlCandidates(provider.baseUrl);
  if (!bases.length) {
    return {
      ok: false, latencyMs: 0, reply: '',
      error: `Invalid Base URL: "${provider.baseUrl || '(empty)'}". Example: https://api.openai.com/v1`
    };
  }
  const prompt = 'Reply with exactly: OK';
  try {
    if (isAnthropicStyle(provider)) {
      const body = {
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: prompt }]
      };
      const outcome = await tryHttpRequest(
        (b) => `${b}/messages`,
        bases,
        { method: 'POST', headers: { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) },
        null,
        getSignal
      );
      if ('networkError' in outcome) return { ok: false, latencyMs: Date.now() - started, reply: '', error: outcome.networkError.message };
      const latencyMs = Date.now() - started;
      // Aborted probes must be reported distinctly — the old path fell into
      // the status>=400 branch and surfaced as "Provider error 0".
      if (outcome.res.aborted || (getSignal && getSignal())) {
        return { ok: false, latencyMs, reply: '', error: 'aborted' };
      }
      if (outcome.res.status >= 400 || isHtmlBody(outcome.res.body)) {
        return { ok: false, latencyMs, reply: '', error: statusHint(outcome.res.status, extractError(outcome.res.body)) };
      }
      const json = JSON.parse(outcome.res.body);
      const reply = (json.content || []).map((c: any) => c?.text || '').join('').trim();
      return { ok: true, latencyMs, reply };
    }
    const body = {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    };
    const outcome = await tryHttpRequest(
      (b) => `${b}/chat/completions`,
      bases,
      { method: 'POST', headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}, body: JSON.stringify(body) },
      null,
      getSignal
    );
    if ('networkError' in outcome) return { ok: false, latencyMs: Date.now() - started, reply: '', error: outcome.networkError.message };
    const latencyMs = Date.now() - started;
    if (outcome.res.aborted || (getSignal && getSignal())) {
      return { ok: false, latencyMs, reply: '', error: 'aborted' };
    }
    if (outcome.res.status >= 400 || isHtmlBody(outcome.res.body)) {
      return { ok: false, latencyMs, reply: '', error: statusHint(outcome.res.status, extractError(outcome.res.body)) };
    }
    let json: any;
    try {
      json = JSON.parse(outcome.res.body);
    } catch {
      // Relay answered 200 with a non-JSON body (HTML page, quota page, ...).
      return { ok: false, latencyMs, reply: '', error: isHtmlBody(outcome.res.body)
        ? 'The endpoint answered with a web page, not an API response. Check the Base URL.'
        : 'Non-JSON response from endpoint.' };
    }
    if (json.error) {
      return { ok: false, latencyMs, reply: '', error: json.error.message || 'Model error' };
    }
    // Non-standard replies (relays that return {data:...} or plain strings)
    const replyText = json.choices?.[0]?.message?.content
      ?? (typeof json.content === 'string' ? json.content : null)
      ?? (Array.isArray(json.content) ? json.content.map((c: any) => c?.text || '').join('') : null)
      ?? (typeof json.response === 'string' ? json.response : null)
      ?? (typeof json.output_text === 'string' ? json.output_text : null);
    if (replyText != null) {
      return { ok: true, latencyMs, reply: String(replyText).trim() };
    }
    const reply = json.choices?.[0]?.message?.content || '';
    return { ok: true, latencyMs, reply: String(reply).trim() };
  } catch (err: any) {
    if (getSignal && getSignal()) return { ok: false, latencyMs: Date.now() - started, reply: '', error: 'aborted' };
    return { ok: false, latencyMs: Date.now() - started, reply: '', error: err?.message || String(err) };
  }
}
