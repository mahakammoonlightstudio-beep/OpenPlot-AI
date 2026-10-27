import { useState } from 'react';
import { useData, useSettings, useUi, dbCall } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { confirmDialog } from '../TextPrompt';

// ---------------- Memory ----------------
export function MemorySection() {
  const t = useT();
  const { memories } = useData();
  const settings = useSettings();
  const [val, setVal] = useState('');

  async function add() {
    const v = val.trim();
    if (!v) return;
    await dbCall('addMemory', { content: v, source: 'manual' });
    await useData.getState().load();
    setVal('');
  }

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="memory" size={18} /> {t('settings.memory')}</h1>
      <div className="subtitle">{t('memory.sub')}</div>
      <div className="card" id="set-memory-auto">
        <label className="toggle" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)' }}>
          <input type="checkbox" checked={settings.autoMemory} onChange={(e) => settings.set('autoMemory', e.target.checked)} />
          {t('memory.auto')}
        </label>
      </div>
      <div className="card" id="set-memory-list">
        <div className="row" style={{ marginBottom: 10 }}>
          <input value={val} placeholder={t('memory.add')} onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="primary" onClick={add}>
            {t('memory.addBtn')}
          </button>
        </div>
        {memories.length === 0 && <div className="hint">{t('memory.empty')}</div>}
        {memories.map((m) => (
          <div className="memory-item" key={m.id}>
            <div style={{ flex: 1 }}>
              <div className="c">{m.content}</div>
              <div className="src">{m.source}</div>
            </div>
            <button className="small danger" onClick={async () => { await dbCall('deleteMemory', { id: m.id }); useData.getState().load(); }}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        {memories.length > 0 && (
          <button
            className="danger"
            style={{ marginTop: 10 }}
            onClick={async () => {
              if (!(await confirmDialog({ title: t('memory.clearConfirm'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
              await dbCall('clearMemories', {});
              await useData.getState().load();
              useUi.getState().toast(t('memory.cleared'), 'ok');
            }}
          >
            <Icon name="trash" size={14} /> {t('memory.clearAll')}
          </button>
        )}
      </div>
    </div>
  );
}
