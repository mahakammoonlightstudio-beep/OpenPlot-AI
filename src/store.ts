import { create } from 'zustand';
import { Provider, Project, Folder, Chat, Message, Memory, StoryEntry, Chapter, FlowBeat, PluginRow, SkillRow, AutomationRow, McpRow, AppInfo, UserPrompt } from './types';

// Mahakam Moonlight Studio — official links (v1.0.0 rebrand)
export const DONATE_URL = 'https://sociabuzz.com/mahakam_moonlight_studio/tribe';
export const SAWERIA_URL = 'https://saweria.co/MahakamMoonStudio';
// Donation channels — shown everywhere support is mentioned (About, Settings,
// welcome screen, native Help menu) so users can pick their platform.
export const DONATE_LINKS: { id: string; name: string; url: string }[] = [
  { id: 'sociabuzz', name: 'SociaBuzz', url: DONATE_URL },
  { id: 'saweria', name: 'Saweria', url: SAWERIA_URL }
];
export const GITHUB_URL = 'https://github.com/mahakammoonlightstudio-beep';
export const YOUTUBE_URL = 'https://www.youtube.com/@MahakamMoonlightStudio';
export const LINKEDIN_URL = 'https://www.linkedin.com/in/muhammad-fauzan-raffa-al-habsy-369628411/';
export const TWITTER_URL = 'https://x.com/MahakamMoocb';
export const STUDIO_NAME = 'Mahakam Moonlight Studio';

// ---------- helpers ----------

export function dbCall<T = any>(op: string, payload?: any): Promise<T> {
  return window.inkwell.dbCall(op, payload).then((r: any) => {
    if (r && r.ok === false) throw new Error(r.error || 'db error');
    return r?.data;
  });
}

export const uid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

const normBool = (v: any) => v === 1 || v === true;

export function providerList(models: string | string[] | null | undefined): string[] {
  if (!models) return [];
  if (Array.isArray(models)) return models;
  try {
    const parsed = JSON.parse(models);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normProvider(p: any): Provider {
  // DB rows use snake_case (base_url/api_key); the app uses camelCase.
  // This mapping was missing — provider settings saved in Settings were never
  // actually seen by the chat request builder ("Invalid URL" failures).
  return {
    ...p,
    baseUrl: p.baseUrl ?? p.base_url ?? '',
    apiKey: p.apiKey ?? p.api_key ?? '',
    kind: p.kind || 'auto',
    enabled: normBool(p.enabled),
    models: providerList(p.models)
  };
}

// ---------- toasts ----------

interface ToastItem { id: string; msg: string; kind: 'info' | 'ok' | 'error' }

interface UiState {
  toasts: ToastItem[];
  paletteOpen: boolean;
  toast(msg: string, kind?: ToastItem['kind']): void;
  dismiss(id: string): void;
  setPalette(open: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  toasts: [],
  paletteOpen: false,
  toast(msg, kind = 'info') {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3800);
  },
  dismiss(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },
  setPalette(open) { set({ paletteOpen: open }); }
}));

// ---------- settings store ----------

// Per-model tuning persisted in settings (`modelOverrides`). Key format:
// `${providerId}::${modelId}`. Any field left undefined falls back to the
// global setting — the Edit-model modal writes here.
export interface ModelOverride {
  context?: number;      // context window (tokens)
  maxTokens?: number;    // max output tokens
  temperature?: number;
  topP?: number;
  thinkBudget?: number;
}
export const modelOverrideKey = (providerId: string, model: string) => `${providerId}::${model}`;
export function getModelOverride(
  overrides: Record<string, ModelOverride> | undefined | null,
  providerId: string | null | undefined,
  model: string | null | undefined
): ModelOverride | null {
  if (!overrides || !providerId || !model) return null;
  return overrides[modelOverrideKey(providerId, model)] || null;
}

interface SettingsState {
  loaded: boolean;
  version: string;
  theme: string;
  accent: string;
  lang: 'en' | 'id';
  chatFontSize: number;
  temperature: number;
  maxTokens: number;
  topP: number;
  defaultSystem: string;
  agentMd: string;
  defaultProviderId: string | null;
  defaultModel: string | null;
  memoryEnabled: boolean;
  toolsEnabled: boolean;
  thinkingEnabled: boolean;
  thinkingBudget: number;
  autoMemory: boolean;
  modelOverrides: Record<string, ModelOverride>;
  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void;
  load(): Promise<void>;
}

// Guards against corrupted/edited DB rows: a poisoned number (e.g. maxTokens
// stored as a string or NaN) used to crash number pickers across the app.
const clampNum = (v: any, fb: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 1000) / 1000)) : fb;
};
const boolOr = (v: any, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
const strOr = (v: any, fb: string): string => (typeof v === 'string' ? v : fb);

// Persisted settings keys and their sanitizers. Unknown keys in the settings
// table are ignored so old/experimental rows can never poison the store shape.
const SETTING_SANITIZERS: Record<string, (v: any) => any> = {
  theme: (v) => strOr(v, 'dark-classic'),
  accent: (v) => strOr(v, '#7c5cff'),
  lang: (v) => (v === 'id' ? 'id' : 'en'),
  chatFontSize: (v) => clampNum(v, 14, 12, 20),
  temperature: (v) => clampNum(v, 0.7, 0, 2),
  maxTokens: (v) => clampNum(v, 4096, 64, 200000),
  topP: (v) => clampNum(v, 1, 0, 1),
  defaultSystem: (v) => strOr(v, ''),
  agentMd: (v) => strOr(v, ''),
  defaultProviderId: (v) => (typeof v === 'string' ? v : null),
  defaultModel: (v) => (typeof v === 'string' ? v : null),
  memoryEnabled: (v) => boolOr(v, true),
  toolsEnabled: (v) => boolOr(v, true),
  thinkingEnabled: (v) => boolOr(v, true),
  thinkingBudget: (v) => clampNum(v, 4096, 1024, 100000),
  autoMemory: (v) => boolOr(v, true),
  modelOverrides: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
};

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  version: '',
  theme: 'dark-classic',
  accent: '#7c5cff',
  lang: 'en',
  chatFontSize: 14,
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  defaultSystem: '',
  agentMd: '',
  defaultProviderId: null,
  defaultModel: null,
  memoryEnabled: true,
  toolsEnabled: true,
  // Thinking defaults ON — models that don't return reasoning fields simply
  // ignore the request, so enabling it globally is safe.
  thinkingEnabled: true,
  thinkingBudget: 4096,
  autoMemory: true,
  modelOverrides: {} as Record<string, ModelOverride>,
  async load() {
    try {
      const raw = await dbCall<Record<string, string>>('getAllSettings');
      const parsed: any = {};
      for (const [k, v] of Object.entries(raw || {})) {
        try { parsed[k] = JSON.parse(v as string); } catch { parsed[k] = v; }
      }
      // Sanitize every known key; unknown/legacy keys are dropped so stale rows
      // can never poison the typed store shape.
      const clean: any = {};
      for (const [k, fn] of Object.entries(SETTING_SANITIZERS)) {
        if (k in parsed) clean[k] = fn(parsed[k]);
      }
      let version = '';
      try {
        const info = await window.inkwell.appInfo();
        version = info?.version || '';
      } catch { /* preload missing (plain browser dev) */ }
      set({ ...clean, version, loaded: true } as any);
    } catch (e) {
      console.error('settings load failed', e);
      set({ loaded: true });
    }
  },
  set(key, value) {
    set({ [key]: value } as any);
    window.inkwell.dbCall('setSetting', { key, value: JSON.stringify(value) });
  }
}));

// ---------- data store ----------

interface DataState {
  providers: Provider[];
  projects: Project[];
  folders: Folder[];
  chats: Chat[];
  memories: Memory[];
  story: StoryEntry[];
  chapters: Chapter[];
  flowBeats: FlowBeat[];
  userPrompts: UserPrompt[];
  plugins: PluginRow[];
  skills: SkillRow[];
  automations: AutomationRow[];
  mcpServers: McpRow[];
  activeChatId: string | null;
  activeProjectId: string | null;
  route: string;
  load(): Promise<void>;
  reloadChatRelated(): Promise<void>;
  setActiveChat(id: string | null): void;
  setActiveProject(id: string | null): void;
  navigate(route: string): void;
}

export const useData = create<DataState>((set) => ({
  providers: [],
  projects: [],
  folders: [],
  chats: [],
  memories: [],
  story: [],
  chapters: [],
  flowBeats: [],
  userPrompts: [],
  plugins: [],
  skills: [],
  automations: [],
  mcpServers: [],
  activeChatId: null,
  activeProjectId: null,
  route: 'chat',
  async load() {
    try {
      const [providers, projects, folders, chats, memories, story, chapters, flowBeats, userPrompts, plugins, skills, automations, mcpServers] = await Promise.all([
        dbCall<Provider[]>('listProviders'),
        dbCall<Project[]>('listProjects'),
        dbCall<Folder[]>('listFolders'),
        dbCall<Chat[]>('listChats'),
        dbCall<Memory[]>('listMemories'),
        dbCall<StoryEntry[]>('listStory'),
        dbCall<Chapter[]>('listAllChapters'),
        dbCall<FlowBeat[]>('listFlowBeats', { projectId: '' }).catch(() => [] as FlowBeat[]),
        dbCall<UserPrompt[]>('listPrompts').catch(() => [] as UserPrompt[]),
        dbCall<PluginRow[]>('listPlugins'),
        dbCall<SkillRow[]>('listSkills'),
        dbCall<AutomationRow[]>('listAutomations'),
        dbCall<McpRow[]>('listMcpServers')
      ]);
      set({ providers: providers.map(normProvider), projects, folders, chats, memories, story, chapters, flowBeats, userPrompts, plugins, skills, automations, mcpServers });
    } catch (e) {
      console.error('data load failed', e);
    }
  },
  async reloadChatRelated() {
    try {
      const [chats, folders] = await Promise.all([dbCall<Chat[]>('listChats'), dbCall<Folder[]>('listFolders')]);
      set({ chats, folders });
    } catch (e) {
      console.error('reload failed', e);
    }
  },
  setActiveChat(id) { set({ activeChatId: id }); },
  setActiveProject(id) { set({ activeProjectId: id }); },
  navigate(route) { set({ route }); }
}));

// Run automations helper (renderer side).
// Actions: toast | log | clearMemory | addMemory | navigate | newChat | openExternal
// `param` meaning per action:
//   toast         -> (unused; the automation name is shown)
//   log           -> (unused)
//   clearMemory   -> (unused; wipes ALL long-term memories)
//   addMemory     -> memory text to save
//   navigate      -> route name: chat | story | chapters | projects | stats | settings | about
//   newChat       -> optional chat title (empty = 'New chat')
//   openExternal  -> URL to open in the OS browser
export async function runAutomations(trigger: string, payload: any): Promise<void> {
  try {
    const autos = useData.getState().automations.filter((a) => a.trigger === trigger && Number(a.enabled) !== 0);
    for (const a of autos) {
      const param = (a.param || '').trim();
      switch (a.action) {
        case 'toast':
          useUi.getState().toast(a.name, 'ok');
          break;
        case 'log':
          console.log(`[automation:${a.name}]`, payload);
          break;
        case 'clearMemory': {
          await dbCall('clearMemories', {});
          await useData.getState().load();
          useUi.getState().toast(`${a.name}: memory cleared`, 'ok');
          break;
        }
        case 'addMemory': {
          if (!param) break;
          await dbCall('addMemory', { content: param, source: 'automation' });
          await useData.getState().load();
          break;
        }
        case 'navigate': {
          if (param) useData.getState().navigate(param);
          break;
        }
        case 'newChat': {
          const c = await dbCall<any>('createChat', { title: param || 'New chat' });
          await useData.getState().reloadChatRelated();
          useData.getState().setActiveChat(c.id);
          useData.getState().navigate('chat');
          break;
        }
        case 'openExternal': {
          if (/^https?:\/\//i.test(param)) window.inkwell.openExternal(param);
          break;
        }
        default:
          console.warn(`[automation:${a.name}] unknown action: ${a.action}`);
      }
    }
  } catch (e) {
    console.error('automation error', e);
  }
}

// Centralized "create a chat from the UI" — every creation path (sidebar,
// palette, menu, welcome screen) goes through here so the `chat:new`
// automation trigger fires exactly once, with the same side effects.
export async function createChatUi(title = 'New chat', projectId: string | null = null): Promise<any> {
  const c = await dbCall<any>('createChat', { title, project_id: projectId });
  await useData.getState().reloadChatRelated();
  useData.getState().setActiveChat(c.id);
  useData.getState().navigate('chat');
  runAutomations('chat:new', { chatId: c.id, title });
  return c;
}

export type { Provider, Project, Folder, Chat, Message, Memory, StoryEntry, Chapter, UserPrompt, PluginRow, SkillRow, AutomationRow, McpRow, AppInfo };
