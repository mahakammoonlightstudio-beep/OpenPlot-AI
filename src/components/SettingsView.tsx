import { useEffect, useState } from 'react';
import { useData, useSettings, useUi, dbCall, uid, runAutomations, DONATE_LINKS } from '../store';
import { confirmDialog } from './TextPrompt';
import { Provider, PluginRow, SkillRow, AutomationRow, McpRow, AppInfo, ProviderPreset, PresetRefreshResult, ModelCapabilities } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { useVerifyStore } from '../verifyStore';
import { ModelStatusBar } from './ModelStatusBar';

const THEMES = [
  { id: 'dark-classic', name: 'Dark Classic', md: 'Dark', sw: ['#0b0d12', '#171b26', '#7c5cff'] },
  { id: 'midnight-ink', name: 'Midnight Ink', md: 'Dark', sw: ['#07090f', '#111522', '#7c5cff'] },
  { id: 'nord', name: 'Nord', md: 'Dark', sw: ['#2e3440', '#434c5e', '#88c0d0'] },
  { id: 'dracula', name: 'Dracula', md: 'Dark', sw: ['#282a36', '#343746', '#bd93f9'] },
  { id: 'solarized', name: 'Solarized', md: 'Dark', sw: ['#002b36', '#0a4250', '#b58900'] },
  { id: 'forest', name: 'Forest', md: 'Dark', sw: ['#0f1a14', '#1c2d23', '#3ddc84'] },
  { id: 'rose-dawn', name: 'Rose Dawn', md: 'Dark', sw: ['#1c1116', '#301e28', '#ff6f91'] },
  { id: 'ocean', name: 'Ocean', md: 'Dark', sw: ['#0a1520', '#142839', '#4cc9f0'] },
  { id: 'sepia', name: 'Sepia', md: 'Light', sw: ['#f4ecd8', '#e4d6b8', '#8b5e34'] },
  { id: 'light-paper', name: 'Light Paper', md: 'Light', sw: ['#f7f7f5', '#f1f1ee', '#7048e8'] }
];

const ACCENTS = ['#7c5cff', '#4cc9f0', '#3ddc84', '#ffb703', '#ff6f91', '#e5484d', '#f5a623', '#06b6d4', '#8b5e34', '#e8e8e8'];

const SAMPLE_PLUGIN = `// OpenPlot AI plugin example
context.registerHook('message:new', (payload) => {
  context.log('New AI message in chat ' + payload.chatId);
});
context.registerCommand('greet', () => {
  context.toast('Hello from plugin!');
});`;

type Section = 'providers' | 'appearance' | 'memory' | 'behavior' | 'agentmd' | 'skills' | 'plugins' | 'automations' | 'mcp' | 'data';

export function SettingsView({ initialSection }: { initialSection?: string }) {
  const t = useT();
  const settings = useSettings();
  const [section, setSection] = useState<Section>((initialSection as Section) || 'providers');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    window.inkwell.appInfo().then(setAppInfo).catch(() => {});
  }, []);

  useEffect(() => {
    if (section === 'plugins') window.inkwell.pluginLogs().then((r) => setLogs(r.data || [])).catch(() => {});
  }, [section]);

  return (
    <div className="page" style={{ height: '100vh', overflow: 'hidden' }}>
      <div className="settings-layout">
        <div className="settings-nav">
          <h2 style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="settings" size={15} /> {t('settings.title')}</h2>
          {(['providers', 'appearance', 'memory', 'behavior', 'agentmd', 'skills', 'plugins', 'automations', 'mcp', 'data'] as Section[]).map((s) => (
            <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
              {t('settings.' + s)}
            </button>
          ))}
        </div>
        <div className="settings-content">
          {section === 'providers' && <ProvidersSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'memory' && <MemorySection />}
          {section === 'behavior' && <BehaviorSection />}
          {section === 'agentmd' && <AgentMdSection />}
          {section === 'skills' && <SkillsSection />}
          {section === 'plugins' && <PluginsSection logs={logs} reloadLogs={() => window.inkwell.pluginLogs().then((r) => setLogs(r.data || [])).catch(() => {})} />}
          {section === 'automations' && <AutomationsSection />}
          {section === 'mcp' && <McpSection />}
          {section === 'data' && <DataSection appInfo={appInfo} />}
        </div>
      </div>
    </div>
  );
}

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

function CapabilityProbe({ provider, model }: { provider: Provider; model: string }) {
  const t = useT();
  const [probing, setProbing] = useState(false);
  const [caps, setCaps] = useState<ModelCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setProbing(true); setError(null);
    try {
      const res = await window.inkwell.probeCapabilities({ ...provider, kind: (provider as any).kind || 'auto' }, model);
      if (res.ok && res.data) setCaps(res.data);
      else setError(res.error || 'probe failed');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setProbing(false);
    }
  }

  function applySmart() {
    if (!caps) return;
    // Smart Mode: align app defaults with what the model can actually do.
    const s = useSettings.getState();
    if (!caps.tools) s.set('toolsEnabled', false);
    if (!caps.thinking) s.set('thinkingEnabled', false);
    if (caps.contextTokens >= 8192) s.set('maxTokens', Math.min(4096, Math.floor(caps.contextTokens / 4)));
    else s.set('maxTokens', Math.max(512, Math.floor((caps.contextTokens || 2048) / 3)));
  }

  return (
    <div className="caps-probe">
      <div className="row" style={{ gap: 8 }}>
        <button className="small" onClick={run} disabled={probing}>
          <Icon name="cpu" size={13} /> {probing ? t('caps.probing') : t('caps.probe')}
        </button>
        {caps && caps.ok && (
          <button className="small primary" onClick={applySmart} title={t('caps.applyHint')}>
            <Icon name="bolt" size={13} /> {t('caps.apply')}
          </button>
        )}
      </div>
      {caps && caps.ok && (
        <div className="caps-grid">
          <span className={`cap-chip ${caps.tools ? 'on' : 'off'}`} title={t('caps.toolsHint')}><Icon name="tools" size={12} /> {t('caps.tools')}</span>
          <span className={`cap-chip ${caps.streaming ? 'on' : 'off'}`} title={t('caps.streamHint')}><Icon name="send" size={12} /> {t('caps.streaming')}</span>
          <span className={`cap-chip ${caps.thinking ? 'on' : 'off'}`} title={t('caps.thinkHint')}><Icon name="brain" size={12} /> {t('caps.thinking')}</span>
          <span className="cap-chip mem" title={t('caps.memHint')}><Icon name="memory" size={12} /> {caps.contextTokens ? `~${caps.contextTokens >= 1024 ? Math.round(caps.contextTokens / 1024) + 'k' : caps.contextTokens} tok` : t('caps.memUnknown')}</span>
        </div>
      )}
      {caps && !caps.ok && <span className="key-result bad"><Icon name="x" size={12} /> {caps.error || t('caps.fail')}</span>}
      {error && <span className="key-result bad"><Icon name="x" size={12} /> {error}</span>}
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

function ProvidersSection() {
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
    ui.toast(t('providers.verifyAllRunning'));
    await useVerifyStore.getState().verifyAll(providers.filter((p) => p.enabled));
    const rs = useVerifyStore.getState().results;
    const entries = Object.values(rs);
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

  // All model ids across enabled providers for the default-model picker
  const allModelIds = Array.from(new Set(
    providers.filter((p) => p.enabled).flatMap((p) => (Array.isArray(p.models) ? p.models : []))
  ));

  return (
    <div>
      <h1>{t('settings.providers')}</h1>
      <div className="subtitle">{t('providers.sub')}</div>

      <div className="card">
        <h3>{t('chat.model')} — defaults</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Default model</label>
            <select value={settings.defaultModel || ''} onChange={(e) => settings.set('defaultModel', e.target.value || null)}>
              <option value="">— auto —</option>
              {allModelIds.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="hint">{t('behavior.sub')}</div>
      </div>

      <div className="card">
        <h3>{t('providers.presets')}</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)}>
            <option value="">— {t('providers.presets')} —</option>
            {presets.map((pr) => (
              <option key={pr.id} value={pr.id}>{pr.name}</option>
            ))}
          </select>
          <button className="primary" disabled={!selectedPreset} onClick={addPreset}><Icon name="plus" size={14} /> {t('providers.add')}</button>
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
            <CapabilityProbe provider={p} model={(Array.isArray(p.models) ? p.models : [])[0]} />
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
          <button onClick={verifyAll} title={t('providers.verifyAllHint')}><Icon name="check" size={14} /> {t('providers.verifyAll')}</button>
        )}
        <button onClick={resetHealth} title={t('health.resetHint')}><Icon name="trash" size={14} /> {t('health.reset')}</button>
      </div>
    </div>
  );
}

// ---------------- Appearance ----------------

function AppearanceSection() {
  const t = useT();
  const settings = useSettings();
  return (
    <div>
      <h1>{t('settings.appearance')}</h1>
      <div className="subtitle">{t('appearance.sub')}</div>
      <div className="card">
        <h3>{t('appearance.theme')}</h3>
        <div className="theme-grid">
          {THEMES.map((th) => (
            <div key={th.id} className={`theme-swatch ${settings.theme === th.id ? 'active' : ''}`} onClick={() => settings.set('theme', th.id)}>
              <div className="sw">
                {th.sw.map((c, i) => <i key={i} style={{ background: c }} />)}
              </div>
              <div className="nm">{th.name}</div>
              <div className="md">{th.md}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>{t('appearance.accent')}</h3>
        <div className="accent-row">
          {ACCENTS.map((c) => (
            <div key={c} className={`accent-dot ${settings.accent === c ? 'active' : ''}`} style={{ background: c }} onClick={() => settings.set('accent', c)} />
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <label>{t('appearance.font')}: {settings.chatFontSize}px</label>
          <input type="range" min={12} max={20} value={settings.chatFontSize} onChange={(e) => settings.set('chatFontSize', Number(e.target.value))} style={{ width: 260 }} />
        </div>
      </div>
    </div>
  );
}

// ---------------- Memory ----------------

function MemorySection() {
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
      <div className="card">
        <label className="toggle" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)' }}>
          <input type="checkbox" checked={settings.autoMemory} onChange={(e) => settings.set('autoMemory', e.target.checked)} />
          {t('memory.auto')}
        </label>
      </div>
      <div className="card">
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

// ---------------- Behavior ----------------

function BehaviorSection() {
  const t = useT();
  const settings = useSettings();
  return (
    <div>
      <h1>{t('settings.behavior')}</h1>
      <div className="subtitle">{t('behavior.sub')}</div>
      <div className="card">
        <div className="field">
          <label>{t('behavior.temperature')}: {settings.temperature.toFixed(2)}</label>
          <input type="range" min={0} max={2} step={0.05} value={settings.temperature} onChange={(e) => settings.set('temperature', Number(e.target.value))} />
        </div>
        <div className="grid-2">
          <div className="field"><label>{t('behavior.maxTokens')}</label>
            <input type="number" min={64} max={200000} value={settings.maxTokens} onChange={(e) => settings.set('maxTokens', Math.max(64, Number(e.target.value) || 4096))} /></div>
          <div className="field"><label>{t('behavior.topP')}</label>
            <input type="number" step={0.05} min={0} max={1} value={settings.topP} onChange={(e) => settings.set('topP', Math.min(1, Math.max(0, Number(e.target.value) || 1)))} /></div>
        </div>
        <div className="field">
          <label>{t('behavior.system')}</label>
          <textarea rows={4} value={settings.defaultSystem} onChange={(e) => settings.set('defaultSystem', e.target.value)} />
        </div>
        <div className="row" style={{ gap: 18 }}>
          <label className="toggle"><input type="checkbox" checked={settings.thinkingEnabled} onChange={(e) => settings.set('thinkingEnabled', e.target.checked)} /> <Icon name="brain" size={14} /> {t('chat.think')}</label>
          <label className="toggle"><input type="checkbox" checked={settings.toolsEnabled} onChange={(e) => settings.set('toolsEnabled', e.target.checked)} /> <Icon name="tools" size={14} /> {t('chat.tools')}</label>
          <label className="toggle"><input type="checkbox" checked={settings.memoryEnabled} onChange={(e) => settings.set('memoryEnabled', e.target.checked)} /> <Icon name="memory" size={14} /> Memory</label>
        </div>
      </div>
    </div>
  );
}

// ---------------- agent.md ----------------

function AgentMdSection() {
  const t = useT();
  const settings = useSettings();
  const ui = useUi();
  const [val, setVal] = useState<string | null>(null);
  const value = val === null ? settings.agentMd : val;

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="file" size={18} /> agent.md</h1>
      <div className="subtitle">{t('agentmd.sub')}</div>
      <div className="card">
        <textarea rows={16} value={value} placeholder={'# My agent rules\n- Always answer in English\n- Prefer concise prose…'} onChange={(e) => setVal(e.target.value)} />
        <div style={{ marginTop: 10 }}>
          <button className="primary" disabled={val === null} onClick={async () => {
            settings.set('agentMd', value);
            ui.toast(t('agentmd.saved'), 'ok');
            setVal(null);
          }}><Icon name="check" size={14} /> {t('agentmd.save')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Skills ----------------

function SkillsSection() {
  const t = useT();
  const { skills } = useData();
  const ui = useUi();
  const [sel, setSel] = useState<string | null>(null);
  const current = skills.find((s) => s.id === sel) || null;
  const [draft, setDraft] = useState<{ name: string; content: string }>({ name: '', content: '' });

  useEffect(() => {
    if (current) setDraft({ name: current.name, content: current.content });
  }, [sel]);

  async function save() {
    await dbCall('saveSkill', { id: current?.id || uid(), name: draft.name || 'Untitled skill', content: draft.content, enabled: current ? Number(current.enabled) === 1 : true });
    await useData.getState().load();
    ui.toast(t('toast.saved'), 'ok');
  }

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="bolt" size={18} /> {t('settings.skills')}</h1>
      <div className="subtitle">{t('skills.sub')}</div>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="primary" onClick={async () => { await dbCall('saveSkill', { id: uid(), name: 'New skill', content: '', enabled: 1 }); await useData.getState().load(); }}><Icon name="plus" size={14} /> {t('skills.add')}</button>
        </div>
        {skills.map((s) => (
          <div className="list-row" key={s.id} onClick={() => setSel(s.id)} style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={Number(s.enabled) === 1} onClick={(e) => e.stopPropagation()}
              onChange={async (e) => { await dbCall('saveSkill', { id: s.id, name: s.name, content: s.content, enabled: e.target.checked }); await useData.getState().load(); }} />
            <div className="t">{s.name}</div>
            <button className="small" onClick={(e) => { e.stopPropagation(); setSel(s.id); }}><Icon name="pencil" size={13} /></button>
            <button className="small danger" onClick={async (e) => { e.stopPropagation(); await dbCall('deleteSkill', { id: s.id }); if (sel === s.id) setSel(null); await useData.getState().load(); }}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
      {current && (
        <div className="card">
          <div className="field"><label>{t('skills.name')}</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="field"><label>{t('skills.content')}</label>
            <textarea rows={8} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></div>
          <button className="primary" onClick={save}><Icon name="check" size={14} /> {t('skills.save')}</button>
        </div>
      )}
    </div>
  );
}

// ---------------- Plugins ----------------

function PluginsSection({ logs, reloadLogs }: { logs: string[]; reloadLogs: () => void }) {
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
    <div>
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
        <div style={{ marginTop: 12 }}>
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

function AutomationsSection() {
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
    <div>
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

// ---------------- MCP ----------------

// Curated MCP servers users most commonly want. One click adds a pre-filled,
// disabled row they can edit and enable.
const MCP_RECOMMENDATIONS = [
  { name: 'Filesystem', desc: 'Read/write files in a folder you allowlist', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","C:\\path\\to\\folder"]' },
  { name: 'Memory', desc: 'Persistent knowledge graph the model can query', command: 'npx', args: '["-y","@modelcontextprotocol/server-memory"]' },
  { name: 'Fetch', desc: 'Fetch web pages and convert to markdown', command: 'npx', args: '["-y","@modelcontextprotocol/server-fetch"]' },
  { name: 'Git', desc: 'Inspect and operate on a local git repo', command: 'npx', args: '["-y","@modelcontextprotocol/server-git"]' },
  { name: 'SQLite', desc: 'Query a local SQLite database', command: 'npx', args: '["-y","@modelcontextprotocol/server-sqlite","C:\\path\\to\\data.db"]' },
  { name: 'Puppeteer', desc: 'Drive a headless browser', command: 'npx', args: '["-y","@modelcontextprotocol/server-puppeteer"]' }
];

function McpSection() {
  const t = useT();
  const { mcpServers } = useData();
  const [rows, setRows] = useState<McpRow[]>([]);

  useEffect(() => setRows(mcpServers.map((m) => ({ ...m }))), [mcpServers]);

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="server" size={18} /> {t('settings.mcp')}</h1>
      <div className="subtitle">{t('mcp.sub')}</div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('mcp.recommended')}</h3>
        <div className="mcp-recs">
          {MCP_RECOMMENDATIONS.filter((r) => !mcpServers.some((m) => m.name === r.name)).map((r) => (
            <button key={r.name} className="mcp-rec" onClick={async () => {
              await dbCall('saveMcpServer', { id: uid(), name: r.name, command: r.command, args: r.args, enabled: 0 });
              await useData.getState().load();
            }}>
              <span className="mcp-rec-name"><Icon name="server" size={13} /> {r.name}</span>
              <span className="mcp-rec-desc">{r.desc}</span>
              <span className="mcp-rec-add"><Icon name="plus" size={12} /> {t('mcp.add')}</span>
            </button>
          ))}
          {MCP_RECOMMENDATIONS.every((r) => mcpServers.some((m) => m.name === r.name)) && (
            <div className="hint">{t('mcp.allAdded')}</div>
          )}
        </div>
      </div>
      <div className="card">
        <button className="primary" style={{ marginBottom: 10 }} onClick={async () => {
          await dbCall('saveMcpServer', { id: uid(), name: 'new-server', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","/path/to/dir"]', enabled: 1 });
          await useData.getState().load();
        }}><Icon name="plus" size={14} /> {t('mcp.add')}</button>
        {rows.map((m) => (
          <div className="provider-card" key={m.id}>
            <div className="head">
              <input type="checkbox" checked={Number(m.enabled) === 1}
                onChange={async (e) => { await dbCall('saveMcpServer', { id: m.id, name: m.name, command: m.command, args: m.args, enabled: e.target.checked }); await useData.getState().load(); }} />
              <input style={{ flex: 1 }} value={m.name} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)))} />
              <button className="small primary" onClick={async () => {
                let args = m.args || '[]';
                try { JSON.parse(args); } catch { args = '[]'; } // persist valid JSON only
                await dbCall('saveMcpServer', { id: m.id, name: m.name, command: m.command, args, enabled: Number(m.enabled) === 1 });
                await useData.getState().load();
              }}><Icon name="check" size={13} /></button>
              <button className="small danger" onClick={async () => { await dbCall('deleteMcpServer', { id: m.id }); await useData.getState().load(); }}><Icon name="trash" size={13} /></button>
            </div>
            <div className="grid">
              <div>
                <label>{t('mcp.command')}</label>
                <input value={m.command} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, command: e.target.value } : x)))} />
              </div>
              <div>
                <label>{t('mcp.args')}</label>
                <input value={m.args} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, args: e.target.value } : x)))} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Data ----------------

function DataSection({ appInfo }: { appInfo: AppInfo | null }) {
  const t = useT();
  const ui = useUi();
  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="folder" size={18} /> {t('settings.data')}</h1>
      <div className="subtitle">{t('data.sub')}</div>
      <div className="card">
        <label>{t('data.location')}</label>
        <code>{appInfo?.dataPath || '…'}</code>
        <div className={`enc-badge ${appInfo?.encryption ? 'on' : 'off'}`}>
          <span className="enc-dot" />
          <div className="enc-text">
            <b>{t('data.encTitle')}</b>
            <span>{appInfo?.encryption ? t('data.encOn') : t('data.encOff')}</span>
            {!appInfo?.encryption && <span className="hint">{t('data.encHint')}</span>}
          </div>
        </div>
        <hr />
        <button className="danger" onClick={async () => {
          if (!(await confirmDialog({ title: t('data.resetConfirm'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
          await dbCall('resetAll');
          await useData.getState().load();
          await useSettings.getState().load(); // in-memory settings must match wiped DB
          ui.toast(t('data.resetDone'), 'ok');
        }}>{t('data.reset')}</button>
      </div>
      <div className="card">
        <h3>{t('about.donate')}</h3>
        <div className="row" style={{ gap: 8 }}>
          {DONATE_LINKS.map((d, i) => (
            <button key={d.id} className={i === 0 ? 'primary' : ''} onClick={() => window.inkwell.openExternal(d.url)}>
              <Icon name={d.id === 'saweria' ? 'heart' : 'donate'} size={14} /> {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
