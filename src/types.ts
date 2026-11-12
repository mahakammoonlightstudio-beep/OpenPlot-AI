import { IpcRendererEvent } from 'electron';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** Empty unless the user typed a replacement here; the stored key stays in
   *  the main process (see providerSecret in electron/db.ts). */
  apiKey: string;
  /** 1 when a key is stored for this provider, so the UI can say so without
   *  ever receiving the secret. */
  hasKey?: boolean;
  enabled: boolean | number;
  models: string | string[];
  created_at?: number;
  kind?: 'auto' | 'openai' | 'anthropic';
}

export type WorkFormat = 'short-story' | 'novel' | 'book' | 'fanfic' | 'script';
export type ContentRating = 'family' | 'teen' | 'mature';
export interface Project {
  id: string;
  name: string;
  description: string;
  context: string;
  /** Work type — shapes length targets and AI guidance. */
  format: WorkFormat;
  /** AI content rating — shapes how the assistant writes/advises. */
  rating: ContentRating;
  created_at?: number;
  updated_at?: number;
}
export interface Folder { id: string; name: string; project_id: string | null; expanded: number; position: number; /** 'chat' | 'agent' — folders are per workspace (v1.3.0). */ workspace?: string | null; created_at?: number }
export interface Chat { id: string; title: string; folder_id: string | null; project_id: string | null; model: string | null; system_prompt: string | null; /** 1/0 (DB) or boolean after normalize — pinned chats float to the top. */ pinned?: number | boolean; /** JSON string in the DB; parsed to skill ids this chat opted out of. */ skills_off?: string | string[]; /** JSON string in the DB; skill ids switched on for this chat (/skill). */ skills_on?: string | string[]; /** 1/0 — agent mode (tool loop) for this chat. */ agent_mode?: number | boolean;  /** 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max' — persisted per chat (v8). */
  think_level?: string | null;
  /** 'plan' | 'brainstorm' | 'write' | 'edit' — the chat's working mode. */ chat_mode?: string | null;
  /** Which Advance section owns this session: 'chat' or 'agent'. */ workspace?: string | null;
  created_at?: number; updated_at?: number }
/** Metadata for one file stored with a sent message (no body — see readMessageFile). */
export interface MessageFileMeta { id: string; name: string; kind: 'file' | 'story' | 'chapter'; bytes: number }
export interface Message { id: string; chat_id: string; role: 'user' | 'assistant' | 'system'; content: string; thinking: string | null; model: string | null; /** Assistant rows only: the user turn this reply answers. Replies sharing it are variants of one turn. */ parent_id?: string | null; tokens_in?: number | null; tokens_out?: number | null; /** Prompt tokens served from the provider's prompt cache (null = unknown). */ tokens_cached?: number | null; /** Files attached when this message was sent (metadata only). */ files?: MessageFileMeta[]; /** Tool calls with their readable detail, persisted with the reply. */ toolSteps?: ToolStep[]; created_at?: number }
import type { ToolStep } from './lib/toolProgress';
/** One reply style (persona/tone injected as a system fragment). */
export interface StyleRow { id: string; name: string; content: string; builtin: number; created_at?: number; updated_at?: number }
export interface Memory { id: string; content: string; source: string; created_at?: number }
export type StoryKind = 'world' | 'location' | 'character' | 'item' | 'lore';
export interface StoryEntry { id: string; project_id: string; kind: StoryKind; title: string; content: string; tags: string; /** JSON array string of related entry ids. */ links?: string; created_at?: number; updated_at?: number }
export interface Chapter { id: string; project_id: string; title: string; content: string; status: 'draft' | 'revising' | 'done'; position: number; created_at?: number; updated_at?: number }
/** One recovery-bin row: text an AI edit or a manual save displaced. */
export interface TextDumpRow {
  id: string;
  project_id: string | null;
  chapter_id: string | null;
  chapter_title: string;
  source: 'writing' | 'agent' | 'manual' | 'chat';
  action: 'delete' | 'replace' | 'edit' | 'rephrase' | 'expand' | 'shrink';
  scope: 'passage' | 'chapter';
  original: string;
  replacement: string;
  start_offset: number | null;
  end_offset: number | null;
  restored_at: number | null;
  created_at: number;
}
/** One row of the manuscript Revision Timeline (v1.3.0).
 * 'version' = a full-chapter snapshot taken before a save/AI append/restore;
 * 'edit' = displaced text from text_dump (AI rewrite, delete, manual save).
 * The listing carries metadata + a preview only; `getRevisionEntry` returns the
 * full before/after text when a row is opened. */
export interface RevisionEntryMeta {
  id: string;                 // 'v:<id>' | 'd:<id>' — stable across both tables
  kind: 'version' | 'edit';
  rowId: string;
  chapterId: string | null;
  chapterTitle: string;
  at: number;
  source: string;
  action: string | null;
  scope: 'chapter' | 'passage';
  words: number | null;       // snapshot word count (versions)
  afterWords: number | null;  // text that replaced the snapshot (versions)
  chars: number;              // length of the before text
  preview: string;
  restoredAt: number | null;  // dumps only: already rolled back
}
export interface RevisionEntryDetail {
  ok?: boolean;
  error?: string;
  id: string;
  kind: 'version' | 'edit';
  chapterId: string | null;
  chapterTitle: string;
  at: number;
  source: string;
  action: string | null;
  scope: 'chapter' | 'passage';
  title?: string;
  before: string;
  after: string;
  startOffset: number | null;
  endOffset: number | null;
  restoredAt: number | null;
}
/** One user-saved prompt in the Prompt Library. */
export interface UserPrompt { id: string; category: string; title: string; template: string; created_at?: number; updated_at?: number }
/** One beat on the Story Flow board (outline card grouped by act). */
export interface FlowBeat {
  id: string;
  project_id: string;
  act: number;            // 1 | 2 | 3
  title: string;
  summary: string;
  status: 'planned' | 'drafting' | 'written';
  chapter_id: string | null;
  position: number;
  created_at?: number;
  updated_at?: number;
}
/** A text file attached to a story-bible entry (or to the project itself). */
export interface StoryFile {
  id: string;
  project_id: string;
  story_id: string | null;
  name: string;
  bytes: number;
  created_at?: number;
}
/** A saved Plot Smith plan (Story Agent). `brief`/`plan` are JSON strings. */
export interface StoryPlanRow {
  id: string;
  project_id: string | null;
  title: string;
  brief?: string;
  plan?: string;
  created_at?: number;
  updated_at?: number;
}
export interface DbStats {
  bytes: number;
  path: string;
  messages: number;
  chats: number;
  chapters: number;
  story: number;
  storyFiles: number;
  /** Attachments stored with sent chat messages (v1.2.3). */
  chatFiles: number;
  chatFileBytes: number;
  versions: number;
}
export interface PluginRow { id: string; name: string; code: string; enabled: number }
export type SkillCategory = 'chat' | 'agent' | 'writing';

export interface SkillRow {
  id: string;
  name: string;
  /** One-line description shown on the card and injected above the content. */
  description?: string;
  content: string;
  enabled: number;
  /** 1 = shipped with the app: editable, resettable, never deletable. */
  builtin?: number;
  /** Which desk the skill belongs to (v1.3.0). */
  category?: SkillCategory;
}
export interface AutomationRow { id: string; name: string; trigger: string; action: string; param?: string; enabled?: number }
export interface McpRow { id: string; name: string; command: string; args: string; env: string; enabled: number }

export interface GenChunk {
  type: 'text' | 'thinking' | 'replaceText' | 'tool' | 'info' | 'error';
  text?: string;
  tool?: { name: string; result: string };
}

export interface ModelVerifyResult {
  ok: boolean;
  latencyMs: number;
  reply: string;
  error?: string;
}

export interface KeyValidationResult {
  ok: boolean;
  method: string;
  message: string;
}

export interface ModelCapabilities {
  model: string;
  tools: boolean;
  streaming: boolean;
  thinking: boolean;
  contextTokens: number;
  ok: boolean;
  error?: string;
  probedAt: number;
}

/** Whether a model can expose reasoning, before/after a probe. */
export type ThinkingSupport = 'yes' | 'no' | 'unknown';
/** How a provider caches prompt tokens. */
export type CacheMode = 'auto' | 'explicit' | 'none' | 'unknown';

export interface ModelCacheProfile {
  mode: CacheMode;
  /** 0 = bounded by (and unknown until) the context window is known. */
  maxTokens: number;
  minTokens: number;
  ttlSeconds: number;
}

/** One persisted capability entry, keyed `${providerId}::${model}`. */
export interface ModelCapsRecord {
  caps?: ModelCapabilities;
  cacheObserved?: { cachedTokens: number; at: number };
  /** Provider explicitly rejected a thinking request — real evidence, not a probe. */
  thinkingRejectedAt?: number;
}

export interface PresetModel {
  id: string;
  note?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'openai' | 'anthropic' | 'auto';
  needsKey: boolean;
  models: PresetModel[];
}

export interface PresetRefreshResult {
  presetId: string;
  presetName: string;
  ok: boolean;
  modelCount: number;
  error?: string;
}

/** Runtime state of one MCP server, as reported by the bridge. */
export interface McpServerStatus {
  id: string;
  name: string;
  status: 'stopped' | 'starting' | 'connected' | 'error';
  tools: number;
  /** Tool names actually advertised to the model. */
  toolNames?: string[];
  lastError: string | null;
  command: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  dataPath: string;
  /** Active SQLite file, shown in Settings → Data. */
  dbPath?: string;
  dbSchema?: number | null;
  donateUrl: string;
  /** API keys encrypted at rest (OS credential vault available & used). */
  encryption?: boolean;
}

export interface LibraryEntry {
  name: string;
  bytes: number;
  modified: number;
  /** SQLite `user_version`; null when the file cannot be read. */
  schema: number | null;
  status: 'current' | 'legacy' | 'newer' | 'unreadable';
  active: boolean;
}

export interface LibraryState {
  dir: string;
  active: string;
  currentSchema: number;
  entries: LibraryEntry[];
}

export interface LibraryResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** One whole-file copy of the active library (Library Time Machine). */
export interface SnapshotEntry {
  name: string;
  /** manual | daily | pre-migration-vN | pre-import | pre-restore | pre-reset */
  reason: string;
  savedAt: number;
  bytes: number;
  schema: number | null;
  status: 'current' | 'legacy' | 'newer' | 'unreadable';
}

export interface SnapshotState {
  /** Snapshot folder for the active library only. */
  dir: string;
  active: string;
  max: number;
  entries: SnapshotEntry[];
}

export interface TrustEntry {
  kind: 'plugin' | 'mcp';
  id: string;
  label: string;
  /** The plugin/MCP row still exists (false = deleted, hash left behind). */
  present: boolean;
  /** Code or command changed after the approval — it will ask again. */
  stale: boolean;
}

export interface InkwellApi {
  platform: string;
  /** Absolute filesystem path of a dragged-in File (Electron webUtils). */
  pathForFile(file: File): string;
  dbCall<T = any>(op: string, payload?: any): Promise<T>;
  generate(req: GenerateRequest): Promise<{ ok: boolean; data?: GenResultData; error?: string }>;
  abort(reqId: string): Promise<boolean>;
  fetchModels(provider: Partial<Provider>): Promise<{ ok: boolean; data?: string[]; error?: string }>;
  verifyModel(provider: Partial<Provider>, model: string, reqId?: string): Promise<{ ok: boolean; data?: ModelVerifyResult; error?: string }>;
  validateKey(provider: Partial<Provider>): Promise<{ ok: boolean; data?: KeyValidationResult; error?: string }>;
  probeCapabilities(provider: Partial<Provider>, model: string): Promise<{ ok: boolean; data?: ModelCapabilities; error?: string }>;
  /** Persist "this provider refused thinking" so the next chat hides the control. */
  markThinkingRejected(providerId: string, model: string): Promise<{ ok: boolean; error?: string }>;
  providerPresets(): Promise<{ ok: boolean; data?: ProviderPreset[] }>;
  refreshPresets(providers: Partial<Provider>[]): Promise<{ ok: boolean; data?: PresetRefreshResult[]; error?: string }>;
  runPlugin(pluginId: string, command: string, payload?: any): Promise<{ ok: boolean; data?: string; error?: string }>;
  listLoadedPlugins(): Promise<{ ok: boolean; data?: any[] }>;
  reloadPlugins(): Promise<{ ok: boolean; data?: any[]; error?: string }>;
  pluginLogs(): Promise<{ ok: boolean; data?: string[] }>;
  /** MCP bridge (v1.2.3 Task 13). */
  mcpList(): Promise<{ ok: boolean; data?: McpServerStatus[] }>;
  mcpSync(): Promise<{ ok: boolean; data?: McpServerStatus[]; error?: string }>;
  mcpRestart(id: string): Promise<{ ok: boolean; data?: McpServerStatus | null; error?: string }>;
  mcpLogs(id: string): Promise<{ ok: boolean; data?: string[] }>;
  /** Stored plugin/MCP execution approvals, for review and revocation. */
  trustList(): Promise<{ ok: boolean; data?: TrustEntry[]; error?: string }>;
  trustRevoke(kind: 'plugin' | 'mcp', id: string): Promise<{ ok: boolean; data?: TrustEntry[]; error?: string }>;
  /** Fetch a remote image through the main process → a data: URL. */
  fetchImage(url: string): Promise<{ ok: boolean; data?: string; error?: string }>;
  appInfo(): Promise<AppInfo>;
  /** Databases in the profile folder, their schema, and which one is active. */
  libraries(): Promise<LibraryResult<LibraryState>>;
  librarySwitch(name: string): Promise<LibraryResult<{ name: string; schema: number; legacy: boolean }>>;
  libraryCreate(name: string): Promise<LibraryResult<{ name: string }>>;
  libraryImport(): Promise<LibraryResult<{ entry: LibraryEntry; source: string }>>;
  /** One-file copy for another machine; provider keys and approvals are removed. */
  libraryExport(): Promise<LibraryResult<{ name: string; path: string; bytes: number }>>;
  revealDataFolder(): Promise<boolean>;
  /** Whole-file snapshots of the active library. */
  snapshots(): Promise<LibraryResult<SnapshotState>>;
  snapshotCreate(): Promise<LibraryResult<{ entry: SnapshotEntry; state: SnapshotState }>>;
  snapshotRestore(name: string): Promise<LibraryResult<{ name: string }>>;
  /** Native zoom for the whole UI (0.85–1.25). */
  setZoom(factor: number): boolean;
  /** Unread badge for the window title; `chatTitle` is used when nothing is unread. */
  setUnreadCount(count: number, chatTitle?: string): Promise<boolean>;
  /** Window flash for the `notify` automation action (optional: browser dev). */
  flashWindow(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  exportMarkdown(name: string, content: string): Promise<{ ok: boolean; data?: string; error?: string }>;
  /** Save plain text as .txt/.md/.json via the native save dialog. */
  exportFile(name: string, content: string, kind: 'txt' | 'md' | 'json'): Promise<{ ok: boolean; data?: string; error?: string }>;
  /** Save an assembled EPUB (byte array) via the native save dialog. */
  exportEpub(name: string, author: string, chapters: { title: string; content: string }[], lang?: string): Promise<{ ok: boolean; data?: string; error?: string }>;
  /** Native open-file dialog → picked files' absolute paths (empty if cancelled). */
  pickFiles(): Promise<string[]>;
  /** Read text files picked via pickFiles. Defaults to 300 KB per file; pass
   *  a higher cap (max 2 MB) for Story Bible imports. Binary files are skipped. */
  readFiles(paths: string[], maxBytes?: number): Promise<{ name: string; content: string; size?: number }[]>;
  /** Grant the exact files the user dropped (paths come from webUtils, so a
   *  synthetic File can never widen access). */
  grantDroppedFiles(files: File[]): Promise<boolean>;
  onAiChunk(cb: (data: { reqId: string; chunk: GenChunk }) => void): () => void;
  onUi(channel: string, cb: (payload: any) => void): () => void;
}

export interface GenerateRequest {
  reqId: string;
  /** Lets the main process guard the chat against message deletes mid-run. */
  chatId?: string;
  /** The renderer names the provider; the main process resolves the stored
   *  base URL and API key itself, so neither is trusted from this payload. */
  provider: { id: string; name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; models?: string[]; kind?: string };
  model: string;
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  toolsEnabled?: boolean;
  projectId?: string | null;
}

export interface GenResultData {
  text: string;
  thinking: string;
  toolsUsed: string[];
  /** Reported by the provider when available, otherwise estimated. */
  tokensIn?: number;
  tokensOut?: number;
  /** Prompt tokens served from the provider cache (absent when unreported). */
  tokensCached?: number;
  /** The provider refused the thinking parameter (result came from the retry). */
  thinkingRejected?: boolean;
}

declare global {
  interface Window {
    inkwell: InkwellApi;
  }
}
