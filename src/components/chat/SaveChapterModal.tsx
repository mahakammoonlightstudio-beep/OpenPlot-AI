import { Icon } from '../Icons';
import { useT } from '../../i18nReact';
import { Modal } from '../Ui';
import { contentWordCount } from '../../lib/chatContext';

/**
 * "Save to chapter" target picker — new chapter, or append to an existing one.
 * Pure presentation: the save itself stays in ChatView, which owns the
 * project resolution, versioning and word-count bookkeeping.
 */
export function SaveChapterModal({
  chapters, onClose, onConfirm
}: {
  chapters: Array<{ id: string; title: string; content: string }>;
  onClose: () => void;
  onConfirm: (targetId: string) => void;
}) {
  const t = useT();
  return (
    <Modal title={t('chat.saveChapterTitle')} onClose={onClose} width={520}>
      <div className="hint" style={{ marginBottom: 12 }}>{t('chat.saveChapterHint')}</div>
      <button className="primary" style={{ width: '100%', marginBottom: 14 }} onClick={() => onConfirm('new')}>
        <Icon name="plus" size={14} /> {t('chat.saveChapterNew')}
      </button>
      <div className="pick-label">{t('chat.saveChapterAppend')}</div>
      {chapters.length === 0 && <div className="hint">{t('chat.saveChapterNone')}</div>}
      {chapters.map((c) => (
        <button key={c.id} className="pick-chapter-row" onClick={() => onConfirm(c.id)}>
          <span className="t">{c.title}</span>
          <span className="w">{contentWordCount(c.content).toLocaleString()}w</span>
        </button>
      ))}
    </Modal>
  );
}
