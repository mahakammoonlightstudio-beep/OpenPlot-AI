import { useState } from 'react';
import { useSettings, ModelOverride, modelOverrideKey } from '../store';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Modal, Switch } from './Ui';
import { Provider } from '../types';

const CONTEXT_PRESETS = [8192, 16384, 32768, 65536, 131072, 200000, 1000000];

/**
 * "Edit model settings" modal (image 1): Smart configuration toggle,
 * model id, context window + max output tokens, and an Advanced section
 * (temperature / top-p / thinking budget). Values are saved PER MODEL into
 * `settings.modelOverrides` so every model can have its own profile.
 * `onSave` receives null when Smart configuration resets everything.
 */
export function ModelSettingsModal({
  provider,
  model,
  onClose,
  onSave,
}: {
  provider: Provider;
  model: string;
  onClose: () => void;
  onSave: (ov: ModelOverride | null) => void;
}) {
  const t = useT();
  const settings = useSettings();
  const key = modelOverrideKey(provider.id, model);
  const saved: ModelOverride = settings.modelOverrides[key] || {};
  const savedSmart = saved.context === undefined && saved.maxTokens === undefined && saved.temperature === undefined && saved.topP === undefined && saved.thinkBudget === undefined;

  const [smart, setSmart] = useState(savedSmart);
  const [ctx, setCtx] = useState<number | ''>(saved.context ?? '');
  const [maxTok, setMaxTok] = useState<number | ''>(saved.maxTokens ?? '');
  const [temp, setTemp] = useState<number | ''>(saved.temperature ?? '');
  const [topP, setTopP] = useState<number | ''>(saved.topP ?? '');
  const [budget, setBudget] = useState<number | ''>(saved.thinkBudget ?? '');
  const [advanced, setAdvanced] = useState(
    saved.temperature !== undefined || saved.topP !== undefined || saved.thinkBudget !== undefined
  );

  const dirty =
    smart !== savedSmart ||
    ctx !== (saved.context ?? '') ||
    maxTok !== (saved.maxTokens ?? '') ||
    temp !== (saved.temperature ?? '') ||
    topP !== (saved.topP ?? '') ||
    budget !== (saved.thinkBudget ?? '');

  function save() {
    if (smart) {
      onSave(null); // smart = remove per-model overrides entirely
      return;
    }
    const ov: ModelOverride = {};
    if (ctx !== '') ov.context = Number(ctx);
    if (maxTok !== '') ov.maxTokens = Number(maxTok);
    if (temp !== '') ov.temperature = Number(temp);
    if (topP !== '') ov.topP = Number(topP);
    if (budget !== '') ov.thinkBudget = Number(budget);
    onSave(ov);
  }

  return (
    <Modal
      title={t('model.editTitle')}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="link" onClick={() => onSave(null)}>{t('model.resetForm')}</button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>{t('model.cancel')}</button>
          <button className="primary" disabled={!dirty && !smart} onClick={save}>{t('model.save')}</button>
        </>
      }
    >
      <div className="modelset-smart">
        <div className="modelset-smart-label">
          <span className="lbl">{t('model.smart')}</span>
          <span className="hint" title={t('model.smartHint')} aria-label={t('model.smartHint')}><Icon name="memory" size={13} /></span>
        </div>
        <Switch checked={smart} onChange={setSmart} label={t('model.smart')} />
      </div>

      <div className="field">
        <label>{t('model.id')}</label>
        <input value={model} disabled />
      </div>

      <div className="field">
        <label>{t('model.context')}</label>
        <input
          type="number"
          min={1024}
          step={1024}
          placeholder={t('model.contextPh')}
          disabled={smart}
          value={ctx}
          onChange={(e) => setCtx(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
        />
        <div className="chips" style={{ marginTop: 6 }}>
          {CONTEXT_PRESETS.map((c) => (
            <button key={c} className={`chip ${ctx === c ? 'active' : ''}`} disabled={smart} onClick={() => setCtx(c)}>
              {c >= 1000000 ? `${c / 1000000}M` : `${Math.round(c / 1024)}K`}
            </button>
          ))}
        </div>
        <div className="hint">{t('model.contextHint')}</div>
      </div>

      <div className="field">
        <label>{t('model.maxOut')}</label>
        <input
          type="number"
          min={16}
          step={16}
          placeholder={t('model.autoFromSettings').replace('{n}', String(settings.maxTokens))}
          disabled={smart}
          value={maxTok}
          onChange={(e) => setMaxTok(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
        />
        <div className="hint">{t('model.maxOutHint').replace('{n}', String(settings.maxTokens))}</div>
      </div>

      <button className="adv-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} />
        {t('model.advanced')}
      </button>

      {advanced && (
        <div className="modelset-advanced">
          <div className="grid-2">
            <div className="field" style={{ margin: 0 }}>
              <label>{t('model.temp')}</label>
              <input type="number" step={0.05} min={0} max={2} placeholder={String(settings.temperature)} disabled={smart}
                value={temp} onChange={(e) => setTemp(e.target.value === '' ? '' : Number(e.target.value))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>{t('model.topP')}</label>
              <input type="number" step={0.05} min={0} max={1} placeholder={String(settings.topP)} disabled={smart}
                value={topP} onChange={(e) => setTopP(e.target.value === '' ? '' : Number(e.target.value))} />
            </div>
            <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
              <label>{t('model.budget')}</label>
              <input type="number" step={256} min={0} placeholder={String(settings.thinkingBudget)} disabled={smart}
                value={budget} onChange={(e) => setBudget(e.target.value === '' ? '' : Number(e.target.value))} />
              <div className="hint">{t('model.budgetHint')}</div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
