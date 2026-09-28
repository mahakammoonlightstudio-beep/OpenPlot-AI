import { useEffect, useState } from 'react';
import { AppInfo } from '../types';
import { useT } from '../i18nReact';
import { DONATE_LINKS, GITHUB_URL, YOUTUBE_URL, LINKEDIN_URL, TWITTER_URL, STUDIO_NAME } from '../store';
import { Icon, LogoMark } from './Icons';

function FeatureRow({ icon, title, desc }: { icon: Parameters<typeof Icon>[0]['name']; title: string; desc: string }) {
  return (
    <div className="about-feature">
      <div className="af-icon"><Icon name={icon} size={16} /></div>
      <div>
        <div className="af-title">{title}</div>
        <div className="af-desc">{desc}</div>
      </div>
    </div>
  );
}

export function AboutView() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { window.inkwell.appInfo().then(setInfo).catch(() => {}); }, []);

  const socials: Array<{ icon: Parameters<typeof Icon>[0]['name']; label: string; handle: string; url: string }> = [
    { icon: 'github', label: 'GitHub', handle: 'mahakammoonlightstudio-beep', url: GITHUB_URL },
    { icon: 'youtube', label: 'YouTube', handle: '@MahakamMoonlightStudio', url: YOUTUBE_URL },
    { icon: 'linkedin', label: 'LinkedIn', handle: 'Muhammad Fauzan Raffa Al-Habsy', url: LINKEDIN_URL },
    { icon: 'twitter', label: 'X / Twitter', handle: '@MahakamMoocb', url: TWITTER_URL }
  ];

  return (
    <div className="page">
      <div className="page-narrow about-page">
        <div className="about-hero">
          <LogoMark size={56} />
          <div>
            <h1 style={{ margin: 0 }}>OpenPlot AI</h1>
            <div className="subtitle" style={{ margin: '4px 0 0' }}>{t('about.tagline')}</div>
          </div>
          <span className="version-pill">v{info?.version || '1.0.0'}</span>
        </div>

        <div className="card about-meta">
          <div className="meta-grid">
            <div className="meta-item">
              <span className="k"><Icon name="tag" size={13} /> {t('about.version')}</span>
              <code>{info?.version || '1.0.0'}</code>
            </div>
            <div className="meta-item">
              <span className="k"><Icon name="cpu" size={13} /> {t('about.platform')}</span>
              <code>{info?.platform || '—'}</code>
            </div>
            <div className="meta-item wide">
              <span className="k"><Icon name="folder" size={13} /> {t('data.location')}</span>
              <code className="ellipsis" title={info?.dataPath}>{info?.dataPath || '—'}</code>
            </div>
          </div>
          <div className="license-line">
            <Icon name="check" size={13} /> MIT License · <Icon name="memory" size={13} /> {t('about.localFirst')}
          </div>
        </div>

        <div className={`enc-badge ${info?.encryption ? 'on' : 'off'}`}>
          <span className="enc-dot" />
          <div className="enc-text">
            <b>{t('data.encTitle')}</b>
            <span>{info?.encryption ? t('data.encOn') : t('data.encOff')}</span>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('about.featuresTitle')}</h3>
          <div className="about-features">
            <FeatureRow icon="chat" title={t('about.f1t')} desc={t('about.f1d')} />
            <FeatureRow icon="book" title={t('about.f2t')} desc={t('about.f2d')} />
            <FeatureRow icon="server" title={t('about.f3t')} desc={t('about.f3d')} />
            <FeatureRow icon="bolt" title={t('about.f4t')} desc={t('about.f4d')} />
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('about.socialTitle')}</h3>
          <div className="social-grid">
            {socials.map((s) => (
              <a key={s.label} className="social-card" href={s.url} onClick={(e) => { e.preventDefault(); window.inkwell.openExternal(s.url); }}>
                <span className="soc-icon"><Icon name={s.icon} size={17} /></span>
                <span className="soc-text">
                  <span className="soc-label">{s.label}</span>
                  <span className="soc-handle">{s.handle}</span>
                </span>
                <Icon name="chevronRight" size={13} />
              </a>
            ))}
          </div>
        </div>

        <div className="card about-support">
          <div>
            <h3 style={{ margin: '0 0 4px' }}>{t('about.supportTitle')}</h3>
            <p style={{ margin: 0, color: 'var(--text-faint)' }}>{t('about.thanks')}</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {DONATE_LINKS.map((d, i) => (
              <button key={d.id} className={i === 0 ? 'primary' : ''} onClick={() => window.inkwell.openExternal(d.url)}>
                <Icon name={d.id === 'saweria' ? 'heart' : 'donate'} size={14} /> {d.name}
              </button>
            ))}
          </div>
        </div>

        <div className="about-footer">
          <span>{t('about.made')}</span>
          <span className="sep">·</span>
          <button className="link" onClick={() => window.inkwell.openExternal(GITHUB_URL)}>{STUDIO_NAME}</button>
          <span className="sep">·</span>
          <span>© {new Date().getFullYear()} {STUDIO_NAME}</span>
        </div>
      </div>
    </div>
  );
}
