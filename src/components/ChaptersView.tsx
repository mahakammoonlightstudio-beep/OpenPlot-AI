import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, dbCall, useUi } from '../store';
import { useWriteStats } from '../writeStats';
import { Chapter } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Modal } from './Ui';
import { confirmDialog } from './TextPrompt';

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

interface ChapterVersionRow { id: string; chapter_id: string; title: string; content: string; word_count: number; source: string; created_at: number }

function fmtVersionDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface SceneRow { id: string; chapter_id: string; title: string; summary: string; position: number }

function SceneBoard({ chapterId }: { chapterId: string }) {
  const t = useT();
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  async function reload() {
    try { setScenes(await dbCall<SceneRow[]>('listScenes', { chapterId })); } catch { /* chapter gone */ }
  }

  useEffect(() => {
    setScenes([]);
    setOpenId(null);
    reload();
  }, [chapterId]);

  async function add() {
    const row = await dbCall<SceneRow>('createScene', { chapterId, title: `${t('chapters.scene')} ${scenes.length + 1}` });
    await reload();
    setOpenId(row.id);
  }

  async function patch(id: string, fields: any) {
    await dbCall('updateScene', { id, ...fields });
    await reload();
  }

  async function remove(id: string) {
    await dbCall('deleteScene', { id });
    await reload();
  }

  return (
    <div className="card" style={{ margin: 0, padding: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <label style={{ margin: 0, flex: 1 }}>🎬 {t('chapters.scenes')}</label>
        <button className="small" onClick={add}><Icon name="plus" size={13} /> {t('chapters.scene')}</button>
      </div>
      {scenes.length === 0 && <div className="hint">{t('chapters.scenesHint')}</div>}
      {scenes.map((sc, i) => (
        <div key={sc.id} className="scene-card">
          <div className="scene-head" onClick={() => setOpenId(openId === sc.id ? null : sc.id)}>
            <span className="scene-idx">{i + 1}</span>
            <span style={{ flex: 1 }}>{sc.title}</span>
            <button className="small ghost" onClick={(e) => { e.stopPropagation(); remove(sc.id); }}><Icon name="trash" size={13} /></button>
          </div>
          {openId === sc.id && (
            <div className="scene-body">
              <input
                value={sc.title}
                onChange={(e) => setScenes((ss) => ss.map((x) => (x.id === sc.id ? { ...x, title: e.target.value } : x)))}
                onBlur={(e) => patch(sc.id, { title: e.target.value })}
              />
              <textarea
                rows={3}
                value={sc.summary}
                placeholder={t('chapters.sceneSummary')}
                onChange={(e) => setScenes((ss) => ss.map((x) => (x.id === sc.id ? { ...x, summary: e.target.value } : x)))}
                onBlur={(e) => patch(sc.id, { summary: e.target.value })}
              />
              <div className="hint">
                {wordCount(sc.summary)} {t('chapters.words')} · {sc.summary.length} chars
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ChaptersView() {
  const t = useT();
  const ui = useUi();
  const { chapters, activeProjectId, projects } = useData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; status: Chapter['status'] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showScenes, setShowScenes] = useState(true);
  const [baselineWords, setBaselineWords] = useState<number | null>(null);
  // Focus mode: distraction-free writing — hides list, scenes and header chrome.
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocus(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);

  // Ctrl/Cmd+S saves the chapter — the reflex writers already have.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scoped = useMemo(
    () => chapters.filter((c) => !activeProjectId || c.project_id === activeProjectId).sort((a, b) => a.position - b.position),
    [chapters, activeProjectId]
  );
  const selected = scoped.find((c) => c.id === selectedId) || null;
  const project = projects.find((p) => p.id === activeProjectId) || null;

  useEffect(() => {
    if (selected) {
      setDraft({ title: selected.title, content: selected.content, status: selected.status });
      setBaselineWords(wordCount(selected.content));
      setDirty(false);
    } else {
      setDraft(null);
      setBaselineWords(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function selectChapter(id: string | null) {
    if (dirty && !(await confirmDiscard())) return;
    setSelectedId(id);
  }

  async function confirmDiscard(): Promise<boolean> {
    // In-app dialog — native confirm() steals keyboard focus in Electron.
    return confirmDialog({ title: t('confirm.discard'), danger: true, confirmLabel: t('confirm.discardChanges'), cancelLabel: t('confirm.keepEditing') });
  }

  async function create() {
    let projectId = activeProjectId;
    if (!projectId) {
      const p = await dbCall<any>('createProject', { name: 'Untitled project' });
      await useData.getState().load();
      useData.getState().setActiveProject(p.id);
      projectId = p.id;
    }
    const row = await dbCall<Chapter>('createChapter', { projectId, title: 'Chapter ' + (scoped.length + 1), content: '', status: 'draft' });
    await useData.getState().load();
    setSelectedId(row.id);
  }

  async function save() {
    if (!selected || !draft) return;
    const before = wordCount(selected.content);
    const after = wordCount(draft.content);
    // Snapshot only when the text actually changed (title/status-only saves
    // would flood the history with noise).
    if (after !== before || draft.content !== selected.content) {
      try {
        await dbCall('createChapterVersion', { chapterId: selected.id, title: selected.title, content: selected.content, source: 'manual' });
      } catch { /* versioning is best-effort — never block a save */ }
    }
    await dbCall('updateChapter', { id: selected.id, title: draft.title, content: draft.content, status: draft.status });
    // Record writing stats delta for this project (local, no AI involved).
    // Reload FIRST so the total reflects the row just saved (the stale
    // snapshot used to under/overwrite the stored project total).
    await useData.getState().load();
    if (selected.project_id) {
      const project = useData.getState().projects.find((p) => p.id === selected.project_id);
      const total = useData
        .getState()
        .chapters.filter((c) => c.project_id === selected.project_id)
        .reduce((a, c) => a + wordCount(c.content), 0);
      useWriteStats.getState().recordDelta(selected.project_id, project?.name || '', after - before, total);
    }
    setDirty(false);
  }

  async function remove() {
    if (!selected) return;
    if (!(await confirmDialog({ title: t('confirm.deleteChapter'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteChapter', { id: selected.id });
    setSelectedId(null);
    await useData.getState().load();
  }

  // Move a chapter up/down in reading order and persist the new positions.
  // Only the ids of THIS project are sent — other projects are untouched.
  async function moveChapter(id: string, dir: -1 | 1) {
    const order = scoped.map((c) => c.id);
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await dbCall('reorderChapters', { order });
    await useData.getState().load();
  }

  function toggleFocus() {
    setFocus((f) => !f);
    setLastFocusWords(wordCount(draft?.content || ''));
  }
  const [lastFocusWords, setLastFocusWords] = useState(0);

  // ---- version history ----
  const [histOpen, setHistOpen] = useState(false);
  const [versions, setVersions] = useState<ChapterVersionRow[]>([]);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);  async function openHistory() {
    if (!selected) return;
    // Unsaved edits first — so what's in the editor is what history restores
    // past, and the snapshot it creates is the current state.
    if (dirty) await save();
    setVersions(await dbCall<ChapterVersionRow[]>('listChapterVersions', { chapterId: selected.id }));
    setHistOpen(true);
  }

  async function restoreVersion(v: ChapterVersionRow) {
    if (!selected || busyVersion) return;
    setBusyVersion(v.id);
    try {
      // Safety net: the CURRENT text is snapshotted first, so a restore can
      // always be undone by restoring the snapshot it just created.
      await dbCall('createChapterVersion', { chapterId: selected.id, title: selected.title, content: selected.content, source: 'restore' });
      await dbCall('updateChapter', { id: selected.id, content: v.content, title: selected.title, status: selected.status });
      await useData.getState().load();
      // Sync the editor draft directly — setSelectedId(selected.id) would be a
      // no-op (same value → effect never re-runs → stale draft).
      const fresh = useData.getState().chapters.find((c) => c.id === selected.id);
      setDraft({ title: fresh?.title || selected.title, content: fresh?.content || v.content, status: (fresh?.status || selected.status) as Chapter['status'] });
      setBaselineWords(wordCount(fresh?.content || v.content));
      setDirty(false);
      setHistOpen(false);
      ui.toast(t('chapters.restored'), 'ok');
    } finally {
      setBusyVersion(null);
    }
  }

  async function deleteVersion(v: ChapterVersionRow) {
    if (busyVersion) return;
    setBusyVersion(v.id);
    try {
      await dbCall('deleteChapterVersion', { id: v.id });
      setVersions((vs) => vs.filter((x) => x.id !== v.id));
    } finally {
      setBusyVersion(null);
    }
  }

  async function aiAction(mode: 'continue' | 'critique' | 'beat') {
    if (!selected || !draft) return;
    await save();
    let prompt: string;
    if (mode === 'continue') {
      prompt = `Continue writing this chapter naturally from where it stops. Return ONLY the continuation prose, no commentary.\n\nChapter title: ${draft.title}\n\n${draft.content}`;
    } else if (mode === 'critique') {
      prompt = `Critique this chapter: pacing, character voice, stakes, prose quality. Be specific and constructive.\n\nChapter title: ${draft.title}\n\n${draft.content}`;
    } else {
      prompt = `Break this chapter into a scene-by-scene beat outline (5-9 beats). For each beat give a one-line summary and the emotional turn. Use your story tools to check consistency with my story bible if needed.\n\nChapter title: ${draft.title}\n\n${draft.content.slice(0, 4000)}`;
    }
    (window as any).__inkwellPendingPrompt = prompt;
    useData.getState().navigate('chat');
    window.dispatchEvent(new CustomEvent('inkwell:pending-prompt'));
  }

  const totalProjectWords = scoped.reduce((acc, c) => acc + wordCount(c.content), 0);
  const sessionDelta = baselineWords === null ? 0 : wordCount(draft?.content || '') - baselineWords;
  const doneCount = scoped.filter((c) => c.status === 'done').length;

  // Focus mode overlay: just the title and the text, Escape exits.
  if (focus && selected && draft) {
    const focusDelta = wordCount(draft.content) - lastFocusWords;
    return (
      <div className="focus-mode">
        <div className="focus-top">
          <input className="focus-title" value={draft.title} onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setDirty(true); }} aria-label={t('chapters.title')} />
          <span className="editor-stats">
            {wordCount(draft.content).toLocaleString()} {t('chapters.words')}
            {focusDelta > 0 && <b style={{ color: 'var(--ok)' }}> +{focusDelta}</b>}
          </span>
          <button className="small" onClick={save} disabled={!dirty}><Icon name="check" size={13} /> {t('chapters.save')}</button>
          <button className="small ghost" onClick={toggleFocus} title="Escape"><Icon name="x" size={14} /> {t('chapters.focusExit')}</button>
        </div>
        <textarea
          className="focus-editor"
          value={draft.content}
          onChange={(e) => { setDraft({ ...draft, content: e.target.value }); setDirty(true); }}
          placeholder="Once upon a time…"
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="page">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="book" size={18} /> {t('chapters.title')}</h1>
      <div className="subtitle">
        {t('chapters.sub')}
        {project ? <> — <b>{project.name}</b></> : <> — <i>no project selected</i></>}
        {' · '}{scoped.length} {t('chapters.title').toLowerCase()} · {doneCount} {t('chapters.done').toLowerCase()} · {totalProjectWords.toLocaleString()} {t('chapters.words')}
      </div>
      <div className="chapters-layout">
        <div className="chapter-list">
          <div style={{ padding: 8 }}>
            <button className="primary" style={{ width: '100%' }} onClick={create}><Icon name="plus" size={14} /> {t('chapters.new')}</button>
          </div>
          {scoped.length === 0 && <div className="empty-state" style={{ padding: 20 }}><span>{t('chapters.nothing')}</span></div>}
          {scoped.map((c, i) => (
            <div
              key={c.id}
              className={`chapter-item ${c.id === selectedId ? 'active' : ''}`}
              onClick={() => selectChapter(c.id)}
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData('application/x-openplot-chapter', JSON.stringify({ id: c.id }));
                ev.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span className="t">{c.title}</span>
              <span className="badge">{wordCount(c.content).toLocaleString()}w</span>
              <span className={`badge ${c.status}`}>{t('chapters.' + c.status)}</span>
              <span className="reorder" onClick={(e) => e.stopPropagation()}>
                <button
                  className="small ghost"
                  title={t('chapters.moveUp')}
                  aria-label={t('chapters.moveUp')}
                  disabled={i === 0}
                  onClick={() => moveChapter(c.id, -1)}
                >
                  <Icon name="chevronUp" size={12} />
                </button>
                <button
                  className="small ghost"
                  title={t('chapters.moveDown')}
                  aria-label={t('chapters.moveDown')}
                  disabled={i === scoped.length - 1}
                  onClick={() => moveChapter(c.id, 1)}
                >
                  <Icon name="chevronDown" size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
        <div className="chapter-editor">
          {!selected || !draft ? (
            <div className="empty-state" style={{ height: '100%' }}>
              <div className="big"><Icon name="book" size={28} /></div>
              <div>{t('chapters.nothing')}</div>
            </div>
          ) : (
            <>
              <div className="head">
                <input value={draft.title} onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setDirty(true); }} />
                <select value={draft.status} onChange={(e) => { setDraft({ ...draft, status: e.target.value as Chapter['status'] }); setDirty(true); }}>
                  <option value="draft">{t('chapters.draft')}</option>
                  <option value="revising">{t('chapters.revising')}</option>
                  <option value="done">{t('chapters.done')}</option>
                </select>
                <button className="primary" onClick={save} disabled={!dirty}><Icon name="check" size={14} /> {t('chapters.save')}</button>
                <button className="ghost" onClick={openHistory} title={t('chapters.historyHint')}><Icon name="clock" size={14} /> {t('chapters.history')}</button>
                <button className="ghost" onClick={toggleFocus} title={t('chapters.focusHint')}><Icon name="file" size={14} /> {t('chapters.focus')}</button>
                <button className="danger" onClick={remove} aria-label={t('chapters.delete')}><Icon name="trash" size={14} /></button>
              </div>
              <textarea
                value={draft.content}
                onChange={(e) => { setDraft({ ...draft, content: e.target.value }); setDirty(true); }}
                placeholder="Once upon a time…"
                style={{ flex: showScenes ? '0 0 auto' : 1, minHeight: showScenes ? 200 : 300 }}
              />
              {showScenes && <SceneBoard chapterId={selected.id} />}
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <button className="ghost" onClick={() => aiAction('continue')}><Icon name="quill" size={14} /> {t('chapters.extend')}</button>
                <button className="ghost" onClick={() => aiAction('critique')}><Icon name="search" size={14} /> {t('chapters.critique')}</button>
                <button className="ghost" onClick={() => aiAction('beat')}><Icon name="scroll" size={14} /> {t('chapters.beats')}</button>
                <button className="ghost" onClick={() => setShowScenes(!showScenes)}><Icon name="book" size={14} /> {t('chapters.toggleScenes')}</button>
                <span className="editor-stats" style={{ marginLeft: 'auto' }}>
                  {wordCount(draft.content).toLocaleString()} {t('chapters.words')} · {draft.content.length.toLocaleString()} chars
                  {sessionDelta !== 0 && <b style={{ color: sessionDelta > 0 ? 'var(--ok)' : 'var(--danger)' }}> ({sessionDelta > 0 ? '+' : ''}{sessionDelta} {t('chapters.session')})</b>}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      {histOpen && (
        <Modal title={`${t('chapters.history')}: ${selected?.title || ''}`} onClose={() => setHistOpen(false)} width={640}>
          <div className="hint" style={{ marginBottom: 10 }}>{t('chapters.historyHint')}</div>
          {versions.length === 0 && <div className="hint">{t('chapters.versionsEmpty')}</div>}
          <div className="version-list">
            {versions.map((v) => (
              <div key={v.id} className="version-row">
                <span className="v-date">{fmtVersionDate(v.created_at)}</span>
                <span className={`v-src ${v.source}`}>{t('chapters.src.' + v.source)}</span>
                <span className="v-wc">{v.word_count.toLocaleString()}w</span>
                <span className="v-actions">
                  <button className="small" disabled={busyVersion !== null} onClick={() => restoreVersion(v)}>
                    <Icon name="refresh" size={12} /> {t('chapters.restore')}
                  </button>
                  <button className="small ghost" title={t('story.delete')} disabled={busyVersion !== null} onClick={() => deleteVersion(v)}>
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
