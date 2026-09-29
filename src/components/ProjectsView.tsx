import { useEffect, useState } from 'react';
import { useData, dbCall, createChatUi, useUi } from '../store';
import { Project } from '../types';
import { useT } from '../i18nReact';
import { textPrompt, confirmDialog } from './TextPrompt';
import { Icon } from './Icons';
import { buildProjectMarkdown, exportProjectAs, ExportFormat } from '../exportProject';

export function ProjectsView() {
  const t = useT();
  const { projects, activeProjectId, setActiveProject } = useData();
  const [draft, setDraft] = useState<{ name: string; description: string; context: string; format: string; rating: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const selected = projects.find((p) => p.id === activeProjectId) || null;

  useEffect(() => {
    if (selected) setDraft({ name: selected.name, description: selected.description || '', context: selected.context || '', format: selected.format || 'novel', rating: selected.rating || 'teen' });
    else setDraft(null);
    setDirty(false);
  }, [activeProjectId, projects.length]);

  async function selectProject(id: string | null) {
    if (dirty && !(await confirmDialog({ title: t('confirm.discard'), danger: true, confirmLabel: t('confirm.discardChanges'), cancelLabel: t('confirm.keepEditing') }))) return;
    setActiveProject(id);
  }

  async function create() {
    const name = await textPrompt({ title: t('projects.name'), confirmLabel: t('projects.create') });
    if (!name) return;
    const p = await dbCall<Project>('createProject', { name });
    await useData.getState().load();
    setActiveProject(p.id);
  }

  async function save() {
    if (!selected || !draft) return;
    await dbCall('updateProject', { id: selected.id, name: draft.name, description: draft.description, context: draft.context, format: draft.format, rating: draft.rating });
    await useData.getState().load();
    setDirty(false);
  }

  async function remove() {
    if (!selected || !(await confirmDialog({ title: t('confirm.deleteProject'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteProject', { id: selected.id });
    setActiveProject(null);
    await useData.getState().load();
  }

  async function newChatInProject() {
    if (!selected) return;
    await createChatUi('New chat', selected.id);
  }

  // Export the whole project as one Markdown file (bible + flow + chapters).
  async function exportProject() {
    if (!selected || !draft) return;
    const { story, chapters, flowBeats } = useData.getState();
    const result = buildProjectMarkdown(selected, story, chapters, flowBeats);
    const res = await window.inkwell.exportMarkdown(`${result.name}.md`, result.markdown);
    const ui = useUi.getState();
    if (res.ok) {
      const s = result.stats;
      ui.toast(
        t('projects.exportedToast')
          .replace('{e}', String(s.entries))
          .replace('{f}', String(s.beats))
          .replace('{c}', String(s.chapters))
          .replace('{w}', s.words.toLocaleString()),
        'ok'
      );
    } else if (res.error !== 'cancelled') {
      ui.toast(t('chat.exportFailed'), 'error');
      
    }
  }

  // Export menu: Markdown / plain-text manuscript / EPUB ebook.
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  async function doExport(fmt: ExportFormat) {
    if (!selected || !draft || exporting) return;
    setExporting(true);
    setExportOpen(false);
    try {
      const { story, chapters, flowBeats } = useData.getState();
      const r = await exportProjectAs(fmt, selected, story, chapters, flowBeats);
      const ui = useUi.getState();
      if (r.ok) {
        ui.toast(
          (fmt === 'md' ? t('projects.exportedToast') : t('projects.exportedEbookToast'))
            .replace('{e}', String(r.entries))
            .replace('{f}', String(r.beats))
            .replace('{c}', String(r.chapters))
            .replace('{w}', r.words.toLocaleString()),
          'ok'
        );
      } else if (!r.cancelled) {
        ui.toast(t('chat.exportFailed'), 'error');
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="folder" size={18} /> {t('app.projects')}</h1>
      <div className="subtitle">{projects.length} {t('app.projects').toLowerCase()}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <button className="primary" style={{ width: '100%', marginBottom: 10 }} onClick={create}><Icon name="plus" size={14} /> {t('app.newProject')}</button>
          {projects.length === 0 && <div className="hint">{t('projects.empty')}</div>}
          {projects.map((p) => (
            <div key={p.id} className={`story-item ${p.id === activeProjectId ? 'active' : ''}`} onClick={() => selectProject(p.id)}>
              <div className="t">{p.name}</div>
              {p.description ? <div className="k">{p.description}</div> : null}
            </div>
          ))}
        </div>
        <div>
          {!selected || !draft ? (
            <div className="card"><div className="hint">{t('projects.selectHint')}</div></div>
          ) : (
            <div className="card">
              <div className="field"><label>{t('projects.name')}</label>
                <input value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setDirty(true); }} /></div>
              <div className="field"><label>{t('projects.description')}</label>
                <input value={draft.description} onChange={(e) => { setDraft({ ...draft, description: e.target.value }); setDirty(true); }} /></div>
              <div className="grid-2">
                <div className="field" style={{ margin: 0 }}><label>{t('projects.format')}</label>
                  <select value={draft.format} onChange={(e) => { setDraft({ ...draft, format: e.target.value }); setDirty(true); }}>
                    {(['short-story', 'novel', 'book', 'fanfic', 'script'] as const).map((f) => (
                      <option key={f} value={f}>{t('projects.format.' + f)}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ margin: 0 }}><label>{t('projects.rating')}</label>
                  <select value={draft.rating} onChange={(e) => { setDraft({ ...draft, rating: e.target.value }); setDirty(true); }}>
                    {(['family', 'teen', 'mature'] as const).map((r) => (
                      <option key={r} value={r}>{t('projects.rating.' + r)}</option>
                    ))}
                  </select>
                  <div className="hint">{t('projects.ratingHint')}</div>
                </div>
              </div>
              <div className="field"><label>{t('projects.context')}</label>
                <textarea rows={8} value={draft.context} onChange={(e) => { setDraft({ ...draft, context: e.target.value }); setDirty(true); }} /></div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="primary" onClick={save} disabled={!dirty}><Icon name="check" size={14} /> {t('projects.save')}</button>
                <button onClick={newChatInProject}><Icon name="chat" size={14} /> {t('projects.newChatHere')}</button>
                <div className="export-wrap">
                  <button onClick={() => setExportOpen(!exportOpen)} title={t('projects.exportHint')}><Icon name="download" size={14} /> {t('projects.export')} <Icon name="chevronDown" size={12} /></button>
                  {exportOpen && (
                    <div className="export-menu">
                      <button onClick={() => doExport('md')}><Icon name="file" size={13} /> {t('projects.exportMd')}<span>{t('projects.exportMdDesc')}</span></button>
                      <button onClick={() => doExport('txt')}><Icon name="file" size={13} /> {t('projects.exportTxt')}<span>{t('projects.exportTxtDesc')}</span></button>
                      <button onClick={() => doExport('epub')}><Icon name="book" size={13} /> {t('projects.exportEpub')}<span>{t('projects.exportEpubDesc')}</span></button>
                    </div>
                  )}
                </div>
                <button onClick={() => useData.getState().navigate('story')}><Icon name="book" size={14} /> {t('projects.openStory')}</button>
                <button onClick={() => useData.getState().navigate('chapters')}><Icon name="book" size={14} /> {t('projects.openChapters')}</button>
                <button className="danger" onClick={remove} style={{ marginLeft: 'auto' }}><Icon name="trash" size={14} /> {t('projects.delete')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
