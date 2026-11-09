import { memo, useEffect, useRef, useState } from 'react';
import type { Message, MessageFileMeta } from '../../types';
import { useT } from '../../i18nReact';
import { useMarkdown, hardenLinks } from '../../markdown';
import { hydrateRemoteImages } from '../../lib/remoteImages';
import { Icon } from '../Icons';
import { ModelStatusBar } from '../ModelStatusBar';
import { useData } from '../../store';
import { useVerifyStore } from '../../verifyStore';
import { formatBytes } from '../../lib/chatFiles';
import { fmtTokens, relativeTime, tokenLabel } from '../../lib/chatContext';
import { ToolLog } from './ToolLog';
import { SearchLog, isWebTool } from './SearchLog';
import type { ToolStep } from '../../lib/toolProgress';

export function ThinkingBlock({ text, live, durationMs, display = 'auto' }: {
  text: string; live?: boolean; durationMs?: number;
  display?: 'auto' | 'expanded' | 'collapsed';
}) {
  const t = useT();
  // Display preference (Task 4):
  //   auto      — open while streaming, collapse when the reply lands
  //   expanded  — keep the trace open (reading mode)
  //   collapsed — never auto-open; the header still shows the duration
  const [open, setOpen] = useState(display === 'expanded' || (!!live && display !== 'collapsed'));
  useEffect(() => {
    setOpen(live ? display !== 'collapsed' : display === 'expanded');
  }, [live, display]);
  const secs = durationMs && durationMs > 0 ? (durationMs / 1000).toFixed(1) : '';
  const label = open
    ? t('chat.hideThinking')
    : live
      ? t('chat.thinking')
      : secs
        ? t('think.thoughtFor').replace('{s}', secs)
        : t('chat.thoughtProcess');
  return (
    <div className="thinking-block">
      <div className="tb-head" onClick={() => setOpen(!open)} role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}>
        <Icon name="brain" size={14} />
        <span style={{ flex: 1 }}>{label}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </div>
      {open && <div className="tb-body">{text}</div>}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  // Clear the timer on unmount: an open chat could unmount mid-countdown and
  // the old setTimeout kept a closure (and a pending state update) alive.
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  return (
    <button
      className="small ghost"
      title={t('chat.copy')}
      aria-label={t('chat.copy')}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => { timerRef.current = null; setDone(false); }, 1200);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  );
}

export function ModelBadge({ model, withBar }: { model: string | null | undefined; withBar?: boolean }) {
  const t = useT();
  const { results, pending, history } = useVerifyStore();
  // Subscribe to providers so a badge reacts when providers/models change;
  // getState() here went stale and showed wrong health forever.
  const providers = useData((s) => s.providers);
  if (!model) return null;
  const provider = providers.find((p) => (Array.isArray(p.models) ? p.models : []).includes(model));
  const key = provider ? `${provider.id}::${model}` : null;
  const entry = key ? results[key] : undefined;
  const checking = key ? pending.has(key) : false;
  const events = key ? (history[key] || []) : [];
  const okCount = events.filter((e) => e.state === 'ok').length;
  const degradedCount = events.filter((e) => e.state === 'degraded').length;
  const failCount = events.filter((e) => e.state === 'fail').length;
  const reliability = events.length ? Math.round(((okCount + degradedCount * 0.5) / events.length) * 100) : null;
  // After a restart there is no one-shot `entry`, but history survives in
  // localStorage — derive the dot color from the newest recorded event so the
  // badge doesn't flash "unknown" for models that were verified yesterday.
  const lastState = events.length ? events[events.length - 1].state : null;
  const status = checking ? 'pending'
    : entry ? (entry.ok ? 'ok' : 'fail')
    : lastState === 'ok' || lastState === 'degraded' ? 'ok'
    : lastState === 'fail' ? 'fail'
    : 'unknown';
  const tooltip = checking ? t('health.verifying')
    : entry?.ok ? `${t('health.verified')} — ${entry.latencyMs}ms${reliability !== null ? ` · ${reliability}% ${t('health.ofLast')} ${events.length} ${t('health.checks')}` : ''}`
    : entry ? `${t('health.lastFailed')}: ${entry.error || 'error'}`
    : t('health.notVerified');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className={`model-badge st-${status}`} title={tooltip}>
        <span className="dot" />
        {model}
      </span>
      {withBar && provider && (
        <span className="model-health">
          <ModelStatusBar providerId={provider.id} model={model} />
        </span>
      )}
    </span>
  );
}

export const MessageBubble = memo(function MessageBubble({ msg, fresh, variant, onPickVariant, onOpenFile, onDelete, onEdit, onRegen, regenLabel, streaming, youLabel, editLabel, saveResendLabel, cancelLabel, deleteLabel, onSaveChapter, savedToChapter, tokensLabel, thinkMs, thinkingDisplay }: {
  fresh?: boolean;
  /** Set when this reply is one of several answers to the same user turn. */
  variant?: { parentId: string; ids: string[]; index: number };
  onPickVariant: (parentId: string, id: string) => void;
  msg: Message;
  onRegen?: (msg: Message) => void;
  regenLabel?: string;
  streaming?: boolean;
  /** How long this reply's reasoning streamed (session-only; not persisted). */
  thinkMs?: number;
  thinkingDisplay?: 'auto' | 'expanded' | 'collapsed';
  onOpenFile: (file: MessageFileMeta) => void;
  onDelete: (msg: Message) => void;
  onEdit: (msg: Message, newText: string) => void;
  youLabel: string;
  editLabel: string;
  saveResendLabel: string;
  cancelLabel: string;
  deleteLabel: string;
  onSaveChapter?: (msg: Message) => void;
  savedToChapter?: boolean;
  tokensLabel?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const html = useMarkdown(msg.content);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!contentRef.current) return;
    hardenLinks(contentRef.current);
    hydrateRemoteImages(contentRef.current);
  }, [html]);
  const isUser = msg.role === 'user';
  const toolsUsed: string[] = (msg as any).toolsUsed || [];
  // Persisted detail (v1.2.5): a reopened chat shows what each call did, not
  // just its name. Older rows simply have no steps.
  const toolSteps: ToolStep[] = (msg as any).toolSteps || [];
  const webSteps = toolSteps.filter((s) => s.kind === 'web');
  const otherSteps = toolSteps.filter((s) => s.kind !== 'web');
  const webNames = toolsUsed.filter(isWebTool);
  const otherNames = toolsUsed.filter((n) => !isWebTool(n));
  return (
    <div className={`msg ${msg.role}`} data-fresh={fresh ? 'true' : undefined}>
      <div className="avatar"><Icon name={isUser ? 'user' : 'quill'} size={15} /></div>
      <div className="bubble">
        <div className="meta">
          <span className="who">{isUser ? youLabel : <ModelBadge model={msg.model} />}</span>
          {tokensLabel && <span className="tok-chip">{tokensLabel}</span>}
          {!isUser && (msg.tokens_cached ?? 0) > 0 && (
            <span className="tok-chip cached" title={t('chat.cachedHint')}>
              {t('chat.cached').replace('{n}', fmtTokens(msg.tokens_cached))}
            </span>
          )}
          <span className="msg-time">{relativeTime(msg.created_at, t)}</span>
        </div>
        {!isUser && msg.thinking
          ? <ThinkingBlock text={msg.thinking} durationMs={thinkMs} display={thinkingDisplay} />
          : null}
        {!isUser && (webSteps.length > 0 || webNames.length > 0) && (
          <SearchLog names={webNames} steps={webSteps} />
        )}
        {!isUser && (otherSteps.length > 0 || otherNames.length > 0) && (
          <ToolLog tools={otherNames} steps={otherSteps} />
        )}
        {editing && isUser ? (
          <div className="edit-box">
            <textarea
              value={draft}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setEditing(false); onEdit(msg, draft); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setDraft(msg.content); }
              }}
              autoFocus
            />
            <div className="edit-actions">
              <button className="small primary" onClick={() => { setEditing(false); onEdit(msg, draft); }}>{saveResendLabel}</button>
              <button className="small ghost" onClick={() => { setEditing(false); setDraft(msg.content); }}>{cancelLabel}</button>
            </div>
          </div>
        ) : (
          <div className="content" ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {isUser && !!msg.files?.length && (
          <div className="msg-files">
            {msg.files.map((f) => (
              <button
                key={f.id}
                className={`file-card kind-${f.kind}`}
                title={t('chat.openFile').replace('{name}', f.name)}
                aria-label={t('chat.openFile').replace('{name}', f.name)}
                onClick={() => onOpenFile(f)}
              >
                <span className="fc-icon">
                  <Icon name={f.kind === 'story' ? 'book' : f.kind === 'chapter' ? 'file' : 'paperclip'} size={14} />
                </span>
                <span className="fc-text">
                  <span className="fc-name">{f.name}</span>
                  <span className="fc-size">{formatBytes(f.bytes)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="actions">
          {/* Version arrows sit BELOW the bubble, next to the other message
              actions — in the meta row they crowded the timestamp and read as
              part of the header instead of a control. */}
          {variant && variant.ids.length > 1 && (
            <span
              className="variant-nav"
              title={t('chat.variantLabel').replace('{i}', String(variant.index + 1)).replace('{n}', String(variant.ids.length))}
            >
              <button
                className="vn-btn"
                aria-label={t('chat.variantPrev')}
                title={t('chat.variantPrev')}
                disabled={variant.index <= 0}
                onClick={() => onPickVariant(variant.parentId, variant.ids[variant.index - 1])}
              >
                <Icon name="chevronRight" size={13} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="vn-count">{variant.index + 1}/{variant.ids.length}</span>
              <button
                className="vn-btn"
                aria-label={t('chat.variantNext')}
                title={t('chat.variantNext')}
                disabled={variant.index >= variant.ids.length - 1}
                onClick={() => onPickVariant(variant.parentId, variant.ids[variant.index + 1])}
              >
                <Icon name="chevronRight" size={13} />
              </button>
            </span>
          )}
          {!editing && <CopyBtn text={msg.content} />}
          {isUser ? <button className="small ghost" title={editLabel} onClick={() => { setDraft(msg.content); setEditing(true); }}><Icon name="pencil" size={14} /></button> : null}
          {onRegen && (
            <button
              className="small ghost"
              title={isUser ? t('chat.resend') : (regenLabel || t('chat.restart'))}
              aria-label={isUser ? t('chat.resend') : (regenLabel || t('chat.restart'))}
              disabled={streaming}
              onClick={() => onRegen(msg)}
            >
              <Icon name="refresh" size={14} />
            </button>
          )}
          {!isUser && onSaveChapter && (
            <button
              className="small ghost"
              title={t('chat.novel')}
              aria-label={t('chat.novel')}
              disabled={savedToChapter || !msg.content.trim()}
              onClick={() => onSaveChapter(msg)}
            >
              <Icon name={savedToChapter ? 'check' : 'book'} size={14} />
            </button>
          )}
          <button className="small ghost" title={deleteLabel} aria-label={deleteLabel} onClick={() => onDelete(msg)}><Icon name="trash" size={14} /></button>
        </div>      </div>
    </div>
  );
});
