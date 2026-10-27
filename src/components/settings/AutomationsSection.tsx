import { useEffect, useState } from 'react';
import { useData, useUi, dbCall, uid, runAutomations, automationLog, NAVIGABLE_ROUTES } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import type { AutomationRow } from '../../types';

// ---------------- Automations ----------------
/** Every trigger the app actually fires (Task 14). */
export const AUTOMATION_TRIGGERS = [
  'app:ready', 'chat:new', 'chat:send', 'message:new',
  'chapter:saved', 'project:created', 'skill:enabled'
] as const;

export const AUTOMATION_ACTIONS = [
  'toast', 'notify', 'log', 'addMemory', 'clearMemory', 'navigate', 'newChat', 'openExternal', 'runSkill'
] as const;

// Which actions use the `param` field, and what kind of value they expect.
const AUTOMATION_PARAM: Partial<Record<string, { kind: 'text' | 'route' | 'url' | 'skill'; ph: string }>> = {
  toast: { kind: 'text', ph: 'Optional text (defaults to the automation name)' },
  notify: { kind: 'text', ph: 'Text to show with the window flash' },
  addMemory: { kind: 'text', ph: 'Memory text to save automatically' },
  navigate: { kind: 'route', ph: '' },
  newChat: { kind: 'text', ph: 'Chat title (optional)' },
  openExternal: { kind: 'url', ph: 'https://example.com' },
  runSkill: { kind: 'skill', ph: '' }
};

const timeLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function AutomationsSection() {
  const t = useT();
  const ui = useUi();
  const { automations, skills } = useData();
  // Seeded from the store (not just in an effect) so the first paint already
  // shows the saved rules rather than an empty flash.
  const [rows, setRows] = useState<AutomationRow[]>(() => automations.map((a) => ({ ...a })));
  const [testing, setTesting] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [logFor, setLogFor] = useState<string | null>(null);

  useEffect(() => setRows(automations.map((a) => ({ ...a }))), [automations]);

  function patch(id: string, fields: Partial<AutomationRow>) {
    setRows((rs) => rs.map((x) => (x.id === id ? { ...x, ...fields } : x)));
  }

  async function save(a: AutomationRow) {
    await dbCall('saveAutomation', { id: a.id, name: a.name, trigger: a.trigger, action: a.action, param: a.param || '', enabled: Number(a.enabled) !== 0 });
    await useData.getState().load();
    ui.toast(t('auto.saved'), 'ok');
  }

  /**
   * Run exactly this automation, not every automation that shares its trigger.
   * The old "test" ran the whole trigger bucket, so pressing Run now on one row
   * also fired its siblings — surprising and occasionally destructive.
   */
  async function runNow(a: AutomationRow) {
    setTesting(a.id);
    try {
      const all = useData.getState().automations;
      // Temporarily disable the siblings, run the bucket, restore. Same code
      // path as a real trigger, no separate action switch to drift.
      useData.setState({
        automations: all.map((x) => (x.id === a.id ? { ...x, enabled: 1 } : { ...x, enabled: 0 }))
      });
      await runAutomations(a.trigger, { test: true, automationId: a.id });
      useData.setState({ automations: all });
      setTick((n) => n + 1);
    } finally {
      setTesting(null);
    }
  }

  const statusFor = (id: string) => automationLog(id)[0] || null;

  return (
    <div id="set-automations-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="bolt" size={18} /> {t('settings.automations')}</h1>
      <div className="subtitle">{t('auto.sub')}</div>
      <div className="card">
        <button className="primary" style={{ marginBottom: 10 }} onClick={async () => {
          await dbCall('saveAutomation', { id: uid(), name: 'New automation', trigger: 'message:new', action: 'toast', param: '', enabled: 1 });
          await useData.getState().load();
        }}><Icon name="plus" size={14} /> {t('auto.add')}</button>
        {rows.length === 0 && <div className="hint">{t('auto.empty')}</div>}
        {rows.map((a) => {
          const paramCfg = AUTOMATION_PARAM[a.action];
          const status = statusFor(a.id);
          const runs = automationLog(a.id);
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
                <button className="small" onClick={() => runNow(a)} disabled={testing === a.id || Number(a.enabled) === 0} title={t('auto.test')}>
                  <Icon name="bolt" size={13} /> {testing === a.id ? '…' : t('auto.test')}
                </button>
                <button className="small ghost" onClick={() => setLogFor(logFor === a.id ? null : a.id)} title={t('auto.log')} aria-label={t('auto.log')}>
                  <Icon name="file" size={13} /> {runs.length || ''}
                </button>
                <button className="small danger" onClick={async () => { await dbCall('deleteAutomation', { id: a.id }); await useData.getState().load(); }} title={t('auto.delete')} aria-label={t('auto.delete')}><Icon name="trash" size={13} /></button>
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
                    ) : paramCfg.kind === 'skill' ? (
                      <select value={a.param || ''} onChange={(e) => patch(a.id, { param: e.target.value })}>
                        <option value="">—</option>
                        {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
                {status && (
                  <span className={`auto-status ${status.ok ? 'ok' : 'fail'}`} title={status.message}>
                    {status.ok ? '✓' : '!'} {timeLabel(status.at)} · {status.message}
                  </span>
                )}
                <button className="small primary" onClick={() => save(a)} disabled={!dirty}><Icon name="check" size={13} /> {t('auto.save')}</button>
              </div>
              {logFor === a.id && (
                <div className="auto-log" key={tick}>
                  {runs.length === 0 && <div className="hint">{t('auto.noRuns')}</div>}
                  {runs.map((r, i) => (
                    <div key={i} className={`auto-log-row ${r.ok ? 'ok' : 'fail'}`}>
                      <span className="t">{timeLabel(r.at)}</span>
                      <span className="m">{r.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="hint" style={{ marginTop: 8 }}>{t('auto.sessionNote')}</div>
      </div>
    </div>
  );
}
