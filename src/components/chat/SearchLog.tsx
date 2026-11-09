import { useEffect, useState } from 'react';
import { Icon } from '../Icons';
import { useT } from '../../i18nReact';
import type { ToolStep } from '../../lib/toolProgress';

/** The two tools that make up "web research" (no agent mode needed). */
export const isWebTool = (name: string): boolean => name === 'web_search' || name === 'web_fetch';

type Row = { name: string; detail: string; ok: boolean };

/**
 * Web research as a terminal session.
 *
 * Agent tools belong in `ToolLog` (a list of things created). A search is a
 * different act: you type a query, a page answers. So it gets its own box with a
 * title bar, a `$` gutter and one line per call — recognisable at a glance, and
 * separate from the agent panel so a chat can show both without mixing them.
 */
export function SearchLog({
  names,
  steps,
  live
}: {
  /** Tool names from a finished message (only web tools are passed in). */
  names: string[];
  /** Detailed rows while a run is streaming. */
  steps?: ToolStep[];
  live?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(!!live);
  // Folded lines stay reachable: `+N` expands the full session, `−N` folds it.
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setOpen(!!live); }, [live]);

  const rows: Row[] = steps && steps.length
    ? steps.map((s) => ({ name: s.name, detail: s.detail, ok: s.ok }))
    : names.map((n) => ({ name: n, detail: '', ok: true }));
  if (!rows.length) return null;

  const failed = rows.filter((r) => !r.ok).length;
  // Same rule as the agent panel: newest 40 lines, the rest behind `+N`, so a
  // research loop cannot grow the DOM without bound while the reply streams.
  const VISIBLE = 40;
  const hidden = Math.max(0, rows.length - VISIBLE);

  return (
    <div className={`search-log ${live ? 'live' : ''} ${open ? 'open' : ''}`}>
      <button
        className="sl-bar"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? t('tools.hide') : t('tools.show')}
      >
        <span className="sl-dots" aria-hidden><i /><i /><i /></span>
        <span className="sl-title">{t('composer.web')}</span>
        <span className="sl-count">{rows.length}</span>
        {failed > 0 && <span className="sl-fail">{failed}</span>}
        <span className="sl-chev"><Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} /></span>
      </button>
      {open && (
        <div className="sl-body">
          {hidden > 0 && (
            <button className="sl-more" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? '\u2212' : '+'}{hidden}
            </button>
          )}
          {rows.slice(showAll ? 0 : hidden).map((r, i) => (
            <div key={i} className={`sl-line ${r.ok ? 'ok' : 'err'}`}>
              <span className="sl-prompt" aria-hidden>$</span>
              <span className="sl-cmd">{r.name}</span>
              {r.detail ? <span className="sl-out">{r.detail}</span> : null}
              {live && i === rows.length - (showAll ? 0 : hidden) - 1 && <span className="sl-caret" aria-hidden />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
