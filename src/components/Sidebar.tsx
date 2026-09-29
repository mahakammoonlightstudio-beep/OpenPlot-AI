import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, dbCall, createChatUi } from '../store';
import { Chat, Folder, Project } from '../types';
import { useT } from '../i18nReact';
import { textPrompt, confirmDialog } from './TextPrompt';
import { Icon, LogoMark } from './Icons';
import { useUnreadStore } from '../unreadStore';

export function Sidebar() {
  const t = useT();
  const settings = useSettings();
  const { chats, folders, projects, activeChatId, setActiveChat, navigate, setActiveProject, activeProjectId, route } = useData();
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl+F / native menu: focus the chat search from anywhere
  useEffect(() => {
    const focus = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('inkwell:focus-search', focus);
    return () => window.removeEventListener('inkwell:focus-search', focus);
  }, []);

  async function newChat() {
    await createChatUi('New chat', activeProjectId);
  }

  async function newFolder() {
    const name = await textPrompt({ title: t('folders.new'), confirmLabel: t('folders.create') });
    if (!name) return;
    await dbCall('createFolder', { name, project_id: null });
    await useData.getState().reloadChatRelated();
  }

  async function newProject() {
    const name = await textPrompt({ title: t('projects.name'), confirmLabel: t('projects.create') });
    if (!name) return;
    const p = await dbCall<Project>('createProject', { name });
    await useData.getState().load();
    setActiveProject(p.id);
    navigate('projects');
  }

  async function renameChat(c: Chat) {
    const name = await textPrompt({ title: t('chat.titlePrompt'), defaultValue: c.title });
    if (!name) return;
    await dbCall('updateChat', { id: c.id, title: name });
    await useData.getState().reloadChatRelated();
  }

  async function deleteChat(c: Chat) {
    if (!(await confirmDialog({ title: t('confirm.deleteChat'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteChat', { id: c.id });
    useUnreadStore.getState().forget(c.id);
    if (activeChatId === c.id) setActiveChat(null);
    await useData.getState().reloadChatRelated();
  }

  async function toggleFolder(f: Folder) {
    await dbCall('updateFolder', { id: f.id, expanded: Number(f.expanded) === 1 ? 0 : 1 });
    await useData.getState().reloadChatRelated();
  }

  async function deleteFolder(f: Folder) {
    if (!(await confirmDialog({ title: t('confirm.deleteFolder'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteFolder', { id: f.id });
    await useData.getState().reloadChatRelated();
  }

  async function deleteProject(p: Project) {
    if (!(await confirmDialog({ title: t('confirm.deleteProject'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteProject', { id: p.id });
    const fresh = await dbCall<Project[]>('listProjects');
    if (activeProjectId === p.id || !fresh.some((x) => x.id === activeProjectId)) {
      setActiveProject(fresh[0]?.id || null);
    }
    await useData.getState().load();
  }

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? chats.filter((c) => c.title.toLowerCase().includes(needle)) : chats),
    [chats, needle]
  );

  // Deep search: also look INSIDE message content across all chats (debounced)
  interface MsgHit { id: string; chat_id: string; content: string; chat_title: string; matches: number }
  const [msgHits, setMsgHits] = useState<MsgHit[]>([]);
  useEffect(() => {
    const n = q.trim();
    if (n.length < 2) { setMsgHits([]); return; }
    const timer = setTimeout(async () => {
      try {
        const rows = await dbCall<MsgHit[]>('searchMessages', { q: n });
        setMsgHits(rows || []);
      } catch { setMsgHits([]); }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  // chats matched by content but not already listed by title
  const contentOnlyChats = useMemo(() => {
    const hitIds = new Set(msgHits.map((h) => h.chat_id));
    const titleIds = new Set(filtered.map((c) => c.id));
    return chats.filter((c) => hitIds.has(c.id) && !titleIds.has(c.id));
  }, [msgHits, filtered, chats]);
  const projectsFiltered = useMemo(
    () => (needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects),
    [projects, needle]
  );
  const foldersWithChats = useMemo(() => {
    return folders.map((f) => ({
      folder: f,
      chats: filtered.filter((c) => c.folder_id === f.id)
    }));
  }, [folders, filtered]);
  const looseChats = filtered.filter((c) => !c.folder_id);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <LogoMark size={26} />
          <span>Open<span className="ink">Plot</span>&nbsp;AI</span>
          <span className="version">{settings.version ? `v${settings.version}` : ''}</span>
        </div>
        <div className="new-buttons">
          <button className="primary" onClick={newChat}><Icon name="plus" size={14} /> {t('app.newChat')}</button>
          <button onClick={newProject} title={t('app.newProject')}><Icon name="folderPlus" size={15} /></button>
          <button onClick={newFolder} title={t('app.newFolder')}><Icon name="folderPlus" size={15} /></button>
        </div>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={14} style={{ position: 'absolute', margin: 8, pointerEvents: 'none', opacity: 0.55 }} />
        <input ref={searchRef} value={q} placeholder={t('app.search')} onChange={(e) => setQ(e.target.value)} aria-label={t('app.search')} />
        {q && (
          <button className="small ghost clear-btn" aria-label="Clear search" onClick={() => { setQ(''); searchRef.current?.focus(); }}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <div className="nav-tree">
        <div className="nav-section">
          <div className="nav-section-title">{t('app.chats')}</div>
          {foldersWithChats.map(({ folder, chats: fchats }) => (
            <div key={folder.id}>
              <div className="nav-item" onDoubleClick={() => toggleFolder(folder)}>
                <span className="icon" onClick={() => toggleFolder(folder)}><Icon name={Number(folder.expanded) === 1 ? 'chevronDown' : 'chevronRight'} size={13} /></span>
                <span className="title">{folder.name}</span>
                <span className="actions">
                  <button onClick={() => deleteFolder(folder)}><Icon name="trash" size={13} /></button>
                </span>
              </div>
              {Number(folder.expanded) === 1 && fchats.map((c) => (
                <div key={c.id} className={`nav-item ${c.id === activeChatId ? 'active' : ''}`} style={{ paddingLeft: 26 }}
                  onClick={() => { setActiveChat(c.id); navigate('chat'); }}>
                  <span className="icon"><Icon name="chat" size={14} /></span>
                  <span className="title">{c.title}</span>
                  <UnreadBadge chatId={c.id} />
                  <span className="actions">
                    <button title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); renameChat(c); }}><Icon name="pencil" size={13} /></button>
                    <button aria-label={t('chat.delete')} onClick={(e) => { e.stopPropagation(); deleteChat(c); }}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
          ))}
          {contentOnlyChats.map((c) => (
            <div key={c.id} className={`nav-item ${c.id === activeChatId ? 'active' : ''}`}
              onClick={() => { setActiveChat(c.id); navigate('chat'); }}>
              <span className="icon"><Icon name="search" size={14} /></span>
              <span className="title">{c.title}</span>
              <span className="match-count" title={t('app.msgMatches').replace('{n}', String(msgHits.filter((h) => h.chat_id === c.id).reduce((a, h) => a + h.matches, 0)))}>
                {msgHits.find((h) => h.chat_id === c.id)?.matches}
              </span>
            </div>
          ))}
          {msgHits.length > 0 && (
            <div className="nav-hint">{t('app.msgMatches').replace('{n}', String(msgHits.reduce((a, h) => a + h.matches, 0)))}</div>
          )}
          {looseChats.map((c) => (
            <div key={c.id} className={`nav-item ${c.id === activeChatId ? 'active' : ''}`}
              onClick={() => { setActiveChat(c.id); navigate('chat'); }}>
              <span className="icon"><Icon name="chat" size={14} /></span>
              <span className="title">{c.title}</span>
              <UnreadBadge chatId={c.id} />
              <span className="actions">
                <button title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); renameChat(c); }}><Icon name="pencil" size={13} /></button>
                <button aria-label={t('chat.delete')} onClick={(e) => { e.stopPropagation(); deleteChat(c); }}><Icon name="trash" size={13} /></button>
              </span>
            </div>
          ))}
        </div>

        <div className="nav-section">
          <div className="nav-section-title">{t('app.projects')}</div>
          {projectsFiltered.map((p) => (
            <div key={p.id}
              className={`nav-item ${activeProjectId === p.id ? 'active' : ''}`}
              onClick={() => { setActiveProject(p.id); navigate('projects'); }}>
              <span className="icon"><Icon name="folder" size={14} /></span>
              <span className="title">{p.name}</span>
              <span className="actions">
                <button title={t('projects.newChatHere')} onClick={(e) => { e.stopPropagation(); createChatUi('New chat', p.id); }}><Icon name="plus" size={13} /></button>
                <button onClick={(e) => { e.stopPropagation(); deleteProject(p); }}><Icon name="trash" size={13} /></button>
              </span>
            </div>
          ))}
        </div>

        <div className="nav-section">
          <div className="nav-section-title">{t('app.story')} / {t('app.chapters')}</div>
          <div className="nav-item" onClick={() => { useData.getState().setActiveProject(activeProjectId); navigate('story'); }}>
            <span className="icon"><Icon name="book" size={14} /></span><span className="title">{t('app.story')}</span>
          </div>
          <div className={`nav-item ${route === 'flow' ? 'active' : ''}`} onClick={() => navigate('flow')}>
            <span className="icon"><Icon name="target" size={14} /></span><span className="title">{t('app.flow')}</span>
          </div>
          <div className="nav-item" onClick={() => navigate('chapters')}>
            <span className="icon"><Icon name="book" size={14} /></span><span className="title">{t('app.chapters')}</span>
          </div>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">{t('app.progress')}</div>
          <div className={`nav-item ${route === 'stats' ? 'active' : ''}`} onClick={() => navigate('stats')}>
            <span className="icon"><Icon name="target" size={14} /></span><span className="title">{t('app.stats')}</span>
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        <div className="row">
          <button onClick={() => navigate('settings')}><Icon name="settings" size={14} /> {t('app.settings')}</button>
          <button onClick={() => useUiOpenPalette()} title={t('app.palette')}>Ctrl+K</button>
        </div>
        <div className="row">
          <button onClick={() => navigate('about')}><Icon name="file" size={14} /> {t('app.about')}</button>
        </div>
      </div>
    </div>
  );
}

function useUiOpenPalette() {
  (window as any).__inkwellOpenPalette?.();
}

function UnreadBadge({ chatId }: { chatId: string }) {
  const count = useUnreadStore((s) => s.unread[chatId] || 0);
  if (!count) return null;
  return <span className="unread-badge" title={count + ' new'}>{count > 9 ? '9+' : count}</span>;
}
