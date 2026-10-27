import { useEffect, useState } from 'react';
import { useData, useUi, dbCall, uid } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';

// ---------------- Plugins ----------------
const SAMPLE_PLUGIN = `// OpenPlot AI plugin example
context.registerHook('message:new', (payload) => {
  context.log('New AI message in chat ' + payload.chatId);
});
context.registerCommand('greet', () => {
  context.toast('Hello from plugin!');
});`;

export function PluginsSection({ logs, reloadLogs }: { logs: string[]; reloadLogs: () => void }) {
  const t = useT();
  const ui = useUi();
  const { plugins } = useData();
  const [sel, setSel] = useState<string | null>(null);
  const current = plugins.find((p) => p.id === sel) || null;
  const [draft, setDraft] = useState<{ name: string; code: string }>({ name: '', code: '' });
  const [loaded, setLoaded] = useState<any[]>([]);

  useEffect(() => {
    if (current) setDraft({ name: current.name, code: current.code });
  }, [sel]);

  const refreshLoaded = () => {
    window.inkwell.listLoadedPlugins().then((r) => setLoaded(r.data || [])).catch(() => {});
  };
  useEffect(refreshLoaded, [plugins]);

  async function save() {
    await dbCall('savePlugin', { id: current?.id || uid(), name: draft.name || 'plugin', code: draft.code, enabled: current ? Number(current.enabled) === 1 : true });
    await useData.getState().load();
    await window.inkwell.reloadPlugins();
    refreshLoaded();
    reloadLogs();
    ui.toast(t('plugins.saved'), 'ok');
  }

  return (
    <div id="set-plugins-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="plug" size={18} /> {t('settings.plugins')}</h1>
      <div className="subtitle">{t('plugins.sub')}</div>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="primary" onClick={async () => { await dbCall('savePlugin', { id: uid(), name: 'new-plugin', code: SAMPLE_PLUGIN, enabled: 1 }); await useData.getState().load(); }}><Icon name="plus" size={14} /> {t('plugins.add')}</button>
          <button onClick={async () => { const r = await window.inkwell.reloadPlugins(); setLoaded(r.data || []); reloadLogs(); ui.toast(t('plugins.reload'), 'ok'); }}><Icon name="refresh" size={14} /> {t('plugins.reload')}</button>
        </div>
        {plugins.map((p) => (
          <div className="list-row" key={p.id} onClick={() => setSel(p.id)} style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={Number(p.enabled) === 1} onClick={(e) => e.stopPropagation()}
              onChange={async (e) => { await dbCall('savePlugin', { id: p.id, name: p.name, code: p.code, enabled: e.target.checked }); await useData.getState().load(); await window.inkwell.reloadPlugins(); refreshLoaded(); }} />
            <div className="t">
              {p.name}
              <small>{(loaded.find((l) => l.id === p.id)?.commands || []).join(', ') || '—'}</small>
            </div>
            <button className="small" onClick={(e) => { e.stopPropagation(); setSel(p.id); }}><Icon name="pencil" size={13} /></button>
            <button className="small danger" onClick={async (e) => { e.stopPropagation(); await dbCall('deletePlugin', { id: p.id }); if (sel === p.id) setSel(null); await useData.getState().load(); await window.inkwell.reloadPlugins(); refreshLoaded(); }}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        {loaded.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <label>{t('plugins.commands')}</label>
            {loaded.map((l) => (
              <div key={l.id} className="list-row">
                <div className="t">{l.name}<small>{(l.hooks || []).join(', ')}</small></div>
                {(l.commands || []).map((c: string) => (
                  <button key={c} className="small" onClick={() => window.inkwell.runPlugin(l.id, c)}><Icon name="send" size={12} /> {c}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12 }} id="set-plugin-logs">
          <label>{t('plugins.logs')}</label>
          <pre className="codeblock" style={{ padding: 10, borderRadius: 8, background: 'var(--bg)', fontSize: 11, overflow: 'auto', maxHeight: 160 }}>
            {logs.join('\n') || '—'}
          </pre>
          <button className="small" onClick={reloadLogs}><Icon name="refresh" size={13} /></button>
        </div>
      </div>
      {current && (
        <div className="card">
          <div className="field"><label>{t('skills.name')}</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="field"><label>{t('plugins.code')}</label>
            <textarea rows={14} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} /></div>
          <button className="primary" onClick={save}><Icon name="check" size={14} /> {t('plugins.save')}</button>
        </div>
      )}
    </div>
  );
}
