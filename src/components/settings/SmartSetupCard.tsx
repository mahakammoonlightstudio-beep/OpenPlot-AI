import { useEffect, useState } from 'react';
import { useData, useSettings, useUi, dbCall } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { smartDefaults } from '../../lib/modelCaps';
import type { ModelCapabilities, ProviderPreset } from '../../types';

type Step = 'details' | 'models' | 'verify' | 'done';

/**
 * Smart setup (v1.2.3 Task 6): pick a preset → paste the key → test & fetch
 * models → choose a default → verify → done.
 *
 * The card stays open on every failure and says what to fix; nothing is
 * "finished" until the chosen model has actually answered a probe, because a
 * provider row that has never been verified is how users end up with a chat
 * that silently does nothing.
 */
export function SmartSetupCard({ forceOpen = false }: { forceOpen?: boolean }) {
  const t = useT();
  const ui = useUi();
  const providers = useData((s) => s.providers);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [open, setOpen] = useState(providers.length === 0);
  const [step, setStep] = useState<Step>('details');
  const [presetId, setPresetId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [kind, setKind] = useState<'auto' | 'openai' | 'anthropic'>('auto');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [caps, setCaps] = useState<ModelCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    window.inkwell.providerPresets().then((r) => setPresets(r.data || [])).catch(() => {});
  }, []);

  function pickPreset(id: string) {
    setPresetId(id);
    setError(null);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setKind(p.kind);
  }

  async function testAndFetch() {
    if (!baseUrl.trim()) {
      setError(t('smart.errUrl'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = { name: name.trim() || 'Provider', baseUrl: baseUrl.trim(), apiKey, models: [], kind };
      let id = providerId;
      if (!id) {
        const row = await dbCall<any>('createProvider', payload);
        id = row?.id || null;
        setProviderId(id);
      } else {
        await dbCall('updateProvider', { id, ...payload });
      }
      await useData.getState().load();
      const res = await window.inkwell.fetchModels({ id: id || undefined, ...payload } as any);
      if (!res.ok || !res.data) {
        setError(res.error || t('smart.errFetch'));
        return;
      }
      await dbCall('updateProvider', { id, ...payload, models: res.data });
      await useData.getState().load();
      setModels(res.data);
      setModel(res.data[0] || '');
      setStep('models');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!providerId || !model) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.inkwell.probeCapabilities({ id: providerId, name, baseUrl, apiKey, kind } as any, model);
      if (!res.ok || !res.data) {
        setError(res.error || t('smart.errVerify'));
        return;
      }
      setCaps(res.data);
      if (!res.data.ok) {
        setError(res.data.error || t('smart.errVerify'));
        return;
      }
      await useSettings.getState().load();
      setStep('verify');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (!providerId || !model) return;
    const s = useSettings.getState();
    s.set('defaultModelRef', { providerId, model });
    s.set('defaultModel', model);
    if (s.smartDefaults && caps?.ok) {
      const changes = smartDefaults(caps, { kind });
      for (const [k, v] of Object.entries(changes)) s.set(k as any, v as any);
    }
    setStep('done');
    ui.toast(t('smart.doneToast').replace('{model}', model), 'ok');
    setTimeout(() => setOpen(false), 1200);
  }

  if (!open) {
    return (
      <button className="smart-open" id="set-smart-setup" onClick={() => { setOpen(true); setStep('details'); }}>
        <Icon name="sparkle" size={14} /> {t('smart.title')} <span className="hint">{t('smart.sub')}</span>
      </button>
    );
  }

  const steps: Array<{ key: Step; label: string }> = [
    { key: 'details', label: t('smart.stepKey') },
    { key: 'models', label: t('smart.stepModel') },
    { key: 'verify', label: t('smart.stepVerify') },
    { key: 'done', label: t('smart.stepDone') }
  ];
  const activeIndex = Math.max(0, steps.findIndex((s) => s.key === step));

  return (
    <div className="card smart-card" id="set-smart-setup">
      <div className="smart-head">
        <h3 style={{ margin: 0 }}><Icon name="sparkle" size={15} /> {t('smart.title')}</h3>
        <button className="small ghost" onClick={() => setOpen(false)} aria-label={t('smart.close')}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="smart-sub">{t('smart.sub')}</div>

      <div className="smart-steps">
        {steps.map((s, i) => (
          <span key={s.key} className={`smart-step ${i <= activeIndex ? 'on' : ''} ${i === activeIndex ? 'current' : ''}`}>
            <b>{i + 1}</b> {s.label}
          </span>
        ))}
      </div>

      {step === 'details' && (
        <>
          <div className="field">
            <label>{t('smart.preset')}</label>
            <select value={presetId} onChange={(e) => pickPreset(e.target.value)}>
              <option value="">{t('smart.custom')}</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid-2">
            <div className="field"><label>{t('smart.name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenAI" /></div>
            <div className="field"><label>{t('smart.kind')}</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
                <option value="auto">{t('providers.kind.auto')}</option>
                <option value="openai">{t('providers.kind.openai')}</option>
                <option value="anthropic">{t('providers.kind.anthropic')}</option>
              </select></div>
          </div>
          <div className="field"><label>{t('smart.baseUrl')}</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></div>
          <div className="field"><label>{t('smart.key')}</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t('smart.keyPh')} autoComplete="off" /></div>
          <div className="row">
            <button className="primary" onClick={testAndFetch} disabled={busy}>
              <Icon name="bolt" size={14} /> {busy ? t('smart.testing') : t('smart.test')}
            </button>
            {error && <span className="key-result bad"><Icon name="x" size={12} /> {error}</span>}
          </div>
          {error && <div className="hint">{t('smart.errorHint')}</div>}
        </>
      )}

      {step === 'models' && (
        <>
          <div className="field">
            <label>{t('smart.pickModel')}</label>
            <select value={model} onChange={(e) => { setModel(e.target.value); setCaps(null); }}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="hint">{t('smart.modelsFound').replace('{n}', String(models.length))}</div>
          </div>
          <div className="row">
            <button className="primary" onClick={verify} disabled={busy || !model}>
              <Icon name="cpu" size={14} /> {busy ? t('smart.verifying') : t('smart.verify')}
            </button>
            <button className="ghost" onClick={() => setStep('details')}>{t('smart.back')}</button>
            {error && <span className="key-result bad"><Icon name="x" size={12} /> {error}</span>}
          </div>
        </>
      )}

      {step === 'verify' && caps && (
        <>
          <div className="caps-grid" style={{ marginBottom: 10 }}>
            <span className={`cap-chip ${caps.streaming ? 'on' : 'off'}`}>{t('caps.streaming')}</span>
            <span className={`cap-chip ${caps.tools ? 'on' : 'off'}`}>{t('caps.tools')}</span>
            <span className={`cap-chip ${caps.thinking ? 'on' : 'off'}`}>{t('caps.thinking')}</span>
            <span className="cap-chip mem">{caps.contextTokens ? `~${Math.round(caps.contextTokens / 1024)}k tok` : t('caps.memUnknown')}</span>
          </div>
          <div className="row">
            <button className="primary" onClick={finish}>
              <Icon name="check" size={14} /> {t('smart.finish')}
            </button>
            <button className="ghost" onClick={() => setStep('models')}>{t('smart.back')}</button>
          </div>
        </>
      )}

      {step === 'done' && (
        <div className="key-result ok">
          <Icon name="check" size={13} /> {t('smart.doneToast').replace('{model}', model)}
        </div>
      )}
    </div>
  );
}
