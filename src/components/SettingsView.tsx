import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi, dbCall } from '../store';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { confirmDialog } from './TextPrompt';
import { SETTINGS_GROUPS, SETTINGS_INDEX, SECTION_DEFAULTS, SettingsSection, searchSettings } from '../lib/settingsIndex';

const SECTION_INDEX_BY_ID = new Map(SETTINGS_INDEX.map((e) => [e.id, e]));
import { ProvidersSection } from './settings/ProvidersSection';
import { ModelsSection } from './settings/ModelsSection';
import { BehaviorSection } from './settings/BehaviorSection';
import { StylesSection } from './settings/StylesSection';
import { SkillsSection } from './settings/SkillsSection';
import { AgentMdSection } from './settings/AgentMdSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { MemorySection } from './settings/MemorySection';
import { UsageSection } from './settings/UsageSection';
import { DataSection } from './settings/DataSection';
import { PluginsSection } from './settings/PluginsSection';
import { AutomationsSection } from './settings/AutomationsSection';
import { McpSection } from './settings/McpSection';
import { AboutSection } from './settings/AboutSection';
import type { AppInfo } from '../types';

/** Which guide article explains each settings section (Task 9). */
const SECTION_GUIDE: Record<string, string> = {
  providers: 'getting-started',
  models: 'models-and-cache',
  behavior: 'thinking',
  styles: 'chat',
  skills: 'skills',
  agentmd: 'agent-md',
  appearance: 'settings',
  memory: 'agent-md',
  usage: 'models-and-cache',
  data: 'privacy',
  plugins: 'plugins',
  automations: 'plugins',
  mcp: 'mcp',
  about: 'getting-started'
};

export function SettingsView({ initialSection, initialMode }: { initialSection?: string; initialMode?: 'simple' | 'advanced' }) {
  const t = useT();
  const ui = useUi();
  const settings = useSettings();
  // `initialMode` lets a caller (and the headless render test) open Settings in
  // Advanced without writing the preference; the toggle still persists.
  const mode = initialMode ?? settings.settingsMode;
  const [section, setSection] = useState<SettingsSection>((initialSection as SettingsSection) || 'models');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.inkwell.appInfo().then(setAppInfo).catch(() => {});
  }, []);

  useEffect(() => {
    if (section === 'plugins') window.inkwell.pluginLogs().then((r) => setLogs(r.data || [])).catch(() => {});
  }, [section]);

  // Deep link from the palette / settings search: the request is handed over
  // through the ui store so any mount point can honour it.
  const pendingSection = useUi((s) => s.settingsSection);
  const pendingFocus = useUi((s) => s.settingsFocus);
  useEffect(() => {
    if (!pendingSection) return;
    setSection(pendingSection as SettingsSection);
    useUi.getState().setSettingsSection(null);
  }, [pendingSection]);

  // An advanced section requested while Simple mode is on would render an empty
  // page; flip the mode instead of swallowing the navigation.
  useEffect(() => {
    if (mode === 'simple' && (section === 'plugins' || section === 'automations' || section === 'mcp')) {
      settings.set('settingsMode', 'advanced');
    }
  }, [section, mode]);

  useEffect(() => {
    if (!pendingFocus) return;
    const id = pendingFocus;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1400);
        const focusable = el.querySelector('input, select, textarea, button') as HTMLElement | null;
        focusable?.focus();
        useUi.getState().clearSettingsFocus();
        return;
      }
      // A control hidden by Simple mode is still reachable: reveal Advanced and
      // try again instead of dropping the user on a page with no target.
      if (mode === 'simple' && SECTION_INDEX_BY_ID.get(id)?.advancedOnly) {
        settings.set('settingsMode', 'advanced');
        return;
      }
      useUi.getState().clearSettingsFocus();
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingFocus, section, mode]);

  const results = useMemo(() => searchSettings(q, t, mode), [q, t, mode]);
  useEffect(() => { setSel(0); }, [q]);

  function openResult(index: number) {
    const hit = results[index];
    if (!hit) return;
    setSection(hit.entry.section);
    useUi.getState().setSettingsSection(null, hit.entry.id);
    setQ('');
    searchRef.current?.blur();
  }

  async function resetSection() {
    const defaults = SECTION_DEFAULTS[section];
    if (!defaults) return;
    const ok = await confirmDialog({
      title: t('settings.resetConfirm').replace('{section}', t('settings.' + section)),
      danger: true,
      confirmLabel: t('settings.reset'),
      cancelLabel: t('confirm.cancel')
    });
    if (!ok) return;
    const s = useSettings.getState();
    for (const [k, v] of Object.entries(defaults)) s.set(k as any, v as any);
    ui.toast(t('settings.resetDone'), 'ok');
  }

  const activeGroup = SETTINGS_GROUPS.find((g) => g.sections.includes(section));

  let body: React.ReactNode;
  switch (section) {
    case 'providers': body = <ProvidersSection />; break;
    case 'models': body = <ModelsSection />; break;
    case 'behavior': body = <BehaviorSection mode={mode} />; break;
    case 'styles': body = <StylesSection />; break;
    case 'skills': body = <SkillsSection />; break;
    case 'agentmd': body = <AgentMdSection />; break;
    case 'appearance': body = <AppearanceSection />; break;
    case 'memory': body = <MemorySection />; break;
    case 'usage': body = <UsageSection />; break;
    case 'data': body = <DataSection appInfo={appInfo} />; break;
    case 'plugins':
      body = (
        <PluginsSection
          logs={logs}
          reloadLogs={() => window.inkwell.pluginLogs().then((r) => setLogs(r.data || [])).catch(() => {})}
        />
      );
      break;
    case 'automations': body = <AutomationsSection />; break;
    case 'mcp': body = <McpSection />; break;
    case 'about': body = <AboutSection />; break;
    default: body = <ModelsSection />;
  }

  return (
    <div className="page" style={{ height: '100vh', overflow: 'hidden' }}>
      <div className="settings-layout">
        <div className="settings-nav">
          <h2 style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="settings" size={15} /> {t('settings.title')}
          </h2>

          <div className="settings-search">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); openResult(sel); }
                else if (e.key === 'Escape') { setQ(''); searchRef.current?.blur(); }
              }}
            />
            {q && (
              <button className="settings-search-x" onClick={() => setQ('')} aria-label={t('confirm.cancel')}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>

          {q.trim() ? (
            <div className="settings-results" role="listbox" aria-label={t('settings.search')}>
              {results.length === 0 && <div className="hint" style={{ padding: '6px 10px' }}>{t('palette.noResults')}</div>}
              {results.map((r, i) => (
                <button
                  key={r.entry.id}
                  data-id={r.entry.id}
                  role="option"
                  aria-selected={i === sel}
                  className={`settings-result ${i === sel ? 'active' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => openResult(i)}
                >
                  <span>{r.label}</span>
                  <small>{t('settings.' + r.entry.section)}</small>
                </button>
              ))}
            </div>
          ) : (
            SETTINGS_GROUPS.map((g) => {
              if (g.advancedOnly && mode === 'simple') return null;
              return (
                <div className="settings-group" key={g.id}>
                  <div className="settings-group-label">{t(g.labelKey)}</div>
                  {g.sections.map((s) => (
                    <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
                      {t('settings.' + s)}
                    </button>
                  ))}
                </div>
              );
            })
          )}

          <div className="settings-mode">
            <button
              className="settings-mode-toggle"
              id="set-settings-mode"
              onClick={() => settings.set('settingsMode', mode === 'simple' ? 'advanced' : 'simple')}
              title={t('settings.modeHint')}
            >
              <Icon name={mode === 'simple' ? 'sparkle' : 'settings'} size={13} />
              {mode === 'simple' ? t('settings.showAdvanced') : t('settings.showSimple')}
            </button>
          </div>
        </div>

        <div className="settings-content">
          <div className="settings-section-bar">
            <span className="crumb">
              {activeGroup ? t(activeGroup.labelKey) : t('settings.title')}
              <Icon name="chevronRight" size={11} />
              {t('settings.' + section)}
            </span>
            <span style={{ flex: 1 }} />
            {/* Contextual help: the guide article for this section, so every
                control has a documented answer one click away (Task 9). */}
            <button
              className="small ghost"
              id="set-section-help"
              title={t('settings.help')}
              aria-label={t('settings.help')}
              onClick={() => {
                useData.getState().setGuideSlug(SECTION_GUIDE[section] || 'settings');
                useData.getState().navigate('guide');
              }}
            >
              <Icon name="book" size={12} /> {t('settings.help')}
            </button>
            {SECTION_DEFAULTS[section] && (
              <button className="small ghost" id="set-section-reset" onClick={resetSection}>
                <Icon name="refresh" size={12} /> {t('settings.reset')}
              </button>
            )}
          </div>
          {body}
        </div>
      </div>
    </div>
  );
}
