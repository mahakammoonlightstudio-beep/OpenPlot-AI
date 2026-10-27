import { useState } from 'react';
import { useSettings, modelOverrideKey } from '../store';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Provider } from '../types';
import { ModelProfile, resolveModelProfile, smartDefaults } from '../lib/modelCaps';

const modelsOf = (provider: Provider): string[] => (Array.isArray(provider.models) ? provider.models : []);

/** Compact token count for a read-out line (`200k`, `4k`, `512`). */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`;
}

/**
 * The read-out half of the card: four sourced rows, one summary line and the
 * last observed cache hit. Presentational on purpose — the Models table in
 * Settings renders the same rows, and the headless render test feeds it a
 * profile directly instead of reaching into the store.
 */
export function ModelProfileRows({ profile }: { profile: ModelProfile }) {
  const t = useT();

  const modeLabel =
    profile.cache.mode === 'auto' ? t('caps.modeAuto')
      : profile.cache.mode === 'explicit' ? t('caps.modeExplicit')
        : profile.cache.mode === 'none' ? t('caps.modeNone')
          : t('caps.modeUnknown');

  const contextValue = profile.contextTokens ? `~${fmtTok(profile.contextTokens)} tok` : t('caps.unknown');
  const maxOutValue = profile.maxOutputTokens ? `${fmtTok(profile.maxOutputTokens)} tok` : t('caps.unknown');
  const reasoningValue =
    profile.thinking === 'yes' ? t('caps.reasoningYes')
      : profile.thinking === 'no' ? t('caps.reasoningNo')
        : t('caps.reasoningUnknown');
  const cacheValue = profile.cacheCapacityTokens > 0
    ? `${t('caps.cacheUpTo').replace('{n}', fmtTok(profile.cacheCapacityTokens))} · ${modeLabel}`
    : modeLabel;

  const summary = [
    profile.thinking === 'yes' ? t('caps.sum.reasoningYes')
      : profile.thinking === 'no' ? t('caps.sum.reasoningNo')
        : t('caps.sum.reasoningUnknown'),
    profile.cache.mode === 'auto' ? t('caps.sum.cacheAuto')
      : profile.cache.mode === 'explicit' ? t('caps.sum.cacheExplicit')
        : profile.cache.mode === 'none' ? t('caps.sum.cacheNone')
          : t('caps.sum.cacheUnknown'),
    profile.contextTokens
      ? t('caps.sum.context').replace('{n}', String(profile.contextTokens))
      : t('caps.sum.contextUnknown'),
  ].join(' ');

  return (
    <>
      <dl className="caps-rows">
        <dt>{t('caps.rowContext')}</dt>
        <dd>{contextValue}</dd>
        <dt>{t('caps.rowMaxOut')}</dt>
        <dd>
          {maxOutValue}
          {profile.maxOutputFromDefault && <span className="caps-badge"> {t('caps.fromDefault')}</span>}
        </dd>
        <dt>{t('caps.rowReasoning')}</dt>
        <dd>{reasoningValue}</dd>
        <dt>{t('caps.rowCache')}</dt>
        <dd>{cacheValue}</dd>
      </dl>

      <div className="caps-summary">{summary}</div>

      {profile.observedCachedTokens !== null && profile.observedCachedTokens > 0 && (
        <div className="caps-observed">
          <Icon name="check" size={12} /> {t('caps.observed').replace('{n}', String(profile.observedCachedTokens))}
        </div>
      )}
      {profile.probedAt && <div className="hint">{t('caps.verifiedHint')}</div>}
    </>
  );
}

/**
 * Smart configuration card for one model (v1.2.3, Task 2 UI).
 *
 * Shows the four numbers a user actually needs — context window, max output,
 * whether reasoning is exposed, and how prompt caching works — plus one plain
 * summary line. Every value is sourced (per-model override → last probe →
 * model family) and `unknown` is rendered as unknown; this card never invents a
 * number just to fill a row.
 *
 * The Verify button runs the real capability probe and persists it in the main
 * process, so the answer survives closing Settings and restarting the app.
 */
export function ModelCapabilityCard({
  provider,
  preferredModel,
}: {
  provider: Provider;
  preferredModel?: string | null;
}) {
  const t = useT();
  const settings = useSettings();
  const models = modelsOf(provider);
  const [picked, setPicked] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefer the app's default model when this provider serves it, otherwise the
  // provider's first model. The select only appears when there is a choice.
  const initial = preferredModel && models.includes(preferredModel) ? preferredModel : models[0] || '';
  const model = picked && models.includes(picked) ? picked : initial;
  const key = modelOverrideKey(provider.id, model);
  const record = settings.modelCaps[key];
  const profile = resolveModelProfile({
    model,
    kind: provider.kind || 'auto',
    baseUrl: provider.baseUrl,
    record,
    override: settings.modelOverrides[key],
    defaultMaxTokens: settings.maxTokens,
  });

  async function verify() {
    setVerifying(true);
    setError(null);
    try {
      const res = await window.inkwell.probeCapabilities({ ...provider, kind: provider.kind || 'auto' }, model);
      const data = res.ok ? res.data : undefined;
      if (!data) {
        setError(res.error || t('caps.fail'));
        return;
      }
      if (!data.ok) setError(data.error || t('caps.fail'));
      // Main already wrote the registry; refresh the store so the card (and
      // every other consumer of the capability) sees the new evidence.
      await useSettings.getState().load();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setVerifying(false);
    }
  }

  function applySmart() {
    const caps = useSettings.getState().modelCaps[key]?.caps;
    if (!caps?.ok) return;
    // Smart Mode: align the chat defaults with what the model can actually do.
    // The mapping lives in modelCaps.ts so Settings → Models applies exactly the
    // same rules when Smart defaults is on.
    const s = useSettings.getState();
    const changes = smartDefaults(caps, { kind: provider.kind || 'auto' });
    for (const [k, v] of Object.entries(changes)) s.set(k as any, v as any);
  }

  return (
    <div className="caps-card">
      <div className="caps-card-head">
        <span className="lbl"><Icon name="cpu" size={13} /> {t('caps.cardTitle')}</span>
        {models.length > 1 && (
          <select
            value={model}
            aria-label={t('caps.chooseModel')}
            onChange={(e) => { setPicked(e.target.value); setError(null); }}
          >
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>

      <ModelProfileRows profile={profile} />

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="small" onClick={verify} disabled={verifying || !model}>
          <Icon name="cpu" size={13} />{' '}
          {verifying ? t('caps.verifying') : profile.probedAt ? t('caps.reverify') : t('caps.verify')}
        </button>
        {record?.caps?.ok && (
          <button className="small primary" onClick={applySmart} title={t('caps.applyHint')}>
            <Icon name="bolt" size={13} /> {t('caps.apply')}
          </button>
        )}
      </div>

      {record?.caps && !record.caps.ok && (
        <span className="key-result bad">
          <Icon name="x" size={12} /> {record.caps.error || t('caps.fail')}
        </span>
      )}
      {error && (
        <span className="key-result bad">
          <Icon name="x" size={12} /> {error}
        </span>
      )}
    </div>
  );
}
