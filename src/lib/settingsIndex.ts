/**
 * Settings information architecture (v1.2.3 Task 6).
 *
 * One registry drives three surfaces that used to disagree: the grouped nav,
 * the global settings search, and deep links from the command palette. Every
 * entry names a *real* control id, and `scripts/settings-index-test.mjs` fails
 * if a section id typos its way out of the union or two entries share a label.
 *
 * Rules:
 *  - a section always appears in exactly one group,
 *  - `keywords` carry both languages so search works before the UI is localized
 *    in a given install,
 *  - nothing here knows about React; the shell owns scrolling and focus.
 */

export type SettingsSection =
  | 'providers'
  | 'models'
  | 'behavior'
  | 'styles'
  | 'skills'
  | 'agentmd'
  | 'appearance'
  | 'memory'
  | 'usage'
  | 'data'
  | 'plugins'
  | 'automations'
  | 'mcp'
  | 'about';

export type SettingsGroupId = 'ai' | 'chat' | 'appearance' | 'data' | 'extend' | 'about';

export interface SettingsGroup {
  id: SettingsGroupId;
  /** i18n key for the group heading. */
  labelKey: string;
  sections: SettingsSection[];
  /** Hidden in Simple mode — the Extend tooling is an advanced surface. */
  advancedOnly?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  'providers', 'models', 'behavior',
  'styles', 'skills', 'agentmd',
  'appearance',
  'memory', 'usage', 'data',
  'plugins', 'automations', 'mcp',
  'about'
];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: 'ai', labelKey: 'settings.group.ai', sections: ['providers', 'models', 'behavior'] },
  { id: 'chat', labelKey: 'settings.group.chat', sections: ['styles', 'skills', 'agentmd'] },
  { id: 'appearance', labelKey: 'settings.group.appearance', sections: ['appearance'] },
  { id: 'data', labelKey: 'settings.group.data', sections: ['memory', 'usage', 'data'] },
  { id: 'extend', labelKey: 'settings.group.extend', sections: ['plugins', 'automations', 'mcp'], advancedOnly: true },
  { id: 'about', labelKey: 'settings.group.about', sections: ['about'] }
];

export interface SettingsEntry {
  /** DOM id of the control. The shell scrolls to it and flashes it. */
  id: string;
  section: SettingsSection;
  /** i18n key for the control's name. */
  labelKey: string;
  keywords: string[];
  /** Hidden unless Settings is in Advanced mode. */
  advancedOnly?: boolean;
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  // ---- AI ----
  { id: 'set-smart-setup', section: 'providers', labelKey: 'smart.title', keywords: ['setup', 'wizard', 'preset', 'api key', 'connect', 'provider', 'hubungkan', 'kunci'] },
  { id: 'set-provider-preset', section: 'providers', labelKey: 'providers.presets', keywords: ['preset', 'openai', 'anthropic', 'deepseek', 'gemini', 'local', 'ollama', 'provider'] },
  { id: 'set-provider-add', section: 'providers', labelKey: 'providers.add', keywords: ['add provider', 'new provider', 'tambah provider', 'endpoint'] },
  { id: 'set-provider-verify-all', section: 'providers', labelKey: 'providers.verifyAll', keywords: ['verify', 'test', 'health', 'probe', 'uji', 'cek'] },
  { id: 'set-default-model', section: 'models', labelKey: 'models.default', keywords: ['default model', 'model default', 'auto', 'choose model', 'pilih model'] },
  { id: 'set-smart-defaults', section: 'models', labelKey: 'models.smartDefaults', keywords: ['smart', 'auto tune', 'pintar', 'otomatis'] },
  { id: 'set-model-table', section: 'models', labelKey: 'models.table', keywords: ['context', 'max output', 'reasoning', 'cache', 'capability', 'token', 'konteks', 'penalaran'] },
  { id: 'set-author-name', section: 'behavior', labelKey: 'behavior.authorName', keywords: ['author', 'name', 'epub', 'penulis', 'nama'] },
  { id: 'set-temperature', section: 'behavior', labelKey: 'behavior.temperature', keywords: ['temperature', 'creativity', 'suhu', 'kreativitas'] },
  { id: 'set-max-tokens', section: 'behavior', labelKey: 'behavior.maxTokens', keywords: ['max tokens', 'output', 'length', 'panjang'] },
  { id: 'set-top-p', section: 'behavior', labelKey: 'behavior.topP', keywords: ['top p', 'nucleus', 'sampling'], advancedOnly: true },
  { id: 'set-thinking-enabled', section: 'behavior', labelKey: 'behavior.thinking', keywords: ['thinking', 'reasoning', 'berpikir', 'penalaran'] },
  { id: 'set-thinking-budget', section: 'behavior', labelKey: 'behavior.thinkingBudget', keywords: ['budget', 'thinking tokens', 'anggaran'], advancedOnly: true },
  { id: 'set-thinking-display', section: 'behavior', labelKey: 'behavior.thinkingDisplay', keywords: ['thinking display', 'collapse', 'expand', 'tampilan'] },
  { id: 'set-thinking-ui', section: 'behavior', labelKey: 'behavior.thinkingUi', keywords: ['thinking control', 'always', 'auto', 'kontrol'] },
  { id: 'set-default-system', section: 'behavior', labelKey: 'behavior.systemPrompt', keywords: ['system prompt', 'instructions', 'prompt sistem', 'instruksi'] },
  // ---- Chat craft ----
  { id: 'set-default-style', section: 'styles', labelKey: 'style.active', keywords: ['style', 'persona', 'tone', 'voice', 'gaya', 'nada'] },
  { id: 'set-skills-list', section: 'skills', labelKey: 'settings.skills', keywords: ['skills', 'beta reader', 'editor', 'keahlian'] },
  { id: 'set-agentmd-editor', section: 'agentmd', labelKey: 'agentmd.title', keywords: ['agent.md', 'instructions', 'rules', 'aturan', 'instruksi'] },
  // ---- Appearance ----
  { id: 'set-theme', section: 'appearance', labelKey: 'appearance.theme', keywords: ['theme', 'dark', 'light', 'tema', 'gelap', 'terang'] },
  { id: 'set-accent', section: 'appearance', labelKey: 'appearance.accent', keywords: ['accent', 'color', 'warna', 'aksen'] },
  { id: 'set-font-size', section: 'appearance', labelKey: 'appearance.font', keywords: ['font', 'size', 'text', 'huruf', 'ukuran'] },
  { id: 'set-settings-mode', section: 'appearance', labelKey: 'settings.mode', keywords: ['simple', 'advanced', 'sederhana', 'lanjutan', 'mode'] },
  { id: 'set-motion', section: 'appearance', labelKey: 'appearance.motion', keywords: ['motion', 'animation', 'reduce', 'animasi', 'gerak', 'kurangi'] },
  // ---- Data ----
  { id: 'set-memory-auto', section: 'memory', labelKey: 'memory.auto', keywords: ['memory', 'auto memory', 'memori', 'otomatis'] },
  { id: 'set-memory-list', section: 'memory', labelKey: 'memory.title', keywords: ['memory list', 'forget', 'daftar memori', 'hapus memori'] },
  { id: 'set-usage-totals', section: 'usage', labelKey: 'usage.title', keywords: ['usage', 'tokens', 'cost', 'cache', 'penggunaan', 'token'] },
  { id: 'set-data-path', section: 'data', labelKey: 'data.path', keywords: ['data path', 'folder', 'database', 'lokasi'] },
  { id: 'set-data-chatfiles', section: 'data', labelKey: 'data.chatFiles', keywords: ['attachments', 'files', 'clear files', 'lampiran', 'file'] },
  { id: 'set-data-compact', section: 'data', labelKey: 'data.compact', keywords: ['compact', 'vacuum', 'shrink', 'kompres', 'rapikan'] },
  { id: 'set-data-reset', section: 'data', labelKey: 'data.reset', keywords: ['reset', 'erase', 'delete all', 'hapus semua'] },
  // ---- Extend (advanced only) ----
  { id: 'set-plugins-list', section: 'plugins', labelKey: 'settings.plugins', keywords: ['plugins', 'extension', 'script', 'ekstensi'] },
  { id: 'set-automations-list', section: 'automations', labelKey: 'settings.automations', keywords: ['automation', 'trigger', 'hook', 'otomasi', 'pemicu'] },
  { id: 'set-mcp-list', section: 'mcp', labelKey: 'settings.mcp', keywords: ['mcp', 'server', 'tools', 'bridge'] },
  // ---- About ----
  { id: 'set-about-version', section: 'about', labelKey: 'about.version', keywords: ['version', 'update', 'versi'] },
  { id: 'set-about-vault', section: 'about', labelKey: 'about.vault', keywords: ['encryption', 'security', 'key vault', 'enkripsi', 'keamanan'] },
  { id: 'set-feedback-email', section: 'about', labelKey: 'about.feedback', keywords: ['feedback', 'email', 'contact', 'masukan', 'kontak'] }
];

/**
 * What “Reset to defaults” restores, per section. Sections absent from this map
 * have no settings of their own, so the UI hides the button instead of
 * pretending. Exported so the index test can keep it honest.
 */
export const SECTION_DEFAULTS: Partial<Record<SettingsSection, Record<string, unknown>>> = {
  appearance: { theme: 'dark-classic', accent: '#7c5cff', chatFontSize: 14 },
  behavior: {
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    defaultSystem: '',
    thinkingEnabled: true,
    thinkingBudget: 4096,
    thinkingDisplay: 'auto',
    thinkingUi: 'auto',
    authorName: ''
  },
  models: { smartDefaults: true, defaultModelRef: null, modelOverrides: {}, defaultModel: null },
  styles: { defaultStyleId: null },
  memory: { autoMemory: true }
};

/** Sections visible at the current mode. Simple never loses a section — it
 *  moves the Extend group behind the mode switch. */
export function visibleSections(mode: 'simple' | 'advanced'): SettingsSection[] {
  return mode === 'advanced'
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((s) => !['plugins', 'automations', 'mcp'].includes(s));
}

export interface SettingsSearchHit {
  entry: SettingsEntry;
  label: string;
  score: number;
}

/**
 * Case-insensitive search over the translated label and the bilingual keyword
 * list. A label prefix beats a label substring, which beats a keyword hit, so
 * typing "cach" lands on Prompt cache before "chat".
 */
export function searchSettings(
  query: string,
  t: (key: string) => string,
  mode: 'simple' | 'advanced' = 'advanced'
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of SETTINGS_INDEX) {
    if (entry.advancedOnly && mode !== 'advanced') continue;
    if (mode !== 'advanced' && ['plugins', 'automations', 'mcp'].includes(entry.section)) continue;
    const label = t(entry.labelKey);
    const haystack = [label, t('settings.' + entry.section), ...entry.keywords].join(' ');
    const lower = label.toLowerCase();
    let score = 0;
    if (lower.startsWith(q)) score = 100;
    else if (lower.includes(q)) score = 60;
    else if (haystack.toLowerCase().includes(q)) score = 30;
    if (!score) continue;
    // Shorter labels are more specific; nudge them up.
    hits.push({ entry, label, score: score + Math.max(0, 20 - lower.length) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}
