import { useEffect, useMemo, useState } from 'react';
import { useData, dbCall } from '../store';
import { StoryEntry, StoryKind } from '../types';
import { useT } from '../i18nReact';
import { STORY_TEMPLATES, renderTemplate } from '../storyTemplates';
import { Icon, IconName } from './Icons';
import { confirmDialog } from './TextPrompt';

const KINDS: StoryKind[] = ['world', 'location', 'character', 'item', 'lore'];
const KIND_ICON: Record<StoryKind, IconName> = { world: 'globe', location: 'pin', character: 'person', item: 'sword', lore: 'scroll' };

const wordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [val, setVal] = useState('');
  return (
    <div className="tag-input-wrap">
      {tags.map((tg) => (
        <span key={tg} className="tag-chip">
          {tg}
          <button onClick={() => onChange(tags.filter((x) => x !== tg))}>×</button>
        </span>
      ))}
      <input
        value={val}
        placeholder="add tag…"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && val.trim()) {
            onChange([...tags, val.trim()]);
            setVal('');
          }
        }}
      />
    </div>
  );
}

function safeJson(raw: string | null | undefined, fb: any = []): any {
  try { const v = JSON.parse(raw || '[]'); return v ?? fb; } catch { return fb; }
}

export function StoryBibleView() {
  const t = useT();
  const { story, activeProjectId, projects } = useData();
  const [kind, setKind] = useState<StoryKind>('world');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; tags: string[]; links: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);

  const scoped = useMemo(
    () => story.filter((e) => !activeProjectId || e.project_id === activeProjectId),
    [story, activeProjectId]
  );
  // Search spans title, content and tags of the active kind.
  const q = query.trim().toLowerCase();
  const list = scoped
    .filter((e) => e.kind === kind)
    .filter(
      (e) =>
        !q ||
        e.title.toLowerCase().includes(q) ||
        String(e.content).toLowerCase().includes(q) ||
        safeJson(e.tags).some((tg: any) => String(tg).toLowerCase().includes(q))
    );
  const selected = story.find((e) => e.id === selectedId) || null;
  const project = projects.find((p) => p.id === activeProjectId) || null;

  useEffect(() => {
    if (selected) {
      setDraft({
        title: selected.title,
        content: selected.content,
        tags: safeJson(selected.tags),
        links: safeJson((selected as any).links)
      });
      setDirty(false);
    } else {
      setDraft(null);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function selectEntry(id: string | null) {
    if (dirty && !(await confirmDialog({ title: t('confirm.discard'), danger: true, confirmLabel: t('confirm.discardChanges'), cancelLabel: t('confirm.keepEditing') }))) return;
    setSelectedId(id);
  }

  async function switchKind(k: StoryKind) {
    if (dirty && !(await confirmDialog({ title: t('confirm.discard'), danger: true, confirmLabel: t('confirm.discardChanges'), cancelLabel: t('confirm.keepEditing') }))) return;
    setKind(k);
  }

  async function createEntry(k: StoryKind = kind) {
    let projectId = activeProjectId;
    if (!projectId) {
      const p = await dbCall<any>('createProject', { name: 'Untitled project' });
      await useData.getState().load();
      projectId = p.id;
      useData.getState().setActiveProject(p.id);
    }
    const count = scoped.filter((e) => e.kind === k).length + 1;
    const row = await dbCall<StoryEntry>('createStory', {
      projectId,
      kind: k,
      title: 'New ' + k + ' ' + count,
      content: renderTemplate(k, {}),
      tags: [],
      links: []
    });
    await useData.getState().load();
    setKind(k);
    setSelectedId(row.id);
  }

  async function save() {
    if (!selected || !draft) return;
    if (!draft.title.trim()) return;
    await dbCall('updateStory', { id: selected.id, title: draft.title.trim(), content: draft.content, tags: draft.tags, links: draft.links });
    await useData.getState().load();
    setDirty(false);
  }

  async function remove() {
    if (!selected || !(await confirmDialog({ title: t('confirm.deleteEntry'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteStory', { id: selected.id });
    setSelectedId(null);
    await useData.getState().load();
  }

  function askAi() {
    if (!selected || !draft) return;
    (window as any).__inkwellPendingPrompt = `Here is my story entry "${draft.title}" (${selected.kind}):\n\n${draft.content}\n\nPlease review it, then use your story tools to improve or expand the entry if you find gaps.`;
    useData.getState().navigate('chat');
    window.dispatchEvent(new CustomEvent('inkwell:pending-prompt'));
  }

  const linkedEntries = (draft?.links || [])
    .map((id) => story.find((e) => e.id === id))
    .filter(Boolean) as StoryEntry[];
  const linkable = story.filter((e) => e.id !== selectedId && !(draft?.links || []).includes(e.id));

  return (
    <div className="page">
      <h1>{KIND_ICON[kind]} {t('story.title')}</h1>
      <div className="subtitle">
        {t('story.sub')}
        {project ? <> — <b>{project.name}</b></> : <> — <i>no project selected</i></>}
      </div>
      <div className="story-grid">
        <div className="story-list">
          <div className="kind-tabs">
            {KINDS.map((k) => (
              <button key={k} className={k === kind ? 'active' : ''} onClick={() => switchKind(k)}>
                {KIND_ICON[k]} {t('story.' + k)}
                <span className="count">{scoped.filter((e) => e.kind === k).length}</span>
              </button>
            ))}
          </div>
          <div style={{ padding: '0 8px 8px' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('story.search')}
              aria-label={t('story.search')}
            />
          </div>
          <div style={{ padding: 8, display: 'flex', gap: 6 }}>
            <button className="primary" style={{ flex: 1 }} onClick={() => createEntry(kind)}><Icon name="plus" size={14} /> {t('story.new')}</button>
          </div>
          {list.length === 0 && <div className="empty-state" style={{ padding: 20 }}><span>{q ? t('story.searchEmpty') : t('story.nothing')}</span></div>}
          {list.map((e) => (
            <div key={e.id} className={`story-item ${e.id === selectedId ? 'active' : ''}`} onClick={() => selectEntry(e.id)}>
              <div className="t">{e.title}</div>
              <div className="k">
                {t('story.' + e.kind)}
                <span className="wc"> · {wordCount(e.content).toLocaleString()}w</span>
              </div>
            </div>
          ))}
        </div>
        <div className="story-editor">
          {!selected || !draft ? (
            <div className="empty-state" style={{ height: '100%' }}>
              <div className="big"><Icon name="book" size={28} /></div>
              <div>{t('story.nothing')}</div>
              <div className="grid-3" style={{ width: '100%', maxWidth: 620, marginTop: 12 }}>
                {KINDS.map((k) => (
                  <div key={k} className="welcome-card" onClick={() => createEntry(k)}>
                    <div className="ic">{KIND_ICON[k]}</div>
                    <div className="t">{t('story.' + k)}</div>
                    <div className="d">{STORY_TEMPLATES[k] ? 'Structured template included' : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="head">
                <input value={draft.title} onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setDirty(true); }} placeholder={t('story.titleField')} />
                <button className="primary" onClick={save} disabled={!dirty}><Icon name="check" size={14} /> {t('story.save')}</button>
                <button className="danger" onClick={remove}><Icon name="trash" size={14} /></button>
              </div>
              <TagInput tags={draft.tags} onChange={(tags) => { setDraft({ ...draft, tags }); setDirty(true); }} />
              <textarea
                value={draft.content}
                onChange={(e) => { setDraft({ ...draft, content: e.target.value }); setDirty(true); }}
                placeholder={t('story.content') + '…'}
              />
              <div className="card" style={{ margin: 0, padding: 12 }}>
                <label style={{ marginBottom: 6 }}>🔗 {t('story.related')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {linkedEntries.map((e) => (
                    <span key={e.id} className="tag-chip" style={{ cursor: 'pointer' }} onClick={() => selectEntry(e.id)}>
                      <Icon name={KIND_ICON[e.kind] || 'file'} size={13} /> {e.title}
                      <button onClick={(ev) => { ev.stopPropagation(); setDraft({ ...draft, links: draft.links.filter((x) => x !== e.id) }); setDirty(true); }}>×</button>
                    </span>
                  ))}
                  {linkedEntries.length === 0 && <span className="hint">{t('story.relatedHint')}</span>}
                </div>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) { setDraft({ ...draft, links: [...draft.links, e.target.value] }); setDirty(true); }
                  }}
                >
                  <option value="">{t('story.linkAdd')}</option>
                  {linkable.map((e) => (
                    <option key={e.id} value={e.id}>[{t('story.' + e.kind)}] {e.title}</option>
                  ))}
                </select>
              </div>
              <div className="row" style={{ gap: 10 }}>
                <button className="ghost" onClick={askAi}>✨ {t('story.askAi')}</button>
                <span className="hint" style={{ flex: 1 }}>{t('story.aiHint')}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
