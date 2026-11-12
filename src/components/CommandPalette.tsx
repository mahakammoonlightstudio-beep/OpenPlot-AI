import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi, dbCall, createChatUi, createProjectUi, runAutomations, providerList } from '../store';
import { useT } from '../i18nReact';
import { textPrompt } from './TextPrompt';
import { Icon, IconName } from './Icons';
import { openPromptLibraryUi } from '../App';
import { visibleSections } from '../lib/settingsIndex';
import { GUIDE_DOCS } from '../guide';
import { articleList as guideArticles } from '../guide/content';
import { guideLangFor } from '../i18n';
import { thinkingSupport } from '../lib/modelCaps';

type CmdGroup = 'actions' | 'models' | 'skills' | 'plugins' | 'chats' | 'projects';
interface Cmd { id: string; label: string; icon: IconName; hint?: string; group: CmdGroup; run: () => void }

// Subsequence fuzzy match with a small score so "ebd" still finds "Export chat
// as Markdown" but contiguous hits rank first.
function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) return 1000 - direct; // contiguous beats scattered
  let hi = 0, score = 0, streak = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const found = h.indexOf(n[ni], hi);
    if (found < 0) return 0;
    streak = found === hi ? streak + 1 : 0;
    score += 10 + streak * 4 - Math.min(found - hi, 8);
    hi = found + 1;
  }
  return score;
}

export function CommandPalette() {
  const t = useT();
  const ui = useUi();
  const settings = useSettings();
  const { chats, providers, skills, projects, navigate, activeChatId, activeProjectId } = useData();
  const mode = ui.paletteMode;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  // Loaded plugin commands are fetched when the palette opens — the bridge
  // lives in the main process, so they cannot be built synchronously.
  const [pluginCmds, setPluginCmds] = useState<Array<{ id: string; name: string; commands: string[] }>>([]);
  useEffect(() => {
    if (!ui.paletteOpen) return;
    window.inkwell.listLoadedPlugins()
      .then((r) => setPluginCmds((r.data || []).filter((p: any) => p.enabled !== false)))
      .catch(() => setPluginCmds([]));
  }, [ui.paletteOpen]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ui.paletteOpen) {
      setQ('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [ui.paletteOpen, ui.paletteMode]);

  const cmds: Cmd[] = useMemo(() => {
    const base: Cmd[] = [
      { id: 'new-chat', group: 'actions', label: t('app.newChat'), icon: 'chat', hint: 'Ctrl+N', run: () => createChatUi() },
      { id: 'new-project', group: 'actions', label: t('app.newProject'), icon: 'folder', hint: 'Ctrl+Shift+N', run: async () => {
        const name = await textPrompt({ title: t('projects.name'), confirmLabel: t('projects.create') });
        if (!name) return;
        await createProjectUi(name);
        navigate('projects');
      } },
      { id: 'search', group: 'actions', label: t('palette.search'), icon: 'chat', hint: 'Ctrl+F', run: () => window.dispatchEvent(new CustomEvent('inkwell:focus-search')) },
      { id: 'prompts', group: 'actions', label: t('prompt.title'), icon: 'scroll', hint: 'Ctrl+/', run: () => openPromptLibraryUi() },
      { id: 'agent', group: 'actions', label: t('advance.agent'), icon: 'tools', run: () => navigate('agent') },
      { id: 'write', group: 'actions', label: t('advance.write'), icon: 'quill', run: () => navigate('write') },
      { id: 'story-agent', group: 'actions', label: t('app.agent'), icon: 'sparkle', run: () => navigate('story-agent') },
      { id: 'story', group: 'actions', label: t('app.story'), icon: 'book', run: () => navigate('story') },
      { id: 'chapters', group: 'actions', label: t('app.chapters'), icon: 'book', run: () => navigate('chapters') },
      { id: 'flow', group: 'actions', label: t('app.flow'), icon: 'target', run: () => navigate('flow') },
      { id: 'stats', group: 'actions', label: t('app.stats'), icon: 'target', run: () => navigate('stats') },
      { id: 'dump', group: 'actions', label: t('dump.title'), icon: 'trash', run: () => navigate('dump') },
      { id: 'settings', group: 'actions', label: t('app.settings'), icon: 'settings', hint: 'Ctrl+,', run: () => navigate('settings') },
      // Every Settings section is one palette entry, so “settings: models” or
      // “pengaturan: model” lands on the control without clicking through nav.
      ...visibleSections(settings.settingsMode).map((s) => ({
        id: 'set-open-' + s,
        group: 'actions' as const,
        label: `${t('app.settings')}: ${t('settings.' + s)}`,
        icon: 'settings' as const,
        run: () => { useUi.getState().setSettingsSection(s); navigate('settings'); }
      })),
      { id: 'settings-mode', group: 'actions', label: settings.settingsMode === 'simple' ? t('settings.showAdvanced') : t('settings.showSimple'), icon: 'settings', run: () => {
        const next = settings.settingsMode === 'simple' ? 'advanced' : 'simple';
        useSettings.getState().set('settingsMode', next);
        ui.toast(next === 'advanced' ? t('settings.showAdvanced') : t('settings.showSimple'), 'ok');
      } },
      { id: 'guide', group: 'actions', label: t('guide.title'), icon: 'book', hint: 'F1', run: () => navigate('guide') },
      { id: 'shortcuts-sheet', group: 'actions', label: t('shortcut.title'), icon: 'cpu', hint: 'Ctrl+Shift+/', run: () => useUi.getState().setShortcuts(true) },
      { id: 'about', group: 'actions', label: t('app.about'), icon: 'file', run: () => navigate('about') }
    ];
    // Every guide article is reachable by name, so “cache” or “skills” opens
    // the page instead of a section that merely mentions it.
    for (const doc of guideArticles(guideLangFor(settings.lang), GUIDE_DOCS)) {
      base.push({
        id: 'guide-' + doc.slug,
        group: 'actions',
        label: `${t('guide.title')}: ${doc.title}`,
        icon: 'book',
        run: () => { useData.getState().setGuideSlug(doc.slug); navigate('guide'); }
      });
    }
    if (activeChatId) {
      const chat = useData.getState().chats.find((c) => c.id === activeChatId);
      if (chat) {
        base.push({ id: 'export-md', group: 'actions', label: t('palette.exportMd'), icon: 'download', run: () => { navigate('chat'); window.dispatchEvent(new CustomEvent('inkwell:export-chat', { detail: 'md' })); } });
        base.push({ id: 'export-json', group: 'actions', label: t('palette.exportJson'), icon: 'download', run: () => { navigate('chat'); window.dispatchEvent(new CustomEvent('inkwell:export-chat', { detail: 'json' })); } });
        base.push({ id: 'regen', group: 'actions', label: t('palette.regen'), icon: 'refresh', run: () => { navigate('chat'); window.dispatchEvent(new CustomEvent('inkwell:regen-last')); } });
      }
    }
    base.push({ id: 'cycle-theme', group: 'actions', label: t('palette.cycleTheme'), icon: 'settings', run: () => {
      const order = ['dark-classic', 'midnight-ink', 'nord', 'dracula', 'solarized', 'forest', 'rose-dawn', 'ocean', 'sepia', 'light-paper'];
      const next = order[(order.indexOf(settings.theme) + 1) % order.length];
      useSettings.getState().set('theme', next);
      ui.toast(`${t('palette.cycleTheme')}: ${next}`, 'ok');
    } });
    // ---- models (grouped by provider, with a thinking hint) ----
    // Picking one sets the app default AND the active chat's model, so the
    // choice sticks where the user is looking instead of only for new chats.
    const modelCmds: Cmd[] = [];
    for (const p of providers.filter((x) => Number(x.enabled) !== 0)) {
      for (const m of providerList(p.models)) {
        const support = thinkingSupport(m, { kind: (p as any).kind || 'auto', record: settings.modelCaps[`${p.id}::${m}`] });
        modelCmds.push({
          id: 'model-' + p.id + '-' + m,
          group: 'models',
          label: m,
          icon: 'cpu',
          hint: support === 'no' ? p.name : `${p.name} · ${t('palette.thinkHint')}`,
          run: () => {
            useSettings.getState().set('defaultModel', m);
            useSettings.getState().set('defaultModelRef', { providerId: p.id, model: m });
            const chatId = useData.getState().activeChatId;
            if (chatId) void dbCall('updateChat', { id: chatId, model: m }).then(() => useData.getState().reloadChatRelated());
            ui.toast(m, 'ok');
          }
        });
      }
    }

    // ---- skills: on/off straight from the palette ----
    const skillCmds: Cmd[] = (skills || []).map((s) => {
      const on = Number(s.enabled) === 1;
      return {
        id: 'skill-' + s.id,
        group: 'skills' as const,
        label: s.name,
        icon: 'sparkle' as const,
        hint: on ? t('palette.skillOn') : t('palette.skillOff'),
        run: async () => {
          await dbCall('saveSkill', { id: s.id, name: s.name, description: s.description || '', content: s.content, enabled: !on });
          await useData.getState().load();
          if (!on) runAutomations('skill:enabled', { skillId: s.id });
          ui.toast(`${s.name}: ${on ? t('palette.skillOff') : t('palette.skillOn')}`, 'ok');
        }
      };
    });

    // ---- plugin commands (one entry per registered command) ----
    const pluginEntries: Cmd[] = [];
    for (const p of pluginCmds) {
      for (const c of p.commands || []) {
        pluginEntries.push({
          id: `plug-${p.id}-${c}`,
          group: 'plugins',
          label: `${p.name}: ${c}`,
          icon: 'plug',
          hint: t('palette.groupPlugins'),
          run: async () => {
            const r = await window.inkwell.runPlugin(p.id, c);
            ui.toast(r.ok ? `${p.name}: ${c}` : (r.error || 'failed'), r.ok ? 'ok' : 'error');
          }
        });
      }
    }

    // Quick switch: chats and projects are first-class results, not just
    // recent-history shortcuts. The current item leads the empty list, pinned
    // rows follow, then newest; every chat is searchable (not only 30).
    const orderedChats = [...chats].sort((a, b) => {
      if (a.id === b.id) return 0;
      if (a.id === activeChatId) return -1;
      if (b.id === activeChatId) return 1;
      const pin = Number(b.pinned || 0) - Number(a.pinned || 0);
      return pin || (b.updated_at || 0) - (a.updated_at || 0);
    });
    const chatCounts = new Map<string, number>();
    for (const c of chats) {
      if (c.project_id) chatCounts.set(c.project_id, (chatCounts.get(c.project_id) || 0) + 1);
    }
    const chatCmds: Cmd[] = orderedChats.map((c) => {
      const project = c.project_id ? projects.find((p) => p.id === c.project_id) : null;
      const bits: string[] = [];
      if (project) bits.push(project.name);
      if (c.workspace === 'agent') bits.push(t('advance.agent'));
      if (!bits.length) bits.push(t('advance.chat'));
      if (c.id === activeChatId) bits.push(t('palette.current'));
      return {
        id: 'chat-' + c.id,
        group: 'chats' as const,
        label: c.title || t('app.newChat'),
        icon: 'chat' as const,
        hint: bits.join(' · '),
        // setActiveChat already lands in the chat's own workspace (Agent or
        // Chat); navigating to 'chat' here used to pull Agent sessions out of
        // their desk.
        run: () => useData.getState().setActiveChat(c.id)
      };
    });
    const orderedProjects = [...projects].sort((a, b) => {
      if (a.id === b.id) return 0;
      if (a.id === activeProjectId) return -1;
      if (b.id === activeProjectId) return 1;
      return 0;
    });
    const projCmds: Cmd[] = orderedProjects.map((p) => {
      const count = chatCounts.get(p.id) || 0;
      return {
        id: 'proj-' + p.id,
        group: 'projects' as const,
        label: p.name,
        icon: 'folder' as const,
        hint: p.id === activeProjectId
          ? t('palette.current')
          : count === 1
            ? t('palette.chatCountOne').replace('{n}', '1')
            : count ? t('palette.chatCount').replace('{n}', String(count)) : '',
        run: () => { useData.getState().setActiveProject(p.id); navigate('projects'); }
      };
    });
    return [...base, ...modelCmds, ...skillCmds, ...pluginEntries, ...chatCmds, ...projCmds];
  }, [chats, projects, providers, skills, pluginCmds, t, settings.theme, settings.settingsMode, settings.modelCaps, navigate, ui, activeChatId, activeProjectId]);

  const results = useMemo(() => {
    const query = q.trim();
    const switching = mode === 'switch';
    // Ctrl+P is a switcher, not a second command list: only chats and projects
    // compete, and every one of them is searchable.
    const pool = switching ? cmds.filter((c) => c.group === 'chats' || c.group === 'projects') : cmds;
    if (!query) {
      // With no query every command scores the same, so a flat cap used to show
      // only the first handful of actions — chats, models, skills and plugin
      // commands were unreachable until you typed something. Show a few per
      // group instead, keeping the curated order.
      const perGroup = switching ? 8 : 5;
      const seen: Record<string, number> = {};
      return pool.filter((c) => {
        seen[c.group] = (seen[c.group] || 0) + 1;
        return seen[c.group] <= perGroup;
      });
    }
    const scored = pool
      .map((c) => ({ c, s: fuzzyScore(query, c.label + ' ' + (c.hint || '')) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, switching ? 20 : 14).map((x) => x.c);
  }, [q, cmds, mode]);

  // keep selection in bounds as the result list shrinks
  useEffect(() => {
    if (sel >= results.length) setSel(Math.max(0, results.length - 1));
  }, [results.length, sel]);

  // keep the highlighted row visible while arrowing through the list
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [sel, results]);

  // Focus rescue: the palette's input holds focus while open. When it closes,
  // that element unmounts and focus falls to <body> — the same "can't type
  // anywhere" symptom as the native confirm() bug. Pull focus back to the
  // app root after unmount.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (ui.paletteOpen) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    requestAnimationFrame(() => {
      const root = document.getElementById('app-root');
      if (!root) return;
      const ae = document.activeElement;
      if (ae === document.body || (ae && !document.contains(ae))) root.focus();
    });
  }, [ui.paletteOpen]);

  if (!ui.paletteOpen) return null;

  const groups: Array<{ key: CmdGroup; label: string }> = mode === 'switch'
    ? [
        { key: 'chats', label: t('palette.groupChats') },
        { key: 'projects', label: t('palette.groupProjects') }
      ]
    : [
        { key: 'actions', label: t('palette.groupActions') },
        { key: 'models', label: t('palette.groupModels') },
        { key: 'skills', label: t('palette.groupSkills') },
        { key: 'plugins', label: t('palette.groupPlugins') },
        { key: 'chats', label: t('palette.groupChats') },
        { key: 'projects', label: t('palette.groupProjects') }
      ];
  const placeholder = mode === 'switch' ? t('palette.switchPlaceholder') : t('palette.placeholder');

  const renderItem = (r: Cmd, i: number) => {
    const active = i === sel;
    return (
      <div
        key={r.id}
        className={`palette-item ${active ? 'active' : ''}`}
        onMouseEnter={() => setSel(i)}
        onClick={() => { r.run(); ui.setPalette(false); }}
      >
        <Icon name={r.icon} size={15} />
        <span className="plabel">{r.label}</span>
        {r.hint && <span className="phint">{r.hint}</span>}
      </div>
    );
  };

  return (
    <div className="palette-overlay" onClick={() => ui.setPalette(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={placeholder}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); results[sel]?.run(); ui.setPalette(false); }
            else if (e.key === 'Escape') ui.setPalette(false);
          }}
          aria-label={placeholder}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && (
            <div className="palette-empty">{mode === 'switch' ? t('palette.noSwitchResults') : t('palette.noResults')}</div>
          )}
          {mode === 'switch' && q.trim()
            // While searching, show the true score order. Grouped rendering
            // used to paint a chat above a more relevant project because the
            // group order was fixed, so Enter could select a row that was not
            // visually first.
            ? results.map((r, i) => renderItem(r, i))
            : groups.map((g) => {
                const items = results.filter((r) => r.group === g.key);
                if (!items.length) return null;
                return (
                  <div key={g.key}>
                    <div className="palette-group">{g.label}</div>
                    {items.map((r) => renderItem(r, results.findIndex((x) => x.id === r.id)))}
                  </div>
                );
              })}
        </div>
      </div>
    </div>
  );
}
