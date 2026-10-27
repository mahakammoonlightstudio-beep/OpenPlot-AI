import { useMemo, useState } from 'react';
import { Modal } from './Ui';
import { Icon } from './Icons';
import { formatBytes } from '../lib/chatFiles';
import { renderMarkdownSync } from '../markdown';
import { useT } from '../i18nReact';

/**
 * Read-only preview for a chat attachment (v1.2.3).
 *
 * Used in two places: the composer (content already in memory, no fetch) and
 * the transcript (only metadata is loaded with the message, so the body is
 * fetched through `readMessageFile` when the card is clicked).
 *
 * Markdown files render as formatted prose; everything else stays in a
 * scrollable monospace block so indentation and line numbers survive.
 */
export function FilePreviewModal({
  name, kind, bytes, content, loading, error, onClose,
}: {
  name: string;
  kind?: 'file' | 'story' | 'chapter';
  bytes?: number;
  content?: string | null;
  loading?: boolean;
  error?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(name);
  const html = useMemo(
    () => (isMarkdown && typeof content === 'string' ? renderMarkdownSync(content) : ''),
    [isMarkdown, content]
  );
  const lineCount = useMemo(
    () => (typeof content === 'string' && content ? content.split('\n').length : 0),
    [content]
  );
  const ready = !loading && !error && typeof content === 'string';

  const copy = async () => {
    if (typeof content !== 'string') return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked — the text is still selectable */ }
  };

  const download = () => {
    if (typeof content !== 'string') return;
    // Blob download keeps the original filename/extension (the generic
    // export:file channel only knows .txt/.md).
    try {
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'attachment.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { /* download unavailable — copy still works */ }
  };

  return (
    <Modal
      title={name}
      onClose={onClose}
      width={720}
      footer={(
        <>
          <button className="small ghost" onClick={onClose}>{t('file.close')}</button>
          <span style={{ flex: 1 }} />
          <button className="small ghost" disabled={!ready} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? t('file.copied') : t('file.copy')}
          </button>
          <button className="small primary" disabled={!ready} onClick={download}>
            <Icon name="download" size={13} /> {t('file.download')}
          </button>
        </>
      )}
    >
      <div className="file-preview">
        <div className="fp-meta">
          <Icon name={kind === 'story' ? 'book' : kind === 'chapter' ? 'file' : 'paperclip'} size={13} />
          <span>{formatBytes(bytes)}</span>
          {lineCount > 0 && <span>· {t('file.lines').replace('{n}', lineCount.toLocaleString())}</span>}
          {isMarkdown && ready && <span className="fp-kind">{t('file.markdown')}</span>}
        </div>
        {loading && <div className="fp-state">{t('file.loading')}</div>}
        {!loading && error && <div className="fp-state error">{error}</div>}
        {ready && isMarkdown && (
          <div className="fp-md" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {ready && !isMarkdown && (
          <pre className="fp-pre">{content}</pre>
        )}
      </div>
    </Modal>
  );
}
