import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useData, useSettings, dbCall, createChatUi, createProjectUi } from '../store';
import { Chat, Folder, Project } from '../types';
import { useT } from '../i18nReact';
import { textPrompt, confirmDialog } from './TextPrompt';
import { Icon, LogoMark } from './Icons';
import { useUnreadStore } from '../unreadStore';

export function Sidebar() {
  const t = useT();
  const settings = useSettings();
  // Narrow subscriptions (Task 11): the sidebar no longer re-renders when a
  // story entry or a chapter is written.
  const chats = useData((s) => s.chats);
  const folders = useData((s) => s.folders);
  const projects = useData((s) => s.projects);
  const activeChatId = useData((s) => s.activeChatId);
  const activeProjectId = useData((s) => s.activeProjectId);
  const route = useData((s) => s.route);
  const setActiveChat = useData((s) => s.setActiveChat);
  const setActiveProject = useData((s) => s.setActiveProject);
  const navigate = useData((s) => s.navigate);
  const [q, setQ] = useState('');
  // Which folder (or the loose "Chats" header, keyed 'loose') is under a
  // dragged chat right now — drives the drop highlight only.
  const [dragOver, setDragOver] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Home is its own place: the chat and project that stay selected for the
  // next visit keep their ids, but they must not compete with Home for the
  // one accent highlight. Only the row of the screen you are on lights up.
  const atHome = route === 'home';
  // Chats belong to a workspace (v1.3.0): Chat sessions stay in Chat, Agent
  // sessions stay in Agent. Writing has no chat list at all.
  // Story Agent belongs to the Agent desk too, so it keeps listing Agent
  // sessions instead of pretending to be another Chat screen.
  const workspace: 'chat' | 'agent' = route === 'agent' || route === 'story-agent' ? 'agent' : 'chat';
  // Writing is a manuscript desk: no chat list, no story-agent or flow tools.
  const writingDesk = route === 'write';
  // Story Agent and Flow are agent-only places (v1.3.0).
  const agentDesk = workspace === 'agent';

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
    await createChatUi('New chat', activeProjectId, workspace);
  }

  async function newProject() {
    const name = await textPrompt({ title: t('projects.name'), confirmLabel: t('projects.create') });
    if (!name) return;
    await createProjectUi(name);
  }

  async function newFolder() {
    const name = await textPrompt({ title: t('folders.new'), confirmLabel: t('folders.create') });
    if (!name) return;
    await dbCall('createFolder', { name, project_id: null, workspace });
    await useData.getState().reloadChatRelated();
  }

  async function renameFolder(f: Folder) {
    const name = await textPrompt({ title: t('folders.rename'), defaultValue: f.name });
    if (!name) return;
    await dbCall('updateFolder', { id: f.id, name });
    await useData.getState().reloadChatRelated();
  }

  /** A chat created from a folder lands inside it and the folder opens so the
   *  new session is visible straight away. */
  async function addChatToFolder(f: Folder) {
    if (Number(f.expanded) !== 1) await dbCall('updateFolder', { id: f.id, expanded: 1 });
    await createChatUi('New chat', f.project_id ?? activeProjectId, workspace, f.id);
    await useData.getState().reloadChatRelated();
  }

  /** Drag a chat into a folder, or onto the Chats header to take it back out. */
  async function moveChatToFolder(chatId: string, folderId: string | null) {
    if (!chatId) return;
    await dbCall('updateChat', { id: chatId, folder_id: folderId });
    if (folderId) await dbCall('updateFolder', { id: folderId, expanded: 1 });
    await useData.getState().reloadChatRelated();
    setDragOver(null);
  }

  /** Rows carry their id so any folder (or the loose list) can accept them. */
  function chatDragProps(c: Chat) {
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData('text/inkwell-chat', c.id);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setDragOver(null)
    };
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

  // Pin/unpin a chat. Pinned chats float to the top of their section
  // (ordering happens in the DB query; the in-list grouping below keeps
  // pinned rows ahead of unpinned ones inside folders and the loose list).
  async function togglePin(c: Chat) {
    const next = !(Number(c.pinned) === 1);
    await dbCall('updateChat', { id: c.id, pinned: next });
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
  // Only the active workspace's sessions are listed, searched and counted.
  const scopedChats = useMemo(
    () => chats.filter((c) => (c.workspace === 'agent' ? 'agent' : 'chat') === workspace),
    [chats, workspace]
  );
  const filtered = useMemo(
    () => (needle ? scopedChats.filter((c) => c.title.toLowerCase().includes(needle)) : scopedChats),
    [scopedChats, needle]
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
    return scopedChats.filter((c) => hitIds.has(c.id) && !titleIds.has(c.id));
  }, [msgHits, filtered, scopedChats]);
  const projectsFiltered = useMemo(
    () => (needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects),
    [projects, needle]
  );
  // Folders are per workspace (v1.3.0): a Chat folder stays out of Agent.
  const foldersWithChats = useMemo(() => {
    return folders
      .filter((f) => (f.workspace === 'agent' ? 'agent' : 'chat') === workspace)
      .map((f) => ({
        folder: f,
        chats: filtered.filter((c) => c.folder_id === f.id)
      }));
  }, [folders, filtered, workspace]);
  const looseChats = filtered.filter((c) => !c.folder_id);
  // Pinned rows first inside each group — the DB already ordered by
  // pinned DESC, so a stable partition is enough.
  const pinFirst = (list: Chat[]) => [...list.filter((c) => Number(c.pinned) === 1), ...list.filter((c) => Number(c.pinned) !== 1)];
  const isPinned = (c: Chat) => Number(c.pinned) === 1;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <LogoMark size={26} />
          <span>Open<span className="ink">Plot</span>&nbsp;AI</span>
          <span className="version">{settings.version ? `v${settings.version}` : ''}</span>
        </div>
        {!writingDesk && (<div className="new-buttons">
          <button className="primary" onClick={newChat}><Icon name="plus" size={14} /> {t('app.newChat')}</button>
          <button onClick={newFolder} title={t('app.newFolder')}><Icon name="folderPlus" size={15} /></button>
        </div>)}
      </div>
      {!writingDesk && (<div className="sidebar-search">
        <Icon name="search" size={14} style={{ position: 'absolute', margin: 8, pointerEvents: 'none', opacity: 0.55 }} />
        <input ref={searchRef} value={q} placeholder={t('app.search')} onChange={(e) => setQ(e.target.value)} aria-label={t('app.search')} />
        {q && (
          <button className="small ghost clear-btn" aria-label="Clear search" onClick={() => { setQ(''); searchRef.current?.focus(); }}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>)}
      <div className="nav-tree">
        <div className="nav-section">
          <div className={`nav-item ${route === 'home' ? 'active' : ''}`} onClick={() => navigate('home')} title={t('app.homeHint')}>
            <span className="icon"><Icon name="quill" size={14} /></span><span className="title">{t('app.home')}</span>
          </div>
        </div>

        {/* Advance workspaces (v1.3.0): each row has its own colour so the three
            places you can work are recognisable at a glance. */}
        <div className="nav-section adv-section">
          <div className="nav-section-title">{t('advance.title')}</div>
          {/* One body for the three places you can work — a single floor, not
              three unrelated rows. */}
          <div className="adv-stack">
          <div className={`nav-item adv adv-chat ${route === 'chat' ? 'active' : ''}`}
            onClick={() => navigate('chat')} title={t('advance.chatHint')}>
            <span className="icon"><Icon name="chat" size={14} /></span><span className="title">{t('advance.chat')}</span>
          </div>
          <div className={`nav-item adv adv-agent ${route === 'agent' ? 'active' : ''}`}
            onClick={() => navigate('agent')} title={t('advance.agentHint')}>
            <span className="icon"><Icon name="tools" size={14} /></span><span className="title">{t('advance.agent')}</span>
          </div>
          <div className={`nav-item adv adv-write ${route === 'write' ? 'active' : ''}`}
            onClick={() => navigate('write')} title={t('advance.writeHint')}>
            <span className="icon"><Icon name="quill" size={14} /></span><span className="title">{t('advance.write')}</span>
          </div>
          </div>
        </div>
        {!writingDesk && (<div className="nav-section folders-section">
          <div className="nav-section-title">
            <span>{t('folders.title')}</span>
            <button
              className="small ghost"
              style={{ marginLeft: 'auto', padding: '0 6px', lineHeight: 1 }}
              title={t('app.newFolder')}
              aria-label={t('app.newFolder')}
              onClick={() => { void newFolder(); }}
            >
              <Icon name="folderPlus" size={12} />
            </button>
          </div>
          {foldersWithChats.map(({ folder, chats: fchats }) => {
            const open = Number(folder.expanded) === 1;
            return (
              <div key={folder.id}>
                {/* Single click opens the folder; the chevron is only a hint.
                    The + makes a chat inside it, and any chat can be dropped on
                    the row to file it here. */}
                <div
                  className={`nav-item folder-row ${dragOver === folder.id ? 'drop-target' : ''}`}
                  onClick={() => { void toggleFolder(folder); }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('text/inkwell-chat')) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDragOver(folder.id);
                  }}
                  onDragLeave={() => setDragOver((v) => (v === folder.id ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    void moveChatToFolder(e.dataTransfer.getData('text/inkwell-chat'), folder.id);
                  }}
                  title={t('folders.hint')}
                >
                  <span className="icon"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /></span>
                  <span className="title">{folder.name}</span>
                  <span className="folder-count">{fchats.length}</span>
                  <span className="actions">
                    <button title={t('folders.newChat')} aria-label={t('folders.newChat')} onClick={(e) => { e.stopPropagation(); void addChatToFolder(folder); }}><Icon name="plus" size={13} /></button>
                    <button title={t('folders.rename')} aria-label={t('folders.rename')} onClick={(e) => { e.stopPropagation(); void renameFolder(folder); }}><Icon name="pencil" size={13} /></button>
                    <button aria-label={t('confirm.deleteFolder')} onClick={(e) => { e.stopPropagation(); void deleteFolder(folder); }}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
                {open && fchats.length === 0 && <div className="folder-empty">{t('folders.drop')}</div>}
                {open && pinFirst(fchats).map((c) => (
                  <div key={c.id} className={`nav-item folder-chat ${!atHome && c.id === activeChatId ? 'active' : ''}`}
                    {...chatDragProps(c)}
                    onClick={() => { setActiveChat(c.id); navigate(workspace); }}>
                    <span className="icon"><Icon name={isPinned(c) ? 'pin' : 'chat'} size={14} /></span>
                    <span className="title">{c.title}</span>
                    <UnreadBadge chatId={c.id} />
                    <span className="actions">
                      <button title={isPinned(c) ? t('chat.unpin') : t('chat.pin')} aria-label={isPinned(c) ? t('chat.unpin') : t('chat.pin')} onClick={(e) => { e.stopPropagation(); togglePin(c); }}><Icon name="pin" size={13} /></button>
                      <button title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); renameChat(c); }}><Icon name="pencil" size={13} /></button>
                      <button aria-label={t('chat.delete')} onClick={(e) => { e.stopPropagation(); deleteChat(c); }}><Icon name="trash" size={13} /></button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          {!foldersWithChats.length && <div className="nav-hint">{t('folders.empty')}</div>}
        </div>)}

        {!writingDesk && (<div className="nav-section">
          {/* Dropping a chat on the Chats header takes it out of its folder. */}
          <div
            className={`nav-section-title chats-title ${dragOver === 'loose' ? 'over' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('text/inkwell-chat')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOver('loose');
            }}
            onDragLeave={() => setDragOver((v) => (v === 'loose' ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              void moveChatToFolder(e.dataTransfer.getData('text/inkwell-chat'), null);
            }}
            title={t('chats.unfile')}
          >
            <span>{t('app.chats')}</span>
            <span className="drop-hint">{t('chats.unfile')}</span>
          </div>
          {contentOnlyChats.map((c) => (
            <div key={c.id} className={`nav-item ${!atHome && c.id === activeChatId ? 'active' : ''}`}
              {...chatDragProps(c)}
              onClick={() => { setActiveChat(c.id); navigate(workspace); }}>
              <span className="icon"><Icon name="search" size={14} /></span>
              <span className="title">{c.title}</span>
              <UnreadBadge chatId={c.id} />
              <span className="match-count" title={t('app.msgMatches').replace('{n}', String(msgHits.filter((h) => h.chat_id === c.id).reduce((a, h) => a + h.matches, 0)))}>
                {msgHits.find((h) => h.chat_id === c.id)?.matches}
              </span>
              <span className="actions">
                <button title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); renameChat(c); }}><Icon name="pencil" size={13} /></button>
                <button aria-label={t('chat.delete')} onClick={(e) => { e.stopPropagation(); deleteChat(c); }}><Icon name="trash" size={13} /></button>
              </span>
            </div>
          ))}
          {msgHits.length > 0 && (
            <div className="nav-hint">{t('app.msgMatches').replace('{n}', String(msgHits.reduce((a, h) => a + h.matches, 0)))}</div>
          )}
          {pinFirst(looseChats).map((c) => (
            <div key={c.id} className={`nav-item ${!atHome && c.id === activeChatId ? 'active' : ''} ${isPinned(c) ? 'pinned' : ''}`}
              {...chatDragProps(c)}
              onClick={() => { setActiveChat(c.id); navigate(workspace); }}>
              <span className="icon"><Icon name={isPinned(c) ? 'pin' : 'chat'} size={14} /></span>
              <span className="title">{c.title}</span>
              <UnreadBadge chatId={c.id} />
              <span className="actions">
                <button className={isPinned(c) ? 'pinned' : ''} title={isPinned(c) ? t('chat.unpin') : t('chat.pin')} aria-label={isPinned(c) ? t('chat.unpin') : t('chat.pin')} onClick={(e) => { e.stopPropagation(); togglePin(c); }}><Icon name="pin" size={13} /></button>
                <button title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); renameChat(c); }}><Icon name="pencil" size={13} /></button>
                <button aria-label={t('chat.delete')} onClick={(e) => { e.stopPropagation(); deleteChat(c); }}><Icon name="trash" size={13} /></button>
              </span>
            </div>
          ))}
        </div>)}

        <div className="nav-section">
          <div className="nav-section-title">
            <span>{t('app.projects')}</span>
            <button
              className="small ghost"
              style={{ marginLeft: 'auto', padding: '0 6px', lineHeight: 1 }}
              title={t('app.newProject')}
              aria-label={t('app.newProject')}
              onClick={newProject}
            >
              <Icon name="plus" size={12} />
            </button>
          </div>
          {projectsFiltered.map((p) => (
            <div key={p.id}
              className={`nav-item ${!atHome && activeProjectId === p.id ? 'active' : ''}`}
              onClick={() => { setActiveProject(p.id); navigate('projects'); }}>
              <span className="icon"><Icon name="project" size={14} /></span>
              <span className="title">{p.name}</span>
              <span className="actions">
                <button title={t('projects.newChatHere')} onClick={(e) => { e.stopPropagation(); createChatUi('New chat', p.id, workspace); }}><Icon name="plus" size={13} /></button>
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
          <div className={`nav-item ${route === 'chapters' ? 'active' : ''}`} onClick={() => navigate('chapters')}>
            <span className="icon"><Icon name="book" size={14} /></span><span className="title">{t('app.chapters')}</span>
          </div>
          <div className={`nav-item ${route === 'dump' ? 'active' : ''}`} onClick={() => navigate('dump')} title={t('dump.sub')}>
            <span className="icon"><Icon name="trash" size={14} /></span><span className="title">{t('dump.title')}</span>
          </div>
        </div>

        {agentDesk && (
        <div className="nav-section">
          <div className="nav-section-title">{t('app.agent')}</div>
          <div className={`nav-item ${route === 'story-agent' ? 'active' : ''}`} onClick={() => navigate('story-agent')}>
            <span className="icon"><Icon name="sparkle" size={14} /></span><span className="title">{t('agent.title')}</span>
          </div>
        </div>
        )}

        {agentDesk && (
        <div className="nav-section">
          <div className="nav-section-title">{t('app.flow')}</div>
          <div className={`nav-item ${route === 'flow' ? 'active' : ''}`} onClick={() => navigate('flow')}>
            <span className="icon"><Icon name="target" size={14} /></span><span className="title">{t('flow.title')}</span>
          </div>
        </div>
        )}

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
          <button onClick={() => navigate('guide')}><Icon name="book" size={14} /> {t('guide.title')}</button>
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
