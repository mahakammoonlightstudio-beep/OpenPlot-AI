import { useEffect, useMemo, useState } from 'react';
import { dbCall, useData, useUi } from '../store';
import { TextDumpRow } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { confirmDialog } from './TextPrompt';

const ACTIONS: TextDumpRow['action'][] = ['delete', 'replace', 'edit', 'rephrase', 'expand', 'shrink'];
const SOURCE_LABEL: Record<TextDumpRow['source'], string> = {
  writing: 'dump.source.writing',
  agent: 'dump.source.agent',
  manual: 'dump.source.manual',
  chat: 'dump.source.chat'
};

function when(ts: number): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

function clip(text: string, max = 340): string {
  const clean = String(text || '').trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean;
}

/**
 * Text Dump — the recovery bin for prose.
 *
 * Every AI rewrite and manual save can displace text; instead of forcing a
 * whole-chapter rollback, the displaced passage lands here. Restore is
 * conservative: it splices the old text back only when the chapter still
 * matches what replaced it, and otherwise asks before overwriting newer prose.
 */
export function TextDumpView() {
  const t = useT();
  const ui = useUi();
  const projects = useData((s) => s.projects);
  const chapters = useData((s) => s.chapters);
  const activeProjectId = useData((s) => s.activeProjectId);

  const [rows, setRows] = useState<TextDumpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState<string>(activeProjectId || 'all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const list = await dbCall<TextDumpRow[]>('listTextDump', projectFilter === 'all' ? {} : { projectId: projectFilter });
      setRows(Array.isArray(list) ? list : []);
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelected(new Set());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectFilter]);

  // An entry whose chapter was deleted still belongs in the bin (its text is
  // the only copy left), but the row must not offer a restore that cannot work.
  const chapterIds = useMemo(() => new Set(chapters.map((c) => c.id)), [chapters]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter !== 'all' && r.action !== actionFilter) return false;
      if (!needle) return true;
      return String(r.original).toLowerCase().includes(needle)
        || String(r.replacement).toLowerCase().includes(needle)
        || String(r.chapter_title).toLowerCase().includes(needle);
    });
  }, [rows, q, actionFilter]);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) visible.forEach((r) => next.delete(r.id));
      else visible.forEach((r) => next.add(r.id));
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function copy(row: TextDumpRow) {
    try {
      await navigator.clipboard.writeText(row.original);
      ui.toast(t('dump.copied'), 'ok');
    } catch {
      ui.toast(t('chat.copyFailed'), 'error');
    }
  }

  async function deleteSelected() {
    if (!selected.size || busy) return;
    const ok = await confirmDialog({
      title: t('dump.deleteSelected'),
      message: t('dump.deleteConfirm').replace('{n}', String(selected.size)),
      confirmLabel: t('dump.deleteForever'),
      cancelLabel: t('confirm.cancel'),
      danger: true
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await dbCall('deleteTextDumps', { ids: [...selected] });
      setSelected(new Set());
      await load();
      ui.toast(t('dump.deleted').replace('{n}', String(selected.size)), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function deleteAll() {
    if (!rows.length || busy) return;
    const ok = await confirmDialog({
      title: t('dump.deleteAll'),
      message: t('dump.deleteAllConfirm'),
      confirmLabel: t('dump.deleteForever'),
      cancelLabel: t('confirm.cancel'),
      danger: true
    });
    if (!ok) return;
    setBusy('all');
    try {
      await dbCall('deleteAllTextDumps', {});
      setSelected(new Set());
      setRows([]);
      ui.toast(t('dump.allDeleted'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function restore(row: TextDumpRow) {
    if (busy || !row.chapter_id) return;
    setBusy(row.id);
    try {
      let res = await dbCall<{ ok: boolean; error?: string; title?: string }>('restoreTextDump', { id: row.id });
      if (!res?.ok && res?.error === 'conflict') {
        const force = await confirmDialog({
          title: t('dump.restoreConflict'),
          message: t('dump.restoreConflictHint'),
          confirmLabel: t('dump.forceRestore'),
          cancelLabel: t('confirm.cancel'),
          danger: true
        });
        if (!force) return;
        res = await dbCall('restoreTextDump', { id: row.id, force: true });
      }
      if (!res?.ok) {
        ui.toast(res?.error === 'missing-chapter' ? t('dump.chapterGone') : t('dump.restoreFailed'), 'error');
        return;
      }
      await useData.getState().reloadChapters();
      await load();
      ui.toast(t('dump.restored').replace('{title}', res.title || row.chapter_title), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page dump-page">
      <header className="dump-head">
        <div className="dump-title">
          <span className="dump-title-icon"><Icon name="trash" size={18} /></span>
          <div>
            <h1>{t('dump.title')}</h1>
            <p className="sub">{t('dump.sub')}</p>
          </div>
        </div>
        <div className="dump-head-actions">
          <span className="dump-count">{t('dump.count').replace('{n}', String(rows.length))}</span>
          <button className="small danger" disabled={!rows.length || busy !== null} onClick={() => { void deleteAll(); }}>
            <Icon name="trash" size={13} /> {t('dump.deleteAll')}
          </button>
        </div>
      </header>

      <div className="dump-toolbar card">
        <div className="dump-filters">
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label={t('dump.filterProject')}>
            <option value="all">{t('dump.allProjects')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} aria-label={t('dump.filterAction')}>
            <option value="all">{t('dump.allActions')}</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{t('dump.action.' + a)}</option>)}
          </select>
          <div className="dump-search">
            <Icon name="search" size={13} />
            <input value={q} placeholder={t('dump.searchPh')} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="dump-selectbar">
          <label className="dump-check">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!visible.length} />
            <span>{selected.size ? t('dump.selected').replace('{n}', String(selected.size)) : t('dump.selectHint')}</span>
          </label>
          <button className="small danger" disabled={!selected.size || busy !== null} onClick={() => { void deleteSelected(); }}>
            {t('dump.deleteSelected')}
          </button>
        </div>
      </div>

      {loading && <div className="dump-empty"><span className="dump-spinner" /> {t('dump.loading')}</div>}

      {!loading && !visible.length && (
        <div className="dump-empty">
          <span className="dump-empty-icon"><Icon name="trash" size={26} /></span>
          <h2>{rows.length ? t('dump.noMatches') : t('dump.empty')}</h2>
          <p>{rows.length ? t('dump.noMatchesHint') : t('dump.emptyHint')}</p>
        </div>
      )}

      <div className="dump-list">
        {visible.map((row) => {
          const open = expanded.has(row.id);
          const chapterExists = !!row.chapter_id && chapterIds.has(row.chapter_id);
          return (
            <article key={row.id} className={`dump-row ${selected.has(row.id) ? 'selected' : ''} ${row.restored_at ? 'restored' : ''}`}>
              <label className="dump-check">
                <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)}
                  aria-label={t('dump.select')} />
              </label>
              <div className="dump-main">
                <div className="dump-meta">
                  <span className={`dump-badge ${row.action}`}>{t('dump.action.' + row.action)}</span>
                  <span className="dump-source">{t(SOURCE_LABEL[row.source] || 'dump.source.writing')}</span>
                  <span className="dump-time">{when(row.created_at)}</span>
                  {row.restored_at && <span className="dump-restored"><Icon name="check" size={11} /> {t('dump.restoredBadge')}</span>}
                  <span className="dump-chapter" title={row.chapter_title}>
                    <Icon name="book" size={11} /> {row.chapter_title || t('dump.chapterGone')}
                  </span>
                </div>
                <div className={`dump-text ${open ? 'open' : ''}`}>{open ? row.original : clip(row.original)}</div>
                {open && row.replacement && (
                  <div className="dump-replacement">
                    <span className="dump-label">{t('dump.replacedWith')}</span>
                    <div className="dump-text replacement">{row.replacement}</div>
                  </div>
                )}
                <div className="dump-actions">
                  <button className="small" onClick={() => { void copy(row); }}>
                    <Icon name="copy" size={12} /> {t('dump.copy')}
                  </button>
                  <button className="small ghost" onClick={() => toggleExpanded(row.id)}>
                    <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
                    {open ? t('dump.showLess') : t('dump.showMore')}
                  </button>
                  <button className="small primary" disabled={!chapterExists || busy !== null}
                    title={chapterExists ? t('dump.restoreHint') : t('dump.chapterGone')}
                    onClick={() => { void restore(row); }}>
                    <Icon name="refresh" size={12} /> {busy === row.id ? t('dump.restoring') : t('dump.restore')}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
