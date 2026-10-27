import { useSettings } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';

// ---------------- Behavior ----------------
export function BehaviorSection({ mode }: { mode?: 'simple' | 'advanced' }) {
  const t = useT();
  const settings = useSettings();
  const advanced = (mode ?? settings.settingsMode) === 'advanced';
  return (
    <div>
      <h1>{t('settings.behavior')}</h1>
      <div className="subtitle">{t('behavior.sub')}</div>
      <div className="card">
        <div className="field" id="set-author-name">
          <label>{t('behavior.authorName')}</label>
          <input value={settings.authorName} onChange={(e) => settings.set('authorName', e.target.value)} placeholder={t('behavior.authorPh')} />
          <div className="hint">{t('behavior.authorHint')}</div>
        </div>
        <div className="field" id="set-temperature">
          <label>{t('behavior.temperature')}: {settings.temperature.toFixed(2)}</label>
          <input type="range" min={0} max={2} step={0.05} value={settings.temperature} onChange={(e) => settings.set('temperature', Number(e.target.value))} />
        </div>
        <div className="grid-2">
          <div className="field" id="set-max-tokens"><label>{t('behavior.maxTokens')}</label>
            <input type="number" min={64} max={200000} value={settings.maxTokens} onChange={(e) => settings.set('maxTokens', Math.max(64, Number(e.target.value) || 4096))} /></div>
          {advanced && (
            <div className="field" id="set-top-p"><label>{t('behavior.topP')}</label>
              <input type="number" step={0.05} min={0} max={1} value={settings.topP} onChange={(e) => settings.set('topP', Math.min(1, Math.max(0, Number(e.target.value) || 1)))} /></div>
          )}
        </div>
        <div className="field" id="set-default-system">
          <label>{t('behavior.system')}</label>
          <textarea rows={4} value={settings.defaultSystem} onChange={(e) => settings.set('defaultSystem', e.target.value)} />
        </div>
        <div className="row" style={{ gap: 18 }} id="set-thinking-enabled">
          <label className="toggle"><input type="checkbox" checked={settings.thinkingEnabled} onChange={(e) => settings.set('thinkingEnabled', e.target.checked)} /> <Icon name="brain" size={14} /> {t('chat.think')}</label>
          <label className="toggle"><input type="checkbox" checked={settings.toolsEnabled} onChange={(e) => settings.set('toolsEnabled', e.target.checked)} /> <Icon name="tools" size={14} /> {t('chat.tools')}</label>
          <label className="toggle"><input type="checkbox" checked={settings.memoryEnabled} onChange={(e) => settings.set('memoryEnabled', e.target.checked)} /> <Icon name="memory" size={14} /> Memory</label>
        </div>
        {advanced && (
          <div className="field" id="set-thinking-budget" style={{ marginTop: 12 }}>
            <label>{t('behavior.thinkingBudget')}</label>
            <input
              type="number"
              min={1024}
              max={100000}
              step={256}
              value={settings.thinkingBudget}
              onChange={(e) => settings.set('thinkingBudget', Math.min(100000, Math.max(1024, Number(e.target.value) || 4096)))}
            />
            <div className="hint">{t('behavior.thinkingBudgetHint')}</div>
          </div>
        )}
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div className="field" id="set-thinking-display"><label>{t('think.displayLabel')}</label>
            <select value={settings.thinkingDisplay} onChange={(e) => settings.set('thinkingDisplay', e.target.value as any)}>
              <option value="auto">{t('think.display.auto')}</option>
              <option value="expanded">{t('think.display.expanded')}</option>
              <option value="collapsed">{t('think.display.collapsed')}</option>
            </select></div>
          <div className="field" id="set-thinking-ui"><label>{t('think.uiLabel')}</label>
            <select value={settings.thinkingUi} onChange={(e) => settings.set('thinkingUi', e.target.value as any)}>
              <option value="auto">{t('think.ui.auto')}</option>
              <option value="always">{t('think.ui.always')}</option>
            </select>
            <div className="hint">{t('think.uiHint')}</div></div>
        </div>
      </div>
    </div>
  );
}
