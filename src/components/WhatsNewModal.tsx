import { useEffect, useState } from 'react';
import { useData, useSettings, useUi } from '../store';
import { useT } from '../i18nReact';
import { Modal } from './Ui';
import { Icon } from './Icons';

/** Release notes shown once per version (Task 9). */
const CARDS: Array<{ id: string; guide?: string; route?: string }> = [
  { id: 'files', guide: 'files' },
  { id: 'guide', guide: 'getting-started' },
  { id: 'thinking', guide: 'thinking' },
  { id: 'settings', guide: 'settings' },
  { id: 'skills', guide: 'skills' }
];

/**
 * Opens when the stored `lastSeenVersion` differs from the running version.
 * Dismissing stamps the version, so it appears once — never on every launch.
 */
export function WhatsNewModal() {
  const t = useT();
  const version = useSettings((s) => s.version);
  const lastSeen = useSettings((s) => s.lastSeenVersion);
  const set = useSettings((s) => s.set);
  const navigate = useData((s) => s.navigate);
  const setGuideSlug = useData((s) => s.setGuideSlug);
  const ui = useUi();
  const [forceOpen, setForceOpen] = useState(false);

  // About → “What's new” opens it again without touching the stamp.
  useEffect(() => {
    const open = () => setForceOpen(true);
    window.addEventListener('inkwell:whats-new', open);
    return () => window.removeEventListener('inkwell:whats-new', open);
  }, []);

  const due = !!version && lastSeen !== version;
  const open = forceOpen || due;
  if (!open) return null;

  function close() {
    if (due && version) set('lastSeenVersion', version);
    setForceOpen(false);
  }

  function go(card: { guide?: string; route?: string }) {
    close();
    if (card.guide) {
      setGuideSlug(card.guide);
      navigate('guide');
    } else if (card.route) {
      navigate(card.route);
    } else {
      ui.toast(t('whatsnew.soon'), 'info');
    }
  }

  return (
    <Modal
      title={`${t('whatsnew.title')} ${version || ''}`.trim()}
      onClose={close}
      width={620}
      footer={<button className="primary" onClick={close}>{t('whatsnew.start')}</button>}
    >
      <div className="hint" style={{ marginBottom: 12 }}>{t('whatsnew.sub')}</div>
      <div className="whatsnew-grid">
        {CARDS.map((c) => (
          <div key={c.id} className="whatsnew-card">
            <h4>{t(`whatsnew.${c.id}.t`)}</h4>
            <p>{t(`whatsnew.${c.id}.b`)}</p>
            <button className="ghost" onClick={() => go(c)}>
              <Icon name="sparkle" size={13} /> {t('whatsnew.showMe')}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
