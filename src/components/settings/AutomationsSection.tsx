import { useEffect, useState } from 'react';
import { useData, useUi, dbCall, uid, runAutomations } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import type { AutomationRow } from '../../types';

// ---------------- Automations ----------------
const AUTOMATION_TRIGGERS = ['message:new', 'chat:new', 'app:ready'] as const;
const AUTOMATION_ACTIONS = ['toast', 'log', 'clearMemory', 'addMemory', 'navigate', 'newChat', 'openExternal'] as const;
// Which actions use the `param` field, and what kind of value they expect.
const AUTOMATION_PARAM: Partial<Record<string, { kind: 'text' | 'route' | 'url'; ph: string }>> = {
  addMemory: { kind: 'text', ph: 'Memory text to save automatically' },
  navigate: { kind: 'route', ph: '' },
  newChat: { kind: 'text', ph: 'Chat title (optional)' },
  openExternal: { kind: 'url', ph: 'https://example.com' }
};
const NAVIGABLE_ROUTES = ['chat', 'story', 'flow', 'chapters', 'projects', 'stats', 'settings', 'about'];

export function AutomationsSection() {
  const t = useT();
  const ui = useUi();
  const { automations } = useData();
  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => setRows(automations.map((a) => ({ ...a }))), [automations]);

  function patch(id: string, fields: Partial<AutomationRow>) {
    setRows((rs) => rs.map((x) => (x.id === id ? { ...x, ...fields } : x)));
  }

  async function save(a: AutomationRow) {
    await dbCall('saveAutomation', { id: a.id, name: a.name, trigger: a.trigger, action: a.action, param: a.param || '', enabled: Number(a.enabled) !== 0 });
    await useData.getState().load();
    ui.toast(t('auto.saved'), 'ok');
  }

  async function test(a: AutomationRow) {
    setTesting(a.id);
    try {
      await runAutomations(a.trigger, { test: true, automationId: a.id });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div id="set-automations-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="bolt" size={18} /> {t('settings.automations')}</h1>
      <div className="subtitle">{t('auto.sub')}</div>
      <div className="card">
        <button className="primary" style={{ marginBottom: 10 }} onClick={async () => {
          await dbCall('saveAutomation', { id: uid(), name: 'New automation', trigger: 'message:new', action: 'toast', param: '', enabled: 1 });
          await useData.getState().load();
        }}><Icon name="plus" size={14} /> {t('auto.add')}</button>
        {rows.length === 0 && <div className="hint">{t('auto.sub')}</div>}
        {rows.map((a) => {
          const paramCfg = AUTOMATION_PARAM[a.action];
          const dirty = (() => {
            const orig = automations.find((x) => x.id === a.id);
            if (!orig) return true;
            return orig.name !== a.name || orig.trigger !== a.trigger || orig.action !== a.action || (orig.param || '') !== (a.param || '');
          })();
          return (
            <div className={`auto-card ${Number(a.enabled) === 0 ? 'off' : ''}`} key={a.id}>
              <div className="auto-head">
                <input type="checkbox" checked={Number(a.enabled) !== 0} title={t('auto.enabled')}
                  onChange={(e) => { patch(a.id, { enabled: e.target.checked ? 1 : 0 }); save({ ...a, enabled: e.target.checked ? 1 : 0 }); }} />
                <input className="auto-name" value={a.name} onChange={(e) => patch(a.id, { name: e.target.value })} />
                <button className="small" onClick={() => test(a)} disabled={testing === a.id || Number(a.enabled) === 0} title={t('auto.test')}>
                  <Icon name="bolt" size={13} /> {testing === a.id ? '…' : t('auto.test')}
                </button>
                <button className="small danger" onClick={async () => { await dbCall('deleteAutomation', { id: a.id }); await useData.getState().load(); }}><Icon name="trash" size={13} /></button>
              </div>
              <div className="auto-grid">
                <div>
                  <label>{t('auto.when')}</label>
                  <select value={a.trigger} onChange={(e) => patch(a.id, { trigger: e.target.value })}>
                    {AUTOMATION_TRIGGERS.map((tr) => <option key={tr} value={tr}>{t(`auto.trigger.${tr}` as any)}</option>)}
                  </select>
                </div>
                <div>
                  <label>{t('auto.then')}</label>
                  <select value={a.action} onChange={(e) => patch(a.id, { action: e.target.value, param: '' })}>
                    {AUTOMATION_ACTIONS.map((ac) => <option key={ac} value={ac}>{t(`auto.action.${ac}` as any)}</option>)}
                  </select>
                </div>
                {paramCfg && (
                  <div className="auto-param">
                    <label>{t('auto.param')}</label>
                    {paramCfg.kind === 'route' ? (
                      <select value={a.param || ''} onChange={(e) => patch(a.id, { param: e.target.value })}>
                        <option value="">—</option>
                        {NAVIGABLE_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <input
                        value={a.param || ''}
                        placeholder={paramCfg.ph}
                        onChange={(e) => patch(a.id, { param: e.target.value })}
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="auto-foot">
                <span className="hint">{t(`auto.desc.${a.action}` as any)}</span>
                <button className="small primary" onClick={() => save(a)} disabled={!dirty}><Icon name="check" size={13} /> {t('skills.save')}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
