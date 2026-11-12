import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dbCall, useData, useUi } from '../store';
import { RevisionEntryDetail, RevisionEntryMeta } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Modal } from './Ui';
import { confirmDialog } from './TextPrompt';
import { DiffPart, diffCounts, diffWords } from '../lib/textDiff';

/**
 * Revision Timeline — the manuscript's change history in one line.
 *
 * Two histories already existed but lived apart: full-chapter snapshots
 * (Settings-free, per chapter) and the Text Dump (displaced passages). A writer
 * revising a chapter wants both in reading order, with the actual text change
 * visible before choosing to roll back. The listing is metadata-only; opening a
 * row fetches its before/after text on demand.
 */

const MAX_ENTRIES = 400;
const DIFF_CHAR_BUDGET = 9000;

interface Props {
  projectId?: string | null;
  /** Fixed chapter scope (opened from a chapter's History button). */
  chapterId?: string | null;
  onClose: () => void;
  /** Called after a successful restore, so the editor can refresh its draft. */
  onRestored?: (chapterId: string) => void;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number, today: string, yesterday: string): string {
  const d = new Date(ts);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (at === start) return today;
  if (at === start - 86_400_000) return yesterday;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Keep a huge chapter diff renderable: show the start, then offer the rest. */
function clipDiff(parts: DiffPart[], max: number): { parts: DiffPart[]; truncated: boolean } {
  let used = 0;
  const out: DiffPart[] = [];
  for (const p of parts) {
    if (used + p.text.length <= max) {
      out.push(p);
      used += p.text.length;
      continue;
    }
    const room = max - used;
    if (room > 0) out.push({ kind: p.kind, text: p.text.slice(0, room) });
    return { parts: out, truncated: true };
  }
  return { parts: out, truncated: false };
}

const SOURCE_VERSIONS = new Set(['manual', 'ai-append', 'restore']);
const SOURCE_DUMPS = new Set(['writing', 'agent', 'manual', 'chat']);

export function RevisionTimeline({ projectId, chapterId = null, onClose, onRestored }: Props) {
  const t = useT();
  const ui = useUi();
  const chapters = useData((s) => s.chapters);
  const projects = useData((s) => s.projects);

  const [rows, setRows] = useState<RevisionEntryMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<'all' | 'version' | 'edit'>('all');
  const [chapterFilter, setChapterFilter] = useState<string>(chapterId || 'all');
  const [openId, setOpenId] = useState<string | null>(null);
  const openRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<RevisionEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);

  const fullDate = (ts: number) => new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const chapterOptions = useMemo(
    () => chapters
      .filter((c) => !projectId || c.project_id === projectId)
      .sort((a, b) => a.position - b.position),
    [chapters, projectId]
  );
  const project = projects.find((p) => p.id === projectId) || null;
  const fixedChapter = chapterId ? chapters.find((c) => c.id === chapterId) || null : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await dbCall<RevisionEntryMeta[]>('listRevisionTimeline', {
        projectId: projectId || undefined,
        chapterId: chapterId || (chapterFilter !== 'all' ? chapterFilter : undefined),
        limit: MAX_ENTRIES
      });
      setRows(Array.isArray(list) ? list : []);
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, chapterId, chapterFilter, ui]);

  useEffect(() => {
    void load();
  }, [load]);


  async function toggle(row: RevisionEntryMeta) {
    if (openId === row.id) {
      openRef.current = null;
      setOpenId(null);
      setDetail(null);
      return;
    }
    openRef.current = row.id;
    setOpenId(row.id);
    setDetail(null);
    setDetailError(false);
    setDetailLoading(true);
    setShowFull(false);
    try {
      const res = await dbCall<RevisionEntryDetail>('getRevisionEntry', { kind: row.kind, id: row.rowId });
      if (openRef.current !== row.id) return;
      if (!res || res.ok === false) setDetailError(true);
      else setDetail(res);
    } catch {
      if (openRef.current === row.id) setDetailError(true);
    } finally {
      if (openRef.current === row.id) setDetailLoading(false);
    }
  }

  const diff = useMemo(() => (detail ? diffWords(detail.before, detail.after) : []), [detail]);
  const diffStat = useMemo(() => diffCounts(diff), [diff]);
  const clipped = useMemo(() => clipDiff(diff, DIFF_CHAR_BUDGET), [diff]);
  const shownDiff = showFull ? diff : clipped.parts;

  const grouped = useMemo(() => {
    const visible = rows.filter((r) => kind === 'all' || r.kind === kind);
    const groups: Array<{ key: string; label: string; rows: RevisionEntryMeta[] }> = [];
    const today = t('revision.today');
    const yesterday = t('revision.yesterday');
    for (const row of visible) {
      const key = dayKey(row.at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(row);
      else groups.push({ key, label: dayLabel(row.at, today, yesterday), rows: [row] });
    }
    return groups;
  }, [rows, kind, t]);

  function sourceLabel(row: RevisionEntryMeta): string {
    if (row.kind === 'version') {
      return t('chapters.src.' + (SOURCE_VERSIONS.has(row.source) ? row.source : 'manual'));
    }
    return t('dump.source.' + (SOURCE_DUMPS.has(row.source) ? row.source : 'manual'));
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      ui.toast(t('revision.copied'), 'ok');
    } catch {
      ui.toast(t('chat.copyFailed'), 'error');
    }
  }

  async function restore(entry: RevisionEntryDetail) {
    if (busy) return;
    setBusy(entry.id);
    try {
      if (entry.kind === 'version') {
        const ok = await confirmDialog({
          title: t('revision.restoreTitle'),
          message: t('revision.restoreMsg'),
          confirmLabel: t('chapters.restore'),
          cancelLabel: t('confirm.cancel')
        });
        if (!ok) return;
        const res = await dbCall<{ ok: boolean; error?: string; chapterId?: string; title?: string }>(
          'restoreChapterVersion', { id: entry.id }
        );
        if (!res?.ok) {
          ui.toast(res?.error === 'missing-chapter' ? t('dump.chapterGone') : t('revision.restoreFailed'), 'error');
          return;
        }
        await useData.getState().reloadChapters();
        ui.toast(t('revision.restored').replace('{title}', res.title || entry.chapterTitle), 'ok');
        onRestored?.(res.chapterId || entry.chapterId || '');
      } else {
        let res = await dbCall<{ ok: boolean; error?: string; title?: string }>('restoreTextDump', { id: entry.id });
        if (!res?.ok && res?.error === 'conflict') {
          const force = await confirmDialog({
            title: t('dump.restoreConflict'),
            message: t('dump.restoreConflictHint'),
            confirmLabel: t('dump.forceRestore'),
            cancelLabel: t('confirm.cancel'),
            danger: true
          });
          if (!force) return;
          res = await dbCall('restoreTextDump', { id: entry.id, force: true });
        }
        if (!res?.ok) {
          ui.toast(res?.error === 'missing-chapter' ? t('dump.chapterGone') : t('dump.restoreFailed'), 'error');
          return;
        }
        await useData.getState().reloadChapters();
        ui.toast(t('dump.restored').replace('{title}', res.title || entry.chapterTitle), 'ok');
        onRestored?.(entry.chapterId || '');
      }
      openRef.current = null;
      setOpenId(null);
      setDetail(null);
      await load();
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function removeSnapshot(entry: RevisionEntryDetail) {
    if (busy) return;
    const ok = await confirmDialog({
      title: t('revision.deleteTitle'),
      message: t('revision.deleteMsg'),
      confirmLabel: t('revision.deleteSnapshot'),
      cancelLabel: t('confirm.cancel'),
      danger: true
    });
    if (!ok) return;
    setBusy(entry.id);
    try {
      await dbCall('deleteChapterVersion', { id: entry.id });
      openRef.current = null;
      setOpenId(null);
      setDetail(null);
      await load();
      ui.toast(t('revision.deleted'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const title = fixedChapter
    ? `${t('revision.title')}: ${fixedChapter.title}`
    : t('revision.title');
  const sub = fixedChapter
    ? t('revision.subChapter').replace('{chapter}', fixedChapter.title)
    : t('revision.subProject').replace('{project}', project?.name || t('revision.thisManuscript'));

  return (
    <Modal title={title} onClose={onClose} width={880}>
      <div className="rev-wrap">
        <p className="rev-sub">{sub}</p>

        <div className="rev-filters">
          <div className="rev-tabs" role="group" aria-label={t('revision.filter')}>
            {(['all', 'version', 'edit'] as const).map((k) => (
              <button
                key={k}
                className={`rev-tab ${kind === k ? 'active' : ''}`}
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
              >
                {k === 'all' ? t('revision.filterAll') : k === 'version' ? t('revision.filterSnapshots') : t('revision.filterEdits')}
              </button>
            ))}
          </div>
          {!chapterId && chapterOptions.length > 0 && (
            <select
              className="rev-chapter-filter"
              value={chapterFilter}
              onChange={(e) => setChapterFilter(e.target.value)}
              aria-label={t('revision.chapterFilter')}
            >
              <option value="all">{t('revision.allChapters')}</option>
              {chapterOptions.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          )}
          <span className="rev-count">{t('revision.count').replace('{n}', String(rows.length))}</span>
        </div>

        {loading && <div className="hint rev-state">{t('revision.loading')}</div>}
        {!loading && rows.length === 0 && <div className="hint rev-state">{t('revision.empty')}</div>}
        {!loading && rows.length > 0 && grouped.length === 0 && <div className="hint rev-state">{t('revision.emptyFilter')}</div>}

        {!loading && grouped.length > 0 && (
          <div className="rev-timeline">
            {grouped.map((group) => (
              <section key={group.key} className="rev-day">
                <h4 className="rev-day-label">{group.label}</h4>
                {group.rows.map((row) => {
                  const open = openId === row.id;
                  return (
                    <div key={row.id} className={`rev-entry ${row.kind} ${open ? 'open' : ''}`}>
                      <button
                        className="rev-row"
                        onClick={() => { void toggle(row); }}
                        aria-expanded={open}
                      >
                        <span className="rev-time">{fmtTime(row.at)}</span>
                        <span className="rev-dot" aria-hidden="true" />
                        <span className="rev-main">
                          <span className="rev-line1">
                            <b className="rev-chapter">{row.chapterTitle || t('revision.untitled')}</b>
                            <span className={`rev-badge ${row.kind}`}>
                              {row.kind === 'version' ? t('revision.snapshot') : t('revision.edit')}
                            </span>
                            <span className="rev-src">{sourceLabel(row)}</span>
                            {row.restoredAt != null && <span className="rev-badge restored">{t('revision.alreadyRestored')}</span>}
                          </span>
                          <span className="rev-line2">
                            {row.kind === 'version'
                              ? t('revision.wordDelta')
                                .replace('{before}', String(row.words ?? 0))
                                .replace('{after}', String(row.afterWords ?? 0))
                              : `${t('revision.chars').replace('{n}', row.chars.toLocaleString())} · ${row.scope === 'passage' ? t('revision.passage') : t('revision.wholeChapter')}`}
                            {row.preview ? <em className="rev-preview"> — {row.preview}</em> : null}
                          </span>
                        </span>
                        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
                      </button>

                      {open && (
                        <div className="rev-detail">
                          <div className="rev-detail-meta">
                            <span>{fullDate(row.at)}</span>
                            <span>{sourceLabel(row)}</span>
                            {row.kind === 'version' && <span>{t('revision.snapshotWords').replace('{n}', String(row.words ?? 0))}</span>}
                            {row.kind === 'edit' && <span>{row.scope === 'passage' ? t('revision.passage') : t('revision.wholeChapter')}</span>}
                          </div>

                          {detailLoading && <div className="hint">{t('revision.loadingEntry')}</div>}
                          {!detailLoading && detailError && <div className="hint">{t('revision.loadFailed')}</div>}

                          {!detailLoading && detail && (
                            <>
                              {detail.before === detail.after ? (
                                <div className="hint rev-nochange">{t('revision.noChange')}</div>
                              ) : (
                                <div className="rev-diff" aria-label={t('revision.diffLabel')}>
                                  {shownDiff.map((part, i) => part.kind === 'same'
                                    ? <span key={i}>{part.text}</span>
                                    : part.kind === 'add'
                                      ? <ins key={i} className="diff-add">{part.text}</ins>
                                      : <del key={i} className="diff-del">{part.text}</del>)}
                                </div>
                              )}
                              {clipped.truncated && !showFull && (
                                <div className="rev-truncated">
                                  {t('revision.diffClipped')}
                                  <button className="link" onClick={() => setShowFull(true)}>{t('revision.showFull')}</button>
                                </div>
                              )}
                              <div className="rev-detail-foot">
                                <div className="diff-legend">
                                  <span className="add">+ {diffStat.added.toLocaleString()} {t('writing.diffAdded')}</span>
                                  <span className="del">− {diffStat.removed.toLocaleString()} {t('writing.diffRemoved')}</span>
                                </div>
                                <span className="rev-actions">
                                  <button className="small ghost" onClick={() => { void copy(detail.before); }}>
                                    {t('revision.copyBefore')}
                                  </button>
                                  <button className="small ghost" onClick={() => { void copy(detail.after); }}>
                                    {t('revision.copyAfter')}
                                  </button>
                                  {detail.kind === 'version' && (
                                    <button
                                      className="small ghost danger-text"
                                      disabled={busy !== null}
                                      onClick={() => { void removeSnapshot(detail); }}
                                    >
                                      <Icon name="trash" size={12} /> {t('revision.deleteSnapshot')}
                                    </button>
                                  )}
                                  <button
                                    className="small primary"
                                    disabled={busy !== null}
                                    onClick={() => { void restore(detail); }}
                                  >
                                    <Icon name="refresh" size={12} /> {busy === detail.id ? t('revision.restoring') : t('chapters.restore')}
                                  </button>
                                </span>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
