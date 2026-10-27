import { useState } from 'react';
import { useData, useSettings, useUi, modelOverrideKey } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { Switch } from '../Ui';
import { ModelSettingsModal } from '../ModelSettingsModal';
import { resolveModelProfile, smartDefaults } from '../../lib/modelCaps';
import type { Provider } from '../../types';

const keyOf = (providerId: string, model: string) => `${providerId}::${model}`;

function fmt(n: number | null | undefined): string {
  if (!n) return '—';
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`;
}

/**
 * Settings → Models (v1.2.3 Task 6).
 *
 * One table instead of a modal treasure hunt: every connected model with the
 * four capabilities the app actually acts on, plus Edit / Verify / Set default.
 * Values come from `resolveModelProfile`, so this table can never disagree with
 * the card in Providers or the composer.
 */
export function ModelsSection() {
  const t = useT();
  const ui = useUi();
  const settings = useSettings();
  const providers = useData((s) => s.providers);
  const [editing, setEditing] = useState<{ provider: Provider; model: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const rows = providers.flatMap((p) =>
    (Array.isArray(p.models) ? p.models : []).map((m) => ({ provider: p, model: m }))
  );
  const currentRef = settings.defaultModelRef;
  const selected = currentRef ? keyOf(currentRef.providerId, currentRef.model) : '';

  /** Apply the probe-derived defaults (only when the user asked for them). */
  function applySmart(providerId: string, model: string) {
    if (!settings.smartDefaults) return;
    const caps = useSettings.getState().modelCaps[keyOf(providerId, model)]?.caps;
    if (!caps?.ok) return;
    const changes = smartDefaults(caps, { kind: providers.find((p) => p.id === providerId)?.kind || 'auto' });
    const s = useSettings.getState();
    for (const [k, v] of Object.entries(changes)) s.set(k as any, v as any);
  }

  function setDefault(providerId: string, model: string) {
    const s = useSettings.getState();
    s.set('defaultModelRef', { providerId, model });
    s.set('defaultModel', model);
    applySmart(providerId, model);
    ui.toast(t('models.defaultSet').replace('{model}', model), 'ok');
  }

  async function verify(provider: Provider, model: string) {
    const key = keyOf(provider.id, model);
    setBusy(key);
    setErrors((prev) => { const next = { ...prev }; delete next[key]; return next; });
    try {
      const res = await window.inkwell.probeCapabilities({ ...provider, kind: provider.kind || 'auto' }, model);
      if (!res.ok || !res.data?.ok) {
        const message = res.error || res.data?.error || t('caps.fail');
        setErrors((prev) => ({ ...prev, [key]: message }));
        return;
      }
      await useSettings.getState().load();
      if (settings.defaultModelRef && keyOf(settings.defaultModelRef.providerId, settings.defaultModelRef.model) === key) {
        applySmart(provider.id, model);
      }
    } catch (err: any) {
      setErrors((prev) => ({ ...prev, [key]: err?.message || String(err) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="cpu" size={18} /> {t('settings.models')}</h1>
      <div className="subtitle">{t('models.sub')}</div>

      <div className="card">
        <div className="field" id="set-default-model">
          <label>{t('models.default')}</label>
          <select
            value={selected}
            onChange={(e) => {
              if (!e.target.value) {
                const s = useSettings.getState();
                s.set('defaultModelRef', null);
                s.set('defaultModel', null);
                return;
              }
              const [providerId, ...rest] = e.target.value.split('::');
              setDefault(providerId, rest.join('::'));
            }}
          >
            <option value="">{t('models.auto')}</option>
            {providers.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {(Array.isArray(p.models) ? p.models : []).map((m) => (
                  <option key={m} value={keyOf(p.id, m)}>{m}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="hint">{t('models.defaultHint')}</div>
        </div>
        <div className="models-smart" id="set-smart-defaults">
          <div>
            <b>{t('models.smartDefaults')}</b>
            <div className="hint">{t('models.smartDefaultsHint')}</div>
          </div>
          <Switch
            checked={settings.smartDefaults}
            onChange={(v) => settings.set('smartDefaults', v)}
            label={t('models.smartDefaults')}
          />
        </div>
      </div>

      <div className="card" id="set-model-table">
        {rows.length === 0 ? (
          <div className="empty-state" style={{ minHeight: 160 }}>
            <div>{t('models.none')}</div>
          </div>
        ) : (
          <table className="model-table">
            <thead>
              <tr>
                <th>{t('chat.model')}</th>
                <th>{t('caps.rowContext')}</th>
                <th>{t('caps.rowMaxOut')}</th>
                <th>{t('caps.rowReasoning')}</th>
                <th>{t('caps.rowCache')}</th>
                <th aria-label={t('models.actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ provider, model }) => {
                const key = keyOf(provider.id, model);
                const profile = resolveModelProfile({
                  model,
                  kind: provider.kind || 'auto',
                  baseUrl: provider.baseUrl,
                  record: settings.modelCaps[key],
                  override: settings.modelOverrides[key],
                  defaultMaxTokens: settings.maxTokens,
                });
                const isDefault = selected === key;
                const cacheLabel =
                  profile.cache.mode === 'auto' ? t('caps.modeAuto')
                    : profile.cache.mode === 'explicit' ? t('caps.modeExplicit')
                      : profile.cache.mode === 'none' ? t('caps.modeNone')
                        : t('caps.modeUnknown');
                return (
                  <tr key={key} className={isDefault ? 'is-default' : ''}>
                    <td className="mm">
                      <code>{model}</code>
                      <small>{provider.name}</small>
                    </td>
                    <td className="mono">{profile.contextTokens ? `~${fmt(profile.contextTokens)}` : '—'}</td>
                    <td className="mono">
                      {fmt(profile.maxOutputTokens)}
                      {profile.maxOutputFromDefault && <small className="dim"> {t('caps.fromDefault')}</small>}
                    </td>
                    <td>
                      <span className={`reason-dot ${profile.thinking}`} title={t('caps.rowReasoning')}>
                        {profile.thinking === 'yes' ? '✓' : profile.thinking === 'no' ? '✕' : '?'}
                      </span>
                    </td>
                    <td className="dim">{cacheLabel}</td>
                    <td className="acts">
                      {!isDefault && (
                        <button className="small ghost" onClick={() => setDefault(provider.id, model)}>
                          {t('models.setDefault')}
                        </button>
                      )}
                      <button
                        className="small"
                        onClick={() => verify(provider, model)}
                        disabled={busy === key}
                        title={t('caps.verify')}
                        aria-label={t('caps.verify')}
                      >
                        <Icon name="bolt" size={12} /> {busy === key ? '…' : t('caps.verify')}
                      </button>
                      <button className="small" onClick={() => setEditing({ provider, model })} title={t('models.edit')} aria-label={t('models.edit')}>
                        <Icon name="pencil" size={12} />
                      </button>
                      {errors[key] && <span className="key-result bad" title={errors[key]}><Icon name="x" size={12} /></span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <ModelSettingsModal
          provider={editing.provider}
          model={editing.model}
          onClose={() => setEditing(null)}
          onSave={(ov) => {
            const mo = { ...useSettings.getState().modelOverrides };
            const k = modelOverrideKey(editing.provider.id, editing.model);
            if (ov) mo[k] = ov; else delete mo[k];
            useSettings.getState().set('modelOverrides', mo);
            setEditing(null);
            ui.toast(t('toast.saved'), 'ok');
          }}
        />
      )}
    </div>
  );
}
