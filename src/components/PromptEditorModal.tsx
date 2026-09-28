import { useState } from 'react';
import { useT } from '../i18nReact';
import { Modal } from './Ui';
import { UserPrompt } from '../types';

const CATEGORIES = ['craft', 'bible', 'revise', 'chat'] as const;

/**
 * Create/edit dialog for user-defined Prompt Library entries.
 * `existing === null` creates a new prompt; otherwise edits that row.
 */
export function PromptEditorModal({
  existing,
  seedTemplate,
  onClose,
  onSave,
  onDelete,
}: {
  existing: UserPrompt | null;
  /** Pre-filled template (e.g. "save the composer text as a prompt"). */
  seedTemplate?: string;
  onClose: () => void;
  onSave: (data: { category: string; title: string; template: string }) => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const [category, setCategory] = useState(existing?.category || 'craft');
  const [title, setTitle] = useState(existing?.title || '');
  const [template, setTemplate] = useState(existing?.template || seedTemplate || '');

  const valid = title.trim().length > 0 && template.trim().length > 0;

  return (
    <Modal
      title={existing ? t('prompt.editTitle') : t('prompt.newTitle')}
      onClose={onClose}
      width={560}
      footer={
        <>
          {existing && onDelete && (
            <button className="danger" onClick={onDelete}>
              {t('prompt.delete')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>{t('model.cancel')}</button>
          <button className="primary" disabled={!valid} onClick={() => onSave({ category, title: title.trim(), template })}>
            {t('model.save')}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t('prompt.categoryLabel')}</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{t('prompt.category.' + c)}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{t('prompt.titleLabel')}</label>
        <input
          value={title}
          autoFocus
          placeholder={t('prompt.titlePh')}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid) onSave({ category, title: title.trim(), template }); }}
        />
      </div>
      <div className="field">
        <label>{t('prompt.templateLabel')}</label>
        <textarea
          rows={8}
          value={template}
          placeholder={t('prompt.templatePh')}
          onChange={(e) => setTemplate(e.target.value)}
          style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}
        />
        <div className="hint">{t('prompt.templateHint')}</div>
      </div>
    </Modal>
  );
}
