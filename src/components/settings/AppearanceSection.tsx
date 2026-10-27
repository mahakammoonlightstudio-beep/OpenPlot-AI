import { useSettings } from '../../store';
import { useT } from '../../i18nReact';

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
  { id: 'sepia', name: 'Sepia', md: 'Light', sw: ['#f4ecd8', '#e4d6b8', '#8b5e34'] },
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
