import { useSettings } from '../../store';
import { useT } from '../../i18nReact';
import { LANGS, type Lang } from '../../i18n';
import { UI_FONTS, sanitizeFontFamily, uiFontStack } from '../../lib/appearance';

// ---------------- Appearance ----------------
const THEMES = [
  { id: 'dark-classic', name: 'Dark Classic', md: 'Dark', sw: ['#0b0d12', '#171b26', '#7c5cff'] },
  { id: 'midnight-ink', name: 'Midnight Ink', md: 'Dark', sw: ['#07090f', '#111522', '#7c5cff'] },
  { id: 'nord', name: 'Nord', md: 'Dark', sw: ['#2e3440', '#434c5e', '#88c0d0'] },
  { id: 'dracula', name: 'Dracula', md: 'Dark', sw: ['#282a36', '#343746', '#bd93f9'] },
  { id: 'solarized', name: 'Solarized', md: 'Dark', sw: ['#002b36', '#0a4250', '#b58900'] },
  { id: 'forest', name: 'Forest', md: 'Dark', sw: ['#0f1a14', '#1c2d23', '#3ddc84'] },
  { id: 'rose-dawn', name: 'Rose Dawn', md: 'Dark', sw: ['#1c1116', '#301e28', '#ff6f91'] },
  { id: 'ocean', name: 'Ocean', md: 'Dark', sw: ['#0a1520', '#142839', '#4cc9f0'] },
  { id: 'gruvbox', name: 'Gruvbox', md: 'Dark', sw: ['#1d2021', '#32302f', '#fabd2f'] },
  { id: 'catppuccin', name: 'Catppuccin', md: 'Dark', sw: ['#1e1e2e', '#313244', '#cba6f7'] },
  { id: 'sepia', name: 'Sepia', md: 'Light', sw: ['#f4ecd8', '#e4d6b8', '#8b5e34'] },
  { id: 'sandstone', name: 'Sandstone', md: 'Light', sw: ['#f7f2ea', '#efe6d8', '#b45309'] },
  { id: 'light-paper', name: 'Light Paper', md: 'Light', sw: ['#f7f7f5', '#f1f1ee', '#7048e8'] }
];

const ACCENTS = ['#7c5cff', '#4cc9f0', '#3ddc84', '#ffb703', '#ff6f91', '#e5484d', '#f5a623', '#06b6d4', '#8b5e34', '#e8e8e8'];

export function AppearanceSection() {
  const t = useT();
  const settings = useSettings();
  return (
    <div>
      <h1>{t('settings.appearance')}</h1>
      <div className="subtitle">{t('appearance.sub')}</div>
      <div className="card" id="set-theme">
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
      <div className="card" id="set-ui-font">
        <h3>{t('appearance.uiFont')}</h3>
        <div className="font-grid">
          {UI_FONTS.map((font) => (
            <button
              key={font.id}
              className={`font-choice ${settings.uiFont === font.id ? 'active' : ''}`}
              onClick={() => settings.set('uiFont', font.id)}
              title={font.preview}
            >
              <b style={{ fontFamily: uiFontStack(font.id, settings.uiFontCustom) }}>Aa</b>
              <span>{t(font.labelKey)}</span>
            </button>
          ))}
        </div>
        {settings.uiFont === 'custom' && (
          <div className="field" style={{ marginTop: 10 }}>
            <label>{t('appearance.font.customHint')}</label>
            <input
              value={settings.uiFontCustom}
              onChange={(e) => settings.set('uiFontCustom', sanitizeFontFamily(e.target.value))}
              placeholder="'Atkinson Hyperlegible', 'Segoe UI', sans-serif"
              maxLength={160}
            />
          </div>
        )}
        <div className="font-sample" style={{ fontFamily: uiFontStack(settings.uiFont, settings.uiFontCustom) }}>
          {t('appearance.font.sample')}
        </div>
        <div className="hint">{t('appearance.uiFontHint')}</div>
      </div>

      <div className="card" id="set-ui-layout">
        <h3>{t('appearance.uiLayout')}</h3>
        <div className="field">
          <label>{t('appearance.uiScale')}: {Math.round(settings.uiScale * 100)}%</label>
          <input
            type="range" min={85} max={125} step={5}
            value={Math.round(settings.uiScale * 100)}
            onChange={(e) => settings.set('uiScale', Number(e.target.value) / 100)}
            style={{ width: 260 }}
          />
          <div className="hint">{t('appearance.uiScaleHint')}</div>
        </div>
        <div className="field">
          <label>{t('appearance.density')}</label>
          <select
            value={settings.uiDensity}
            onChange={(e) => settings.set('uiDensity', e.target.value as 'comfortable' | 'compact')}
            style={{ maxWidth: 280 }}
          >
            <option value="comfortable">{t('appearance.density.comfortable')}</option>
            <option value="compact">{t('appearance.density.compact')}</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>{t('appearance.radius')}: {settings.uiRadius}px</label>
          <input
            type="range" min={4} max={18}
            value={settings.uiRadius}
            onChange={(e) => settings.set('uiRadius', Number(e.target.value))}
            style={{ width: 260 }}
          />
        </div>
      </div>

      <div className="card" id="set-language">
        <h3>{t('appearance.language')}</h3>
        <select
          value={settings.lang}
          onChange={(e) => settings.set('lang', e.target.value as Lang)}
          style={{ maxWidth: 280 }}
          aria-label={t('appearance.language')}
        >
          {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <div className="hint" style={{ marginTop: 8 }}>{t('appearance.languageHint')}</div>
        {(settings.lang === 'es' || settings.lang === 'hi') && (
          <div className="hint" style={{ marginTop: 4 }}>{t('appearance.languageBeta')}</div>
        )}
      </div>
      <div className="card" id="set-accent">
        <h3>{t('appearance.accent')}</h3>
        <div className="accent-row">
          {ACCENTS.map((c) => (
            <div key={c} className={`accent-dot ${settings.accent === c ? 'active' : ''}`} style={{ background: c }} onClick={() => settings.set('accent', c)} />
          ))}
        </div>
        <div style={{ marginTop: 12 }} id="set-font-size">
          <label>{t('appearance.font')}: {settings.chatFontSize}px</label>
          <input type="range" min={12} max={20} value={settings.chatFontSize} onChange={(e) => settings.set('chatFontSize', Number(e.target.value))} style={{ width: 260 }} />
        </div>
      </div>
      <div className="card" id="set-motion">
        <h3>{t('appearance.motion')}</h3>
        <select
          value={settings.motion}
          onChange={(e) => settings.set('motion', e.target.value as 'system' | 'full' | 'reduced')}
          style={{ maxWidth: 280 }}
        >
          <option value="system">{t('appearance.motion.system')}</option>
          <option value="full">{t('appearance.motion.full')}</option>
          <option value="reduced">{t('appearance.motion.reduced')}</option>
        </select>
        <div className="hint" style={{ marginTop: 8 }}>{t('appearance.motionHint')}</div>
      </div>
    </div>
  );
}
