import { useEffect, useState } from 'react';
import { FEEDBACK_EMAIL, STUDIO_NAME, DONATE_LINKS } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import type { AppInfo } from '../../types';

/**
 * Settings → About: the facts a user needs when something goes wrong — version,
 * where the data lives, whether API keys are encrypted at rest, the license, and
 * one address that actually reaches a human.
 */
export function AboutSection() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    window.inkwell.appInfo().then(setInfo).catch(() => {});
  }, []);

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="file" size={18} /> {t('settings.about')}</h1>
      <div className="subtitle">{STUDIO_NAME}</div>

      <div className="card" id="set-about-version">
        <div className="about-row">
          <span className="k">{t('about.version')}</span>
          <code>{info?.version || '…'}</code>
        </div>
        <div className="about-row">
          <span className="k">{t('about.platform')}</span>
          <code>{info?.platform || '…'}</code>
        </div>
        <div className="about-row">
          <span className="k">{t('data.location')}</span>
          <code className="ellipsis" title={info?.dataPath}>{info?.dataPath || '…'}</code>
        </div>
        <div className="about-row">
          <span className="k">{t('about.license')}</span>
          <code>MIT</code>
        </div>
      </div>

      <div className="card" id="set-about-vault">
        <div className={`enc-badge ${info?.encryption ? 'on' : 'off'}`}>
          <span className="enc-dot" />
          <div className="enc-text">
            <b>{t('about.vault')}</b>
            <span>{info?.encryption ? t('data.encOn') : t('data.encOff')}</span>
            <span className="hint">{t('about.vaultHint')}</span>
          </div>
        </div>
      </div>

      <div className="card" id="set-feedback-email">
        <h3 style={{ marginTop: 0 }}>{t('about.feedback')}</h3>
        <div className="hint" style={{ marginBottom: 8 }}>{t('about.feedbackHint')}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <a className="mailto" href={`mailto:${FEEDBACK_EMAIL}`} onClick={(e) => { e.preventDefault(); window.inkwell.openExternal(`mailto:${FEEDBACK_EMAIL}`); }}>
            <Icon name="send" size={13} /> {FEEDBACK_EMAIL}
          </a>
          <button
            className="small ghost"
            onClick={() => { navigator.clipboard?.writeText(FEEDBACK_EMAIL).catch(() => {}); }}
            title={t('about.copyEmail')}
          >
            {t('about.copyEmail')}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('about.donate')}</h3>
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
