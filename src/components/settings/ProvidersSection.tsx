import { useEffect, useState } from 'react';
import { useData, useSettings, useUi, dbCall } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { confirmDialog } from '../TextPrompt';
import { useVerifyStore } from '../../verifyStore';
import { ModelStatusBar } from '../ModelStatusBar';
import { ModelCapabilityCard } from '../ModelCapabilityCard';
import { SmartSetupCard } from './SmartSetupCard';
import type { Provider, ProviderPreset, PresetRefreshResult } from '../../types';

// ---------------- Providers ----------------
function ModelTagList({ provider, onRemove, onVerify }: {
  provider: Provider;
  onRemove: (p: Provider, model: string) => void;
  onVerify: (p: Provider, model: string) => void;
}) {
  const t = useT();
  const { results, pending } = useVerifyStore();
  const models = Array.isArray(provider.models) ? provider.models : [];
  return (
    <div className="model-tags">
      {models.map((m) => {
        const vkey = `${provider.id}::${m}`;
        const vr = results[vkey];
        const checking = pending.has(vkey);
        return (
          <span key={m} className={`model-tag ${checking ? 'checking' : ''}`}>
            {m}
            {vr && (
              <em className={vr.ok ? 'ok' : 'bad'} style={{ fontStyle: 'normal' }}>
                {vr.ok ? `${vr.latencyMs}ms` : t('providers.verifyFail')}
              </em>
            )}
            <button
              title={checking ? t('providers.verifying') : t('providers.verifyDetail')}
              disabled={checking}
              onClick={() => onVerify(provider, m)}
            >
              <Icon name="bolt" size={12} />
            </button>
            <button title="Remove" onClick={() => onRemove(provider, m)}><Icon name="x" size={12} /></button>
          </span>
        );
      })}
      {models.length === 0 && <span className="hint">{t('providers.fetch')} / {t('providers.addModel')}</span>}
    </div>
  );
}

function KeyValidation({ provider }: { provider: Provider }) {
  const t = useT();
  const ui = useUi();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; method: string } | null>(null);

  async function run() {
    setChecking(true);
    setResult(null);
    try {
      const res = await window.inkwell.validateKey({ ...provider, kind: (provider as any).kind || 'auto' });
      if (res.ok && res.data) {
        setResult({ ok: res.data.ok, message: res.data.message, method: res.data.method });
      } else {
        setResult({ ok: false, message: res.error || 'validation failed', method: '' });
      }
    } catch (err: any) {
      setResult({ ok: false, message: err?.message || String(err), method: '' });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="key-validation">
      <button className="small" onClick={run} disabled={checking}>
        <Icon name="check" size={13} /> {checking ? t('providers.validating') : t('providers.validateKey')}
      </button>
      {result && (
        <span className={`key-result ${result.ok ? 'ok' : 'bad'}`} title={result.method}>
          <Icon name={result.ok ? 'check' : 'x'} size={12} /> {result.message}
        </span>
      )}
    </div>
  );
}

function VerifyFailures({ providerId }: { providerId: string }) {
  const { results } = useVerifyStore();
  const prefix = providerId + '::';
  const fails = Object.entries(results).filter(([k, v]) => !v.ok && k.startsWith(prefix));
  if (!fails.length) return null;
  return (
    <div className="hint" style={{ color: 'var(--danger, #e5484d)' }}>
      {fails.map(([k, v]) => (
        <div key={k}><Icon name="bolt" size={12} /> {k.slice(prefix.length)}: {v.error}</div>
      ))}
    </div>
  );
}

export function ProvidersSection() {
  const t = useT();
  const ui = useUi();
  const settings = useSettings();
  const { providers } = useData();
  const [list, setList] = useState<Provider[]>([]);
  const [manualModel, setManualModel] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');

  useEffect(() => setList(providers.map((p) => ({ ...p }))), [providers]);

  useEffect(() => {
    window.inkwell.providerPresets().then((r) => setPresets(r.data || [])).catch(() => {});
  }, []);

  async function add() {
    await dbCall('createProvider', {
      name: 'New provider',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: [],
      kind: 'auto'
    });
    await useData.getState().load();
  }

  async function persist(p: Provider): Promise<boolean> {
    if (!p.baseUrl.trim()) {
      ui.toast(t('providers.baseUrl') + ' is required', 'error');
      return false;
    }
    await dbCall('updateProvider', {
      id: p.id, name: p.name, baseUrl: p.baseUrl.trim(), apiKey: p.apiKey,
      enabled: p.enabled === true || p.enabled === 1, models: Array.isArray(p.models) ? p.models : [],
      kind: (p as any).kind || 'auto'
    });
    await useData.getState().load();
    return true;
  }

  async function test(p: Provider) {
    if (!(await persist(p))) return;
    ui.toast(t('providers.fetching'));
    const res = await window.inkwell.fetchModels({ ...p, kind: (p as any).kind || 'auto' });
    if (res.ok && res.data) {
      setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, models: res.data! } : x)));
      await dbCall('updateProvider', {
        id: p.id, name: p.name, baseUrl: p.baseUrl.trim(), apiKey: p.apiKey,
        enabled: p.enabled === true || p.enabled === 1, models: res.data, kind: (p as any).kind || 'auto'
      });
      await useData.getState().load();
      ui.toast(`${t('providers.testOk')} — ${res.data.length} models`, 'ok');
    } else {
      ui.toast(`${t('providers.testFail')}: ${res.error}`, 'error');
    }
  }

  async function remove(id: string) {
    if (!(await confirmDialog({ title: t('providers.delete') + '?', danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteProvider', { id });
    await useData.getState().load();
    ui.toast(t('toast.deleted'), 'ok');
  }

  async function addPreset() {
    const pr = presets.find((x) => x.id === selectedPreset);
    if (!pr) return;
    await dbCall('createProvider', {
      name: pr.name, baseUrl: pr.baseUrl, apiKey: '',
      models: pr.models.map((m) => m.id), kind: pr.kind
    });
    await useData.getState().load();
    ui.toast(`${pr.name} — ${pr.needsKey ? t('providers.presetKeyNeeded') : t('providers.presetLocal')}`, 'ok');
  }

  async function verifyOneModel(p: Provider, model: string) {
    await useVerifyStore.getState().verify(p, model);
  }

  async function verifyAll() {
    if (!providers.length) return;
    const enabled = providers.filter((p) => p.enabled);
    if (!enabled.reduce((a, p) => a + (Array.isArray(p.models) ? p.models.length : 0), 0)) {
      ui.toast(t('providers.verifyNone'), 'error');
      return;
    }
    ui.toast(t('providers.verifyAllRunning'));
    await useVerifyStore.getState().verifyAll(enabled);
    const rs = useVerifyStore.getState().results;
    // Count only models belonging to the providers just verified —
    // Object.values(rs) also holds stale entries from deleted providers,
    // which skewed the ok/total ratio.
    const entries = enabled
      .flatMap((p) => (Array.isArray(p.models) ? p.models : []).map((m) => rs[`${p.id}::${m}`]))
      .filter(Boolean);
    const okCount = entries.filter((e) => e.ok).length;
    ui.toast(`${t('providers.verifyAllDone')}: ${okCount}/${entries.length} ${t('providers.verifyOk')}`, okCount === entries.length ? 'ok' : 'error');
  }

  async function resetHealth() {
    if (!(await confirmDialog({ title: t('health.resetConfirm'), danger: true, confirmLabel: t('confirm.ok'), cancelLabel: t('confirm.cancel') }))) return;
    useVerifyStore.getState().clear();
    ui.toast(t('health.resetDone'), 'ok');
  }

  // Subscribe: the Verify-all button flips into a Stop button mid-sweep.
  const verifying = useVerifyStore((s) => s.verifying);

  // Verify just ONE provider (reuses the same capped sweep + global Stop).
  async function verifyProvider(p: Provider) {
    const models = Array.isArray(p.models) ? p.models : [];
    if (!models.length) { ui.toast(`${p.name}: ${t('providers.verifyNone')}`, 'error'); return; }
    ui.toast(`${t('providers.verifyAllRunning')} — ${p.name}`);
    await useVerifyStore.getState().verifyAll([p]);
    const rs = useVerifyStore.getState().results;
    const entries = models.map((m) => rs[`${p.id}::${m}`]).filter(Boolean);
    const okCount = entries.filter((e) => e.ok).length;
    ui.toast(`${p.name}: ${okCount}/${entries.length} ${t('providers.verifyOk')}`, okCount === entries.length ? 'ok' : 'error');
  }

  async function refreshPresets() {
    ui.toast(t('providers.refreshing'));
    const res = await window.inkwell.refreshPresets(providers.map((p) => ({ ...p, kind: (p as any).kind || 'auto' })));
    if (res.ok && res.data) {
      window.inkwell.providerPresets().then((r) => setPresets(r.data || [])).catch(() => {});
      const failed = res.data.filter((r: PresetRefreshResult) => !r.ok);
      if (failed.length) {
        ui.toast(`${t('providers.refreshPartial')}: ${failed.map((f: PresetRefreshResult) => f.presetName).join(', ')}`, 'error');
      } else {
        ui.toast(t('providers.refreshDone'), 'ok');
      }
    } else {
      ui.toast(`${t('providers.refreshFail')}: ${res.error}`, 'error');
    }
  }

  function addManualModel(p: Provider) {
    const m = (manualModel[p.id] || '').trim();
    if (!m) return;
    setList((ls) => ls.map((x) => (x.id === p.id && !(x.models as string[]).includes(m) ? { ...x, models: [...(x.models as string[]), m] } : x)));
    setManualModel((s) => ({ ...s, [p.id]: '' }));
  }

  function removeModel(p: Provider, model: string) {
    setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, models: (x.models as string[]).filter((mm) => mm !== model) } : x)));
  }

  return (
    <div>
      <h1>{t('settings.providers')}</h1>
      <div className="subtitle">{t('providers.sub')}</div>

      {/* Guided path: preset → key → test → default model → verify. */}
      <SmartSetupCard />

      <div className="card">
        <h3>{t('providers.presets')}</h3>
        <div className="row" style={{ marginBottom: 8 }} id="set-provider-preset">
          <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)}>
            <option value="">— {t('providers.presets')} —</option>
            {presets.map((pr) => (
              <option key={pr.id} value={pr.id}>{pr.name}</option>
            ))}
          </select>
          <button className="primary" id="set-provider-add" disabled={!selectedPreset} onClick={addPreset}><Icon name="plus" size={14} /> {t('providers.add')}</button>
          <button onClick={refreshPresets} title={t('providers.refreshHint')}><Icon name="refresh" size={14} /> {t('providers.refresh')}</button>
        </div>
        {presets.find((x) => x.id === selectedPreset) && (
          <div className="model-tags">
            {presets.find((x) => x.id === selectedPreset)!.models.map((m) => (
              <span key={m.id} className="model-tag" title={m.note}>{m.id}</span>
            ))}
          </div>
        )}
        <div className="hint">{t('providers.presetsHint')}</div>
      </div>

      {list.map((p) => (
        <div className="provider-card" key={p.id}>
          <div className="head">
            <input type="checkbox" checked={!!p.enabled} onChange={(e) => setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, enabled: e.target.checked } : x)))} title={t('providers.enabled')} />
            <input
              style={{ flex: 1 }}
              value={p.name}
              onChange={(e) => setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))}
            />
            <button className="small" onClick={() => test(p)}>{t('providers.test')}</button>
            <button className="small" onClick={() => verifyProvider(p)} disabled={verifying}
              title={t('providers.verifyOneHint')} aria-label={t('providers.verifyOne')}>
              <Icon name="bolt" size={13} />
            </button>
            <button className="small danger" onClick={() => remove(p.id)}><Icon name="trash" size={13} /></button>
          </div>
          <div className="grid">
            <div>
              <label>{t('providers.baseUrl')}</label>
              <input value={p.baseUrl} onChange={(e) => setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, baseUrl: e.target.value } : x)))} />
            </div>
            <div>
              <label>{t('providers.apiKey')}</label>
              <input type="password" value={p.apiKey} onChange={(e) => setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, apiKey: e.target.value } : x)))} />
            </div>
            <div className="full">
              <label>{t('providers.kind')}</label>
              <select value={(p as any).kind || 'auto'} onChange={(e) => setList((ls) => ls.map((x) => (x.id === p.id ? { ...x, kind: e.target.value as Provider['kind'] } : x)))}>
                <option value="auto">{t('providers.kind.auto')}</option>
                <option value="openai">{t('providers.kind.openai')}</option>
                <option value="anthropic">{t('providers.kind.anthropic')}</option>
              </select>
            </div>
          </div>
          <KeyValidation provider={p} />
          {(Array.isArray(p.models) ? p.models : []).length > 0 && (
            <ModelCapabilityCard provider={p} preferredModel={settings.defaultModel} />
          )}
          <label style={{ marginTop: 8 }}>{t('providers.models')}</label>
          <ModelTagList provider={p} onRemove={removeModel} onVerify={verifyOneModel} />
          <VerifyFailures providerId={p.id} />
          {(Array.isArray(p.models) ? p.models : []).length > 0 && (
            <div className="model-status-list">
              {(Array.isArray(p.models) ? p.models : []).slice(0, 8).map((m) => (
                <div key={m} className="model-status-row">
                  <code>{m}</code>
                  <ModelStatusBar providerId={p.id} model={m} />
                </div>
              ))}
              <div className="hint" style={{ marginTop: 4 }}>{t('health.disclaimer')}</div>
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              placeholder={t('providers.addModel')}
              value={manualModel[p.id] || ''}
              onChange={(e) => setManualModel((s) => ({ ...s, [p.id]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManualModel(p); } }}
            />
            <button className="small" onClick={() => addManualModel(p)}><Icon name="plus" size={13} /></button>
            <button className="small" onClick={() => persist(p)}><Icon name="check" size={13} /> {t('toast.saved')}</button>
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: 4 }}>
        <button className="primary" onClick={add}><Icon name="plus" size={14} /> {t('providers.add')}</button>
        {verifying ? (
          <button className="danger" onClick={() => useVerifyStore.getState().stopVerifyAll()} title={t('providers.verifyStopHint')}>
            <Icon name="x" size={14} /> {t('providers.verifyStop')}
          </button>
        ) : (
          <button id="set-provider-verify-all" onClick={verifyAll} title={t('providers.verifyAllHint')}><Icon name="check" size={14} /> {t('providers.verifyAll')}</button>
        )}
        <button onClick={resetHealth} title={t('health.resetHint')}><Icon name="trash" size={14} /> {t('health.reset')}</button>
      </div>
    </div>
  );
}
