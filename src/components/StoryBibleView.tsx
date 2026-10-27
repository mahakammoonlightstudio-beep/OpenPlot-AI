import { useEffect, useMemo, useState } from 'react';
import { useData, useUi, dbCall, createProjectUi } from '../store';
import { StoryEntry, StoryFile, StoryKind } from '../types';
import { useT } from '../i18nReact';
import { STORY_TEMPLATES, renderTemplate } from '../storyTemplates';
import { Icon, IconName } from './Icons';
import { confirmDialog } from './TextPrompt';
import { Modal } from './Ui';
import { ParsedEntry, formatBytes, guessKindFromName, parseStoryFiles } from '../lib/storyImport';
import { toStoryArray } from '../lib/storyData';

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

export function StoryBibleView() {
  const t = useT();
  const ui = useUi();
  const { story, activeProjectId, projects } = useData();
  const [kind, setKind] = useState<StoryKind>('world');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; tags: string[]; links: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);

  // ---- v1.2: attached reference files ----
  const [files, setFiles] = useState<StoryFile[]>([]);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [attaching, setAttaching] = useState(false);
  // ---- v1.2: bulk import ----
  const [importFiles, setImportFiles] = useState<{ name: string; content: string }[] | null>(null);
  const [importKind, setImportKind] = useState<StoryKind>('lore');
  const [importing, setImporting] = useState(false);

  const scoped = useMemo(
    () => story.filter((e) => !activeProjectId || e.project_id === activeProjectId),
    [story, activeProjectId]
  );
  const project = projects.find((p) => p.id === activeProjectId) || null;

  const refreshFiles = async () => {
    if (!activeProjectId) { setFiles([]); return; }
    try {
      const rows = await dbCall<StoryFile[]>('listStoryFiles', { projectId: activeProjectId });
      setFiles(rows || []);
    } catch { setFiles([]); }
  };

  useEffect(() => {
    let cancelled = false;
    if (!activeProjectId) { setFiles([]); return; }
    dbCall<StoryFile[]>('listStoryFiles', { projectId: activeProjectId })
      .then((rows) => { if (!cancelled) setFiles(rows || []); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  const filesByEntry = useMemo(() => {
    const map = new Map<string, StoryFile[]>();
    for (const f of files) {
      if (!f.story_id) continue;
      const arr = map.get(f.story_id) || [];
      arr.push(f);
      map.set(f.story_id, arr);
    }
    return map;
  }, [files]);

  // Search spans title, content, tags AND attached file names.
  const q = query.trim().toLowerCase();
  const list = scoped
    .filter((e) => e.kind === kind)
    .filter((e) => {
      if (!q) return true;
      const names = (filesByEntry.get(e.id) || []).map((f) => f.name.toLowerCase());
      return (
        e.title.toLowerCase().includes(q) ||
        String(e.content).toLowerCase().includes(q) ||
        toStoryArray(e.tags).some((tg) => tg.toLowerCase().includes(q)) ||
        names.some((n) => n.includes(q))
      );
    });
  const selected = story.find((e) => e.id === selectedId) || null;
  const entryFiles = selectedId ? (filesByEntry.get(selectedId) || []) : [];

  useEffect(() => {
    if (selected) {
      setDraft({
        title: selected.title,
        content: selected.content,
        tags: toStoryArray(selected.tags),
        links: toStoryArray(selected.links)
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

  async function ensureProject(): Promise<string> {
    if (activeProjectId) return activeProjectId;
    const p = await createProjectUi('Untitled project');
    return p.id as string;
  }

  async function createEntry(k: StoryKind = kind) {
    const projectId = await ensureProject();
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
    try {
      await dbCall('updateStory', { id: selected.id, title: draft.title.trim(), content: draft.content, tags: draft.tags, links: draft.links });
      await useData.getState().load();
      setDirty(false);
      ui.toast(t('story.saved'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || 'Save failed', 'error');
    }
  }

  async function remove() {
    if (!selected || !(await confirmDialog({ title: t('confirm.deleteEntry'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteStory', { id: selected.id });
    setSelectedId(null);
    await useData.getState().load();
    await refreshFiles();
  }

  function askAi() {
    if (!selected || !draft) return;
    const attached = entryFiles.length ? `\n\nAttached reference files: ${entryFiles.map((f) => f.name).join(', ')} (use read_story_file to read them).` : '';
    (window as any).__inkwellPendingPrompt = `Here is my story entry "${draft.title}" (${selected.kind}):\n\n${draft.content}${attached}\n\nPlease review it, then use your story tools to improve or expand the entry if you find gaps.`;
    useData.getState().navigate('chat');
    window.dispatchEvent(new CustomEvent('inkwell:pending-prompt'));
  }

  // ---------------------------------------------------------- attachments --

  async function attachContents(rows: { name: string; content: string }[]) {
    if (!selected) { ui.toast(t('story.selectFirst'), 'error'); return; }
    if (!rows.length) { ui.toast(t('story.attachEmpty'), 'error'); return; }
    setAttaching(true);
    let ok = 0;
    let lastError = '';
    for (const row of rows) {
      try {
        await dbCall('attachStoryFile', {
          projectId: selected.project_id,
          storyId: selected.id,
          name: row.name,
          content: row.content
        });
        ok++;
      } catch (e: any) { lastError = e?.message || String(e); }
    }
    setAttaching(false);
    await refreshFiles();
    if (ok) ui.toast(t('story.attachDone').replace('{n}', String(ok)), 'ok');
    if (lastError) ui.toast(lastError, 'error');
  }

  async function attachPaths(paths: string[]) {
    if (!paths.length) return;
    const rows = await window.inkwell.readFiles(paths, 2_000_000);
    if (!rows.length) { ui.toast(t('story.attachTooBig'), 'error'); return; }
    await attachContents(rows);
  }

  async function pickAttach() {
    if (!selected) { ui.toast(t('story.selectFirst'), 'error'); return; }
    const paths = await window.inkwell.pickFiles();
    await attachPaths(paths);
  }

  async function handleEditorDrop(e: React.DragEvent) {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);
    if (!selected) { ui.toast(t('story.selectFirst'), 'error'); return; }
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.inkwell.pathForFile?.(f) || '';
      if (p) paths.push(p);
    }
    if (paths.length) { await attachPaths(paths); return; }
    // Plain-browser fallback (no absolute path available): read in memory.
    const rows: { name: string; content: string }[] = [];
    for (const f of Array.from(e.dataTransfer.files).slice(0, 10)) {
      if (f.size > 2_000_000) continue;
      try { rows.push({ name: f.name, content: await f.text() }); } catch { /* unreadable */ }
    }
    await attachContents(rows);
  }

  async function openPreview(file: StoryFile) {
    try {
      const row = await dbCall<{ name: string; content: string }>('getStoryFile', { id: file.id });
      setPreview({ name: row.name, content: row.content });
    } catch (e: any) {
      ui.toast(e?.message || 'Could not read the file', 'error');
    }
  }

  async function removeFile(file: StoryFile) {
    if (!(await confirmDialog({ title: t('story.removeFileConfirm'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteStoryFile', { id: file.id });
    await refreshFiles();
  }

  // --------------------------------------------------------------- import --

  async function pickImportFiles() {
    const paths = await window.inkwell.pickFiles();
    if (!paths.length) return;
    const rows = await window.inkwell.readFiles(paths, 2_000_000);
    if (!rows.length) { ui.toast(t('story.attachTooBig'), 'error'); return; }
    const hinted = rows.map((r) => guessKindFromName(r.name)).find(Boolean);
    setImportKind(hinted || kind);
    setImportFiles(rows);
  }

  const importPreview = useMemo(() => {
    if (!importFiles) return { entries: [] as ParsedEntry[], warnings: [] as string[] };
    return parseStoryFiles(importFiles, importKind);
  }, [importFiles, importKind]);

  const existingTitles = useMemo(() => new Set(scoped.map((e) => e.title.trim().toLowerCase())), [scoped]);
  const freshEntries = importPreview.entries.filter((e) => !existingTitles.has(e.title.trim().toLowerCase()));
  const skippedExisting = importPreview.entries.length - freshEntries.length;

  async function runImport() {
    if (!freshEntries.length) return;
    setImporting(true);
    try {
      const projectId = await ensureProject();
      const res = await dbCall<{ imported: number }>('importStoryEntries', { projectId, entries: freshEntries });
      await useData.getState().load();
      await refreshFiles();
      ui.toast(t('story.importDone').replace('{n}', String(res?.imported ?? freshEntries.length)), 'ok');
      setImportFiles(null);
      setQuery('');
    } catch (e: any) {
      ui.toast(e?.message || t('story.importFailed'), 'error');
    } finally {
      setImporting(false);
    }
  }

  const linkedEntries = (draft?.links || [])
    .map((id) => story.find((e) => e.id === id))
    .filter(Boolean) as StoryEntry[];
  const linkable = story.filter((e) => e.id !== selectedId && !(draft?.links || []).includes(e.id));

  return (
    <div className="page">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name={KIND_ICON[kind]} size={18} /> {t('story.title')}</h1>
      <div className="subtitle">
        {t('story.sub')}
        {project ? <> — <b>{project.name}</b></> : <> — <i>no project selected</i></>}
      </div>
      <div className="story-grid">
        <div className="story-list">
          <div className="kind-tabs">
            {KINDS.map((k) => (
              <button key={k} className={k === kind ? 'active' : ''} onClick={() => switchKind(k)}>
                <Icon name={KIND_ICON[k]} size={13} /> {t('story.' + k)}
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
          <div className="story-actions">
            <button className="primary" style={{ flex: 1 }} onClick={() => createEntry(kind)}><Icon name="plus" size={14} /> {t('story.new')}</button>
            <button className="ghost" onClick={pickImportFiles} title={t('story.importHint')} aria-label={t('story.import')}>
              <Icon name="download" size={14} /> {t('story.import')}
            </button>
          </div>
          {list.length === 0 && <div className="empty-state" style={{ padding: 20 }}><span>{q ? t('story.searchEmpty') : t('story.nothing')}</span></div>}
          {list.map((e) => {
            const n = filesByEntry.get(e.id)?.length || 0;
            return (
              <div
                key={e.id}
                className={`story-item ${e.id === selectedId ? 'active' : ''}`}
                onClick={() => selectEntry(e.id)}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData('application/x-openplot-story', JSON.stringify({ id: e.id }));
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
                title={t('chat.dropHint')}
              >
                <div className="t">{e.title}</div>
                <div className="k">
                  {t('story.' + e.kind)}
                  <span className="wc"> · {wordCount(e.content).toLocaleString()}w</span>
                  {n > 0 && <span className="wc attach-count" title={t('story.attachments')}> · <Icon name="paperclip" size={10} /> {n}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div
          className={`story-editor ${fileDragOver ? 'file-drag-over' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            setFileDragOver(true);
          }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setFileDragOver(false); }}
          onDrop={handleEditorDrop}
        >
          {fileDragOver && <div className="file-drop-overlay"><Icon name="paperclip" size={22} /><span>{t('story.fileDrop')}</span></div>}
          {!selected || !draft ? (
            <div className="empty-state" style={{ height: '100%' }}>
              <div className="big"><Icon name="book" size={28} /></div>
              <div>{t('story.nothing')}</div>
              <div className="grid-3" style={{ width: '100%', maxWidth: 620, marginTop: 12 }}>
                {KINDS.map((k) => (
                  <div key={k} className="welcome-card" onClick={() => createEntry(k)}>
                    <div className="ic"><Icon name={KIND_ICON[k]} size={20} /></div>
                    <div className="t">{t('story.' + k)}</div>
                    <div className="d">{STORY_TEMPLATES[k] ? t('story.templateInc') : ''}</div>
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

              <div className="card attach-card">
                <div className="attach-head">
                  <label><Icon name="paperclip" size={14} /> {t('story.attachments')}</label>
                  <button className="small ghost" onClick={pickAttach} disabled={attaching}>
                    <Icon name="plus" size={13} /> {t('story.attachFile')}
                  </button>
                </div>
                {entryFiles.length === 0 ? (
                  <div className="hint">{t('story.attachHint')}</div>
                ) : (
                  <div className="attach-list">
                    {entryFiles.map((f) => (
                      <span key={f.id} className="attach-file-chip" title={`${f.name} · ${formatBytes(f.bytes)}`}>
                        <button className="attach-open" onClick={() => openPreview(f)}>
                          <Icon name="file" size={12} />
                          <span className="n">{f.name}</span>
                          <span className="sz">{formatBytes(f.bytes)}</span>
                        </button>
                        <button className="x" aria-label={t('story.removeFile')} onClick={() => removeFile(f)}>
                          <Icon name="x" size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

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

      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)} width={720}>
          <div className="hint" style={{ marginBottom: 8 }}>{t('story.previewHint')}</div>
          <pre className="file-preview">{preview.content}</pre>
        </Modal>
      )}

      {importFiles && (
        <Modal
          title={t('story.importTitle')}
          onClose={() => { if (!importing) setImportFiles(null); }}
          width={720}
          footer={(
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setImportFiles(null)} disabled={importing}>{t('confirm.cancel')}</button>
              <button className="primary" onClick={runImport} disabled={importing || !freshEntries.length}>
                <Icon name="download" size={14} /> {importing ? t('story.importing') : t('story.importRun').replace('{n}', String(freshEntries.length))}
              </button>
            </div>
          )}
        >
          <div className="hint" style={{ marginBottom: 10 }}>{t('story.importHint')}</div>
          <div className="import-files">
            {importFiles.map((f) => <span key={f.name} className="tag-chip"><Icon name="file" size={12} /> {f.name}</span>)}
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>{t('story.importAs')}</label>
            <select value={importKind} onChange={(e) => setImportKind(e.target.value as StoryKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{t('story.' + k)}</option>)}
            </select>
            <div className="hint">{t('story.importAsHint')}</div>
          </div>
          {importPreview.warnings.length > 0 && (
            <div className="import-warnings">
              {importPreview.warnings.slice(0, 6).map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          {skippedExisting > 0 && <div className="hint" style={{ marginBottom: 8 }}>{t('story.importSkip').replace('{n}', String(skippedExisting))}</div>}
          <div className="import-list">
            {freshEntries.map((e, i) => (
              <div key={`${e.title}-${i}`} className="import-row">
                <span className="kind-badge">{t('story.' + e.kind)}</span>
                <span className="t">{e.title}</span>
                <span className="d">{e.content.replace(/\s+/g, ' ').slice(0, 100)}</span>
              </div>
            ))}
            {freshEntries.length === 0 && <div className="empty-state" style={{ padding: 18 }}>{t('story.importNone')}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
