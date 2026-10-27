import { create } from 'zustand';
import { Provider, Project, Folder, Chat, Message, Memory, StoryEntry, Chapter, FlowBeat, PluginRow, SkillRow, AutomationRow, McpRow, AppInfo, UserPrompt, StyleRow, ModelCapsRecord } from './types';
import { readPosition, writePosition } from './lib/uiPosition';
import { useUnreadStore } from './unreadStore';
import { useWriteStats } from './writeStats';

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
/** Feedback / security reports. Also published in SECURITY.md and the website. */
export const FEEDBACK_EMAIL = 'mahakammoonlightstudio@gmail.com';

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
  /** Zen-mode companion: slides the whole sidebar away (chat header toggle). */
  sidebarHidden: boolean;
  /**
   * Section the Settings view should show next. The palette sets it before
   * navigating, and the search results set it after picking a section, so any
   * control is two keystrokes away (v1.2.3 Task 6).
   */
  settingsSection: string | null;
  /** Control id to scroll to and flash once the section has rendered. */
  settingsFocus: string | null;
  /** Global keyboard-shortcuts sheet (F1 / Ctrl+Shift+/). */
  shortcutsOpen: boolean;
  toast(msg: string, kind?: ToastItem['kind']): void;
  dismiss(id: string): void;
  setPalette(open: boolean): void;
  setSidebarHidden(hidden: boolean): void;
  setSettingsSection(section: string | null, focusId?: string | null): void;
  clearSettingsFocus(): void;
  setShortcuts(open: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  toasts: [],
  paletteOpen: false,
  sidebarHidden: false,
  settingsSection: null,
  settingsFocus: null,
  shortcutsOpen: false,
  toast(msg, kind = 'info') {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    // Coalesce identical messages: a loop of failures used to stack ten copies.
    set((s) => ({
      toasts: s.toasts.filter((t) => t.msg !== msg || t.id === id)
    }));
    scheduleToastDismiss(id, 3800, (tid) => useUi.getState().dismiss(tid));
  },
  dismiss(id) {
    cancelToastTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setPalette(open) { set({ paletteOpen: open }); },
  setSidebarHidden(hidden) { set({ sidebarHidden: hidden }); },
  setSettingsSection(section, focusId = null) { set({ settingsSection: section, settingsFocus: focusId }); },
  clearSettingsFocus() { set({ settingsFocus: null }); },
  setShortcuts(open) { set({ shortcutsOpen: open }); }
}));

// Toast timers live outside the store state so dismissing a toast (or replacing
// its text) can cancel the old countdown — previously every toast kept a timer
// alive for 3.8 s no matter what the user did (Task 11).
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Start (or restart) the dismiss countdown for one toast. */
export function scheduleToastDismiss(id: string, ms: number, dismiss: (id: string) => void): void {
  cancelToastTimer(id);
  toastTimers.set(id, setTimeout(() => {
    toastTimers.delete(id);
    dismiss(id);
  }, ms));
}

/** Cancel every pending countdown — called on window teardown. */
export function clearToastTimers(): void {
  for (const timer of toastTimers.values()) clearTimeout(timer);
  toastTimers.clear();
}

function cancelToastTimer(id: string): void {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
}

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
  /** Author name written into EPUB metadata on export. */
  authorName: string;
  defaultProviderId: string | null;
  defaultModel: string | null;
  memoryEnabled: boolean;
  toolsEnabled: boolean;
  thinkingEnabled: boolean;
  thinkingBudget: number;
  /** auto = expand while streaming, collapse after; expanded/collapsed pin it. */
  thinkingDisplay: 'auto' | 'expanded' | 'collapsed';
  /** auto = hide the control for models that cannot expose reasoning. */
  thinkingUi: 'auto' | 'always';
  autoMemory: boolean;
  /** Active reply style (id in prompt_styles). Persisted globally. */
  defaultStyleId: string | null;
  modelOverrides: Record<string, ModelOverride>;
  /** Persisted capability probes + observed cache reuse, keyed `${providerId}::${model}`. */
  modelCaps: Record<string, ModelCapsRecord>;
  /** simple hides advanced model params and the Extend group; nothing is removed. */
  settingsMode: 'simple' | 'advanced';
  /** When on, the app aligns chat defaults with what the chosen model supports. */
  smartDefaults: boolean;
  /** Explicit provider+model pair chosen in Settings → Models (`defaultModel` stays for compat). */
  defaultModelRef: { providerId: string; model: string } | null;
  /** system follows the OS; full always animates; reduced kills motion. */
  motion: 'system' | 'full' | 'reduced';
  /** Last app version whose "What's new" was dismissed (shown once per version). */
  lastSeenVersion: string;
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
  authorName: (v) => strOr(v, ''),
  defaultProviderId: (v) => (typeof v === 'string' ? v : null),
  defaultModel: (v) => (typeof v === 'string' ? v : null),
  memoryEnabled: (v) => boolOr(v, true),
  toolsEnabled: (v) => boolOr(v, true),
  thinkingEnabled: (v) => boolOr(v, true),
  thinkingBudget: (v) => clampNum(v, 4096, 1024, 100000),
  thinkingDisplay: (v) => (v === 'expanded' || v === 'collapsed' ? v : 'auto'),
  thinkingUi: (v) => (v === 'always' ? 'always' : 'auto'),
  autoMemory: (v) => boolOr(v, true),
  defaultStyleId: (v) => (typeof v === 'string' ? v : null),
  modelOverrides: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
  settingsMode: (v) => (v === 'advanced' ? 'advanced' : 'simple'),
  smartDefaults: (v) => boolOr(v, true),
  motion: (v) => (v === 'full' || v === 'reduced' ? v : 'system'),
  lastSeenVersion: (v) => strOr(v, ''),
  defaultModelRef: (v) => (v && typeof v === 'object' && typeof v.providerId === 'string' && typeof v.model === 'string'
    ? { providerId: v.providerId, model: v.model }
    : null),
  // Written by the main process (probe results + provider-reported cache hits).
  // Sanitized to a plain object here so a hand-edited settings row cannot put a
  // string/array where every consumer expects a map.
  modelCaps: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
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
  authorName: '',
  defaultProviderId: null,
  defaultModel: null,
  memoryEnabled: true,
  toolsEnabled: true,
  // Thinking defaults ON — models that don't return reasoning fields simply
  // ignore the request, so enabling it globally is safe. The UI hides the
  // control per model; the request rule still refuses to send it to `no` models.
  thinkingEnabled: true,
  thinkingBudget: 4096,
  thinkingDisplay: 'auto',
  thinkingUi: 'auto',
  autoMemory: true,
  defaultStyleId: null,
  modelOverrides: {} as Record<string, ModelOverride>,
  modelCaps: {} as Record<string, ModelCapsRecord>,
  settingsMode: 'simple',
  smartDefaults: true,
  defaultModelRef: null,
  motion: 'system',
  lastSeenVersion: '',
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
  styles: StyleRow[];
  plugins: PluginRow[];
  skills: SkillRow[];
  automations: AutomationRow[];
  mcpServers: McpRow[];
  activeChatId: string | null;
  activeProjectId: string | null;
  route: string;
  /** Guide article currently open (route `guide`); deep-linkable. */
  guideSlug: string;
  setGuideSlug(slug: string): void;
  load(): Promise<void>;
  reloadChatRelated(): Promise<void>;
  /** Refresh only the Story Bible rows — called after the agent writes an
   *  entry so the view is current without reloading the whole app. */
  reloadStory(): Promise<void>;
  setActiveChat(id: string | null): void;
  setActiveProject(id: string | null): void;
  navigate(route: string): void;
}

// Restore the last screen synchronously so a reload no longer lands on an
// empty chat. `load()` below drops ids whose row no longer exists.
const savedPosition = readPosition();

function persistPosition(state: Pick<DataState, 'route' | 'activeChatId' | 'activeProjectId'>): void {
  writePosition({ route: state.route, activeChatId: state.activeChatId, activeProjectId: state.activeProjectId });
}

export const useData = create<DataState>((set, get) => ({
  providers: [],
  projects: [],
  folders: [],
  chats: [],
  memories: [],
  story: [],
  chapters: [],
  flowBeats: [],
  userPrompts: [],
  styles: [],
  plugins: [],
  skills: [],
  automations: [],
  mcpServers: [],
  activeChatId: savedPosition.activeChatId,
  activeProjectId: savedPosition.activeProjectId,
  route: savedPosition.route,
  guideSlug: 'getting-started',
  setGuideSlug(slug) { set({ guideSlug: slug || 'getting-started' }); },
  async load() {
    try {
      const [providers, projects, folders, chats, memories, story, chapters, flowBeats, userPrompts, styles, plugins, skills, automations, mcpServers] = await Promise.all([
        dbCall<Provider[]>('listProviders'),
        dbCall<Project[]>('listProjects'),
        dbCall<Folder[]>('listFolders'),
        dbCall<Chat[]>('listChats'),
        dbCall<Memory[]>('listMemories'),
        dbCall<StoryEntry[]>('listStory'),
        dbCall<Chapter[]>('listAllChapters'),
        dbCall<FlowBeat[]>('listFlowBeats', { projectId: '' }).catch(() => [] as FlowBeat[]),
        dbCall<UserPrompt[]>('listPrompts').catch(() => [] as UserPrompt[]),
        dbCall<StyleRow[]>('listStyles').catch(() => [] as StyleRow[]),
        dbCall<PluginRow[]>('listPlugins'),
        dbCall<SkillRow[]>('listSkills'),
        dbCall<AutomationRow[]>('listAutomations'),
        dbCall<McpRow[]>('listMcpServers')
      ]);
      // A stored chat/project can be deleted while the app is closed. Keep the
      // position only if the row still exists; otherwise fall back cleanly.
      const current = get();
      const activeChatId = current.activeChatId && chats.some((c) => c.id === current.activeChatId)
        ? current.activeChatId : null;
      const activeProjectId = current.activeProjectId && projects.some((p) => p.id === current.activeProjectId)
        ? current.activeProjectId : null;
      set({ providers: providers.map(normProvider), projects, folders, chats, memories, story, chapters, flowBeats, userPrompts, styles, plugins, skills, automations, mcpServers, activeChatId, activeProjectId });
      // Prune persisted per-id maps once per load: rows deleted outside the app
      // (or by a previous session) used to linger in localStorage forever.
      try {
        useUnreadStore.getState().prune(chats.map((c) => c.id));
        useWriteStats.getState().prune(projects.map((p) => p.id));
      } catch { /* stats/unread stores are best-effort */ }
      if (activeChatId !== current.activeChatId || activeProjectId !== current.activeProjectId) {
        writePosition({ route: current.route, activeChatId, activeProjectId });
      }
    } catch (e) {
      console.error('data load failed', e);
    }
  },
  async reloadStory() {
    try {
      const story = await dbCall<StoryEntry[]>('listStory');
      set({ story: Array.isArray(story) ? story : [] });
    } catch (e) {
      console.error('story reload failed', e);
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
  setActiveChat(id) { set({ activeChatId: id }); persistPosition(get()); },
  setActiveProject(id) { set({ activeProjectId: id }); persistPosition(get()); },
  navigate(route) { set({ route }); persistPosition(get()); }
}));

// Run automations helper (renderer side).
// Triggers: app:ready | chat:new | chat:send | message:new | chapter:saved |
//           project:created | skill:enabled
// Actions: toast | notify | log | clearMemory | addMemory | navigate | newChat |
//          openExternal | runSkill
// `param` meaning per action:
//   toast         -> optional text (defaults to the automation name)
//   notify        -> text shown with the window flash
//   log           -> (unused)
//   clearMemory   -> (unused; wipes ALL long-term memories)
//   addMemory     -> memory text to save
//   navigate      -> route name from NAVIGABLE_ROUTES
//   newChat       -> optional chat title (empty = 'New chat')
//   openExternal  -> http(s) URL to open in the OS browser
//   runSkill      -> skill id (or name) to apply to the next message

/** Routes a navigate automation may switch to (kept in sync with SettingsView). */
export const NAVIGABLE_ROUTES = ['chat', 'story', 'flow', 'chapters', 'projects', 'stats', 'settings', 'about'];

// ---------- automations v2 (Task 14) ----------

/** Per-automation run history for this session (status + timestamp + message). */
const AUTOMATION_LOG_MAX = 20;
const automationRuns = new Map<string, { at: number; ok: boolean; message: string }[]>();
/** Guard against runaway chains: a trigger may not nest deeper than this. */
const MAX_AUTOMATION_DEPTH = 2;
let automationDepth = 0;

/** Most recent first. The UI shows these; they are not persisted (a session log). */
export function automationLog(id: string): { at: number; ok: boolean; message: string }[] {
  return automationRuns.get(id) || [];
}
export function automationLastRun(id: string): { at: number; ok: boolean; message: string } | null {
  return automationRuns.get(id)?.[0] || null;
}
function recordAutomationRun(id: string, ok: boolean, message: string): void {
  const list = automationRuns.get(id) || [];
  list.unshift({ at: Date.now(), ok, message });
  automationRuns.set(id, list.slice(0, AUTOMATION_LOG_MAX));
}

/** Flash the window and badge it — the OS-level half of `notify`. */
function osNotify(text: string): void {
  try { window.inkwell.flashWindow?.(); } catch { /* preload missing */ }
  useUi.getState().toast(text, 'ok');
}

/**
 * Run every enabled automation for a trigger.
 *
 * Guards: a chain may not nest deeper than two levels, and an automation whose
 * action re-fires its own trigger is skipped (the classic way to build an
 * infinite loop by accident). Every run is recorded for the Settings view.
 */
export async function runAutomations(trigger: string, payload: any): Promise<void> {
  if (automationDepth >= MAX_AUTOMATION_DEPTH) {
    console.warn(`[automation] ${trigger} ignored — chain depth ${automationDepth} reached`);
    return;
  }
  automationDepth++;
  try {
    const autos = useData.getState().automations.filter((a) => a.trigger === trigger && Number(a.enabled) !== 0);
    for (const a of autos) {
      const param = (a.param || '').trim();
      try {
      if (automationRecurses(a)) {
        recordAutomationRun(a.id, false, 'skipped: would re-trigger itself');
        continue;
      }
      switch (a.action) {
        case 'toast':
          useUi.getState().toast(param || a.name, 'ok');
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
          // Ignore unknown routes (imported automations can carry stale
          // params) instead of silently falling back to the chat view.
          if (param && NAVIGABLE_ROUTES.includes(param)) useData.getState().navigate(param);
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
        case 'notify': {
          // OS-level attention: the taskbar/dock flashes and the title badges.
          osNotify(param || a.name);
          break;
        }
        case 'runSkill': {
          // The skill rides into the next send as the session goal. ChatView
          // owns the goal, so hand it over as an event instead of reaching into
          // another component's state.
          const skill = useData.getState().skills.find((s) => s.id === param || s.name === param);
          if (!skill) throw new Error(`skill not found: ${param}`);
          window.dispatchEvent(new CustomEvent('inkwell:apply-skill', { detail: skill.id }));
          useUi.getState().toast(`${a.name}: ${skill.name}`, 'ok');
          break;
        }
        default:
          throw new Error(`unknown action: ${a.action}`);
      }
        recordAutomationRun(a.id, true, summaryOf(a, param));
      } catch (e: any) {
        const message = e?.message || String(e);
        recordAutomationRun(a.id, false, message);
        useUi.getState().toast(`${a.name}: ${message}`, 'error');
      }
    }
  } catch (e) {
    console.error('automation error', e);
  } finally {
    automationDepth--;
  }
}

/** Actions that can start a trigger of their own — used by the loop guard. */
const ACTION_TRIGGERS: Record<string, string[]> = {
  newChat: ['chat:new'],
  addMemory: [],
  runSkill: []
};

function automationRecurses(a: { trigger: string; action: string }): boolean {
  return (ACTION_TRIGGERS[a.action] || []).includes(a.trigger);
}

function summaryOf(a: { action: string }, param: string): string {
  switch (a.action) {
    case 'toast': return 'toast shown';
    case 'notify': return 'notified';
    case 'log': return 'logged to console';
    case 'navigate': return `went to ${param}`;
    case 'newChat': return 'chat created';
    case 'addMemory': return 'memory saved';
    case 'clearMemory': return 'memory cleared';
    case 'openExternal': return `opened ${param}`;
    case 'runSkill': return 'skill applied to the next send';
    default: return 'done';
  }
}

/**
 * Centralized project creation: every path (sidebar, palette, Chapters,
 * Story Bible, Story Agent) goes through here so `project:created` fires once
 * with the same side effects. Callers navigate themselves — a helper that
 * navigated would fight the Story Bible staying on its own view.
 */
export async function createProjectUi(name: string): Promise<any> {
  const p = await dbCall<any>('createProject', { name });
  await useData.getState().load();
  useData.getState().setActiveProject(p.id);
  runAutomations('project:created', { projectId: p.id });
  return p;
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
