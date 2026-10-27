import { useState } from 'react';
import { useData, useSettings, useUi, dbCall } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { confirmDialog } from '../TextPrompt';

// ---------------- Styles (reply personas) ----------------
export function StylesSection() {
  const t = useT();
  const ui = useUi();
  const { styles } = useData();
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = styles.find((s) => s.id === sel) || null;

  function pick(id: string | null) {
    setSel(id);
    const s = styles.find((x) => x.id === id) || null;
    setDraft(s ? { name: s.name, content: s.content } : null);
  }

  async function save() {
    if (!selected || !draft || !draft.name.trim() || busy) return;
    setBusy(true);
    try {
      await dbCall('saveStyle', { id: selected.id, name: draft.name.trim(), content: draft.content });
      await useData.getState().load();
      ui.toast(t('toast.saved'), 'ok');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected || busy) return;
    if (selected.builtin) { ui.toast(t('style.builtinNoDelete'), 'error'); return; }
    if (!(await confirmDialog({ title: t('style.deleteConfirm'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    try {
      await dbCall('deleteStyle', { id: selected.id });
      if (useSettings.getState().defaultStyleId === selected.id) {
        useSettings.getState().set('defaultStyleId', null);
      }
      await useData.getState().load();
      pick(null);
    } catch (e: any) {
      ui.toast(e?.message || 'Delete failed', 'error');
    }
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const row = await dbCall<any>('saveStyle', { id: null, name: 'New style', content: 'Describe how the assistant should write in this style…' });
      await useData.getState().load();
      pick(row.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="set-default-style">
      <h1>{t('style.title')}</h1>
      <div className="subtitle" style={{ marginBottom: 14 }}>{t('style.sub')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="primary" onClick={create}><Icon name="plus" size={14} /> {t('style.new')}</button>
        {useSettings.getState().defaultStyleId && (
          <button className="ghost" onClick={() => { useSettings.getState().set('defaultStyleId', null); ui.toast(t('style.cleared'), 'ok'); }}>
            <Icon name="x" size={14} /> {t('style.clearActive')}
          </button>
        )}
      </div>
      <div className="styles-grid">
        <div className="styles-list">
          {styles.map((s) => (
            <button key={s.id} className={`style-row ${s.id === sel ? 'active' : ''}`} onClick={() => pick(s.id)}>
              <span className="t">{s.name}</span>
              {s.builtin ? <span className="v-src builtin">builtin</span> : <span className="v-src custom">custom</span>}
            </button>
          ))}
          {styles.length === 0 && <div className="hint">{t('style.noneYet')}</div>}
        </div>
        <div className="styles-editor">
          {!selected || !draft ? (
            <div className="empty-state" style={{ height: '100%', minHeight: 220 }}>
              <div className="big"><Icon name="sparkle" size={26} /></div>
              <div>{t('style.pickOne')}</div>
            </div>
          ) : (
            <>
              <div className="head">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('style.namePh')} />
                {selected.builtin ? <span className="v-src builtin">builtin</span> : null}
                <button className="primary" onClick={save} disabled={busy || !draft.name.trim()}><Icon name="check" size={14} /> {t('story.save')}</button>
                {!selected.builtin && <button className="danger" onClick={remove} aria-label={t('confirm.delete')}><Icon name="trash" size={14} /></button>}
              </div>
              <div className="hint">{t('style.systemHint')}</div>
              <textarea
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                placeholder={t('style.contentPh')}
                style={{ minHeight: 220 }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
