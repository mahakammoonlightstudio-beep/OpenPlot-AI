import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi, dbCall, createChatUi } from '../store';
import { useT } from '../i18nReact';
import { textPrompt } from './TextPrompt';
import { Icon, IconName } from './Icons';
import { openPromptLibraryUi } from '../App';

interface Cmd { id: string; label: string; icon: IconName; hint?: string; group: 'actions' | 'chats' | 'projects'; run: () => void }

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
  const { chats, setActiveChat, navigate, setActiveProject, projects } = useData();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ui.paletteOpen) {
      setQ('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [ui.paletteOpen]);

  const cmds: Cmd[] = useMemo(() => {
    const activeChatId = useData.getState().activeChatId;
    const base: Cmd[] = [
      { id: 'new-chat', group: 'actions', label: t('app.newChat'), icon: 'chat', hint: 'Ctrl+N', run: () => createChatUi() },
      { id: 'new-project', group: 'actions', label: t('app.newProject'), icon: 'folder', hint: 'Ctrl+Shift+N', run: async () => {
        const name = await textPrompt({ title: t('projects.name'), confirmLabel: t('projects.create') });
        if (!name) return;
        const p = await dbCall<any>('createProject', { name });
        await useData.getState().load();
        useData.getState().setActiveProject(p.id);
        navigate('projects');
      } },
      { id: 'search', group: 'actions', label: t('palette.search'), icon: 'chat', hint: 'Ctrl+F', run: () => window.dispatchEvent(new CustomEvent('inkwell:focus-search')) },
      { id: 'prompts', group: 'actions', label: t('prompt.title'), icon: 'scroll', hint: 'Ctrl+/', run: () => openPromptLibraryUi() },
      { id: 'story', group: 'actions', label: t('app.story'), icon: 'book', run: () => navigate('story') },
      { id: 'chapters', group: 'actions', label: t('app.chapters'), icon: 'book', run: () => navigate('chapters') },
      { id: 'flow', group: 'actions', label: t('app.flow'), icon: 'target', run: () => navigate('flow') },
      { id: 'stats', group: 'actions', label: t('app.stats'), icon: 'target', run: () => navigate('stats') },
      { id: 'settings', group: 'actions', label: t('app.settings'), icon: 'settings', hint: 'Ctrl+,', run: () => navigate('settings') },
      { id: 'settings-appearance', group: 'actions', label: t('settings.appearance'), icon: 'settings', run: () => navigate('settings-appearance') },
      { id: 'settings-plugins', group: 'actions', label: t('settings.plugins'), icon: 'plug', run: () => navigate('settings-plugins') },
      { id: 'about', group: 'actions', label: t('app.about'), icon: 'file', run: () => navigate('about') }
    ];
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
    // Most recently updated chats first
    const recent = [...chats].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 30);
    const chatCmds: Cmd[] = recent.map((c) => ({
      id: 'chat-' + c.id, group: 'chats', label: c.title, icon: 'chat', hint: t('palette.groupChats'),
      run: () => { useData.getState().setActiveChat(c.id); navigate('chat'); }
    }));
    const projCmds: Cmd[] = projects.map((p) => ({
      id: 'proj-' + p.id, group: 'projects', label: p.name, icon: 'folder', hint: t('palette.groupProjects'),
      run: () => { useData.getState().setActiveProject(p.id); navigate('projects'); }
    }));
    return [...base, ...chatCmds, ...projCmds];
  }, [chats, projects, t, settings.theme, navigate, ui]);

  const results = useMemo(() => {
    const scored = cmds
      .map((c) => ({ c, s: fuzzyScore(q.trim(), c.label + ' ' + (c.hint || '')) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, 14).map((x) => x.c);
  }, [q, cmds]);

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

  const groups: Array<{ key: Cmd['group']; label: string }> = [
    { key: 'actions', label: t('palette.groupActions') },
    { key: 'chats', label: t('palette.groupChats') },
    { key: 'projects', label: t('palette.groupProjects') }
  ];

  return (
    <div className="palette-overlay" onClick={() => ui.setPalette(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={t('palette.placeholder')}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); results[sel]?.run(); ui.setPalette(false); }
            else if (e.key === 'Escape') ui.setPalette(false);
          }}
          aria-label={t('palette.placeholder')}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">{t('palette.noResults')}</div>}
          {groups.map((g) => {
            const items = results.map((r) => ({ r })).filter((x) => x.r.group === g.key);
            if (!items.length) return null;
            return (
              <div key={g.key}>
                <div className="palette-group">{g.label}</div>
                {items.map(({ r }) => {
                  const i = results.findIndex((x) => x.id === r.id);
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
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
