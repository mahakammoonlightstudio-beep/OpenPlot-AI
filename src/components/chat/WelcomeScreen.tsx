import { useEffect, useState } from 'react';
import { Icon, IconName } from '../Icons';
import { ModelBadge } from './MessageBubble';
import { ModelStatusBar } from '../ModelStatusBar';
import { useT } from '../../i18nReact';
import { relativeTime } from '../../lib/chatContext';
import { useSettings, DONATE_URL, SAWERIA_URL } from '../../store';
import { greetingFor, openingFor } from '../../lib/greetings';

/**
 * The welcome screen shown when no chat is open. Extracted from ChatView: the
 * cards are pure presentation, and everything that changes data arrives as a
 * callback so the view keeps ownership of chat creation.
 *
 * v1.2.5: it is also the Home screen. A greeting follows the clock, the short
 * opener rotates, and a one-minute tick refreshes relative times and the health
 * strip in place — no reload, no visible restart.
 */
export function WelcomeScreen({
  hasProvider, recentChats, latestChapter, storyCount, effModel, effProvider,
  onStart, onOpenSettings, onSelectChat
}: {
  /** False when no provider is enabled — connecting one leads the grid. */
  hasProvider: boolean;
  recentChats: Array<{ id: string; title: string; updated_at?: number; created_at?: number }>;
  latestChapter: { title: string; project_id: string | null } | null;
  storyCount: number;
  effModel: string | null;
  effProvider: { id: string; name: string } | null;
  onStart: (prompt: string, projectId?: string | null) => void;
  onOpenSettings: () => void;
  onSelectChat: (id: string) => void;
}) {
  const t = useT();
  const lang = useSettings((s) => s.lang);
  // One tick per minute re-renders the greeting, the relative timestamps and
  // the health bar. It is not a data reload: nothing flashes or re-mounts
  // visibly, and no request is sent.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const connectFirst = !hasProvider;
  const cards: Array<{ key: string; icon: IconName; title: string; desc: string; onClick: () => void; primary: boolean }> = [
    {
      key: 'story', icon: 'quill', primary: false,
      title: t('welcome.card.story'), desc: t('welcome.card.storyDesc'),
      onClick: () => onStart(t('welcome.promptStory'))
    },
    {
      key: 'continue', icon: 'book', primary: false,
      title: t('welcome.card.continue'), desc: t('welcome.card.continueDesc'),
      onClick: () => onStart(
        latestChapter
          ? t('welcome.promptContinue').replace('{title}', latestChapter.title)
          : t('welcome.promptContinueNone'),
        latestChapter?.project_id ?? null
      )
    },
    {
      key: 'canon', icon: 'scroll', primary: false,
      title: t('welcome.card.canon'), desc: t('welcome.card.canonDesc'),
      onClick: () => onStart(storyCount ? t('welcome.promptCanon') : t('welcome.promptCanonEmpty'))
    },
    {
      key: 'connect', icon: 'plug', primary: connectFirst,
      title: t('welcome.card.connect'), desc: t('welcome.card.connectDesc'),
      onClick: onOpenSettings
    }
  ];
  const ordered = connectFirst ? [cards[3], ...cards.slice(0, 3)] : cards;

  return (
    <div className="page welcome-page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="welcome-hero">
        <div className="logo-big">Open<span className="ink">Plot</span>&nbsp;AI</div>
        <div className="welcome-greet">
          <b>{greetingFor(lang, now)}</b> · {openingFor(lang, now)}
        </div>
        <p>{t('chat.welcomeSub')}</p>
      </div>
      <div className="welcome-cards">
        {ordered.map((c) => (
          <div
            key={c.key}
            className={`welcome-card ${c.primary ? 'primary' : ''}`}
            role="button"
            tabIndex={0}
            onClick={c.onClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.onClick(); } }}
          >
            <div className="ic"><Icon name={c.icon} size={22} /></div>
            <div className="t">{c.title}</div>
            <div className="d">{c.desc}</div>
          </div>
        ))}
      </div>

      {recentChats.length > 0 && (
        <div className="welcome-recent">
          <div className="wr-label">{t('welcome.recent')}</div>
          <div className="wr-list">
            {recentChats.map((c) => (
              <button key={c.id} className="wr-item" onClick={() => onSelectChat(c.id)}>
                <Icon name="chat" size={13} />
                <span className="wr-title">{c.title}</span>
                <span className="wr-time">{relativeTime(c.updated_at || c.created_at, t)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="welcome-health">
        <span className="wh-label">{t('welcome.modelHealth')}</span>
        {effModel ? (
          <span className="wh-model">
            <ModelBadge model={effModel} />
            {effProvider && <ModelStatusBar key={`${effProvider.id}:${effModel}`} providerId={effProvider.id} model={effModel} />}
          </span>
        ) : (
          <span className="wh-none">
            {t('welcome.noModel')}{' '}
            <button className="link" onClick={onOpenSettings}>{t('welcome.connect')}</button>
          </span>
        )}
      </div>

      <div className="welcome-foot">
        <button className="link" onClick={() => window.inkwell.openExternal(DONATE_URL)}>{t('chat.welcomeDonate')}</button>
        <span>·</span>
        <button className="link" onClick={() => window.inkwell.openExternal(SAWERIA_URL)}>{t('chat.welcomeDonate2')}</button>
      </div>
    </div>
  );
}
