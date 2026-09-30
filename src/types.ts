import { IpcRendererEvent } from 'electron';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
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
export interface Folder { id: string; name: string; project_id: string | null; expanded: number; position: number; created_at?: number }
export interface Chat { id: string; title: string; folder_id: string | null; project_id: string | null; model: string | null; system_prompt: string | null; /** 1/0 (DB) or boolean after normalize — pinned chats float to the top. */ pinned?: number | boolean; created_at?: number; updated_at?: number }
export interface Message { id: string; chat_id: string; role: 'user' | 'assistant' | 'system'; content: string; thinking: string | null; model: string | null; tokens_in?: number | null; tokens_out?: number | null; created_at?: number }
/** One reply style (persona/tone injected as a system fragment). */
export interface StyleRow { id: string; name: string; content: string; builtin: number; created_at?: number; updated_at?: number }
export interface Memory { id: string; content: string; source: string; created_at?: number }
export type StoryKind = 'world' | 'location' | 'character' | 'item' | 'lore';
export interface StoryEntry { id: string; project_id: string; kind: StoryKind; title: string; content: string; tags: string; created_at?: number; updated_at?: number }
export interface Chapter { id: string; project_id: string; title: string; content: string; status: 'draft' | 'revising' | 'done'; position: number; created_at?: number; updated_at?: number }
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
export interface PluginRow { id: string; name: string; code: string; enabled: number }
export interface SkillRow { id: string; name: string; content: string; enabled: number }
export interface AutomationRow { id: string; name: string; trigger: string; action: string; param?: string; enabled?: number }
export interface McpRow { id: string; name: string; command: string; args: string; enabled: number }

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

export interface AppInfo {
  version: string;
  platform: string;
  dataPath: string;
  donateUrl: string;
  /** API keys encrypted at rest (OS credential vault available & used). */
  encryption?: boolean;
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
  providerPresets(): Promise<{ ok: boolean; data?: ProviderPreset[] }>;
  refreshPresets(providers: Partial<Provider>[]): Promise<{ ok: boolean; data?: PresetRefreshResult[]; error?: string }>;
  runPlugin(pluginId: string, command: string, payload?: any): Promise<{ ok: boolean; data?: string; error?: string }>;
  listLoadedPlugins(): Promise<{ ok: boolean; data?: any[] }>;
  reloadPlugins(): Promise<{ ok: boolean; data?: any[]; error?: string }>;
  pluginLogs(): Promise<{ ok: boolean; data?: string[] }>;
  appInfo(): Promise<AppInfo>;
  setUnreadCount(count: number): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  exportMarkdown(name: string, content: string): Promise<{ ok: boolean; data?: string; error?: string }>;
  /** Save plain text as .txt/.md via the native save dialog. */
  exportFile(name: string, content: string, kind: 'txt' | 'md'): Promise<{ ok: boolean; data?: string; error?: string }>;
  /** Save an assembled EPUB (byte array) via the native save dialog. */
  exportEpub(name: string, author: string, chapters: { title: string; content: string }[], lang?: string): Promise<{ ok: boolean; data?: string; error?: string }>;
  /** Native open-file dialog → picked files' absolute paths (empty if cancelled). */
  pickFiles(): Promise<string[]>;
  /** Read small text files picked via pickFiles (skips >300KB or unreadable). */
  readFiles(paths: string[]): Promise<{ name: string; content: string }[]>;
  onAiChunk(cb: (data: { reqId: string; chunk: GenChunk }) => void): () => void;
  onUi(channel: string, cb: (payload: any) => void): () => void;
}

export interface GenerateRequest {
  reqId: string;
  /** Lets the main process guard the chat against message deletes mid-run. */
  chatId?: string;
  provider: { id: string; name: string; baseUrl: string; apiKey: string; enabled: boolean; models: string[]; kind?: string };
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
}

declare global {
  interface Window {
    inkwell: InkwellApi;
  }
}
