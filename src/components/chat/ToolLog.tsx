import { useEffect, useState } from 'react';
import { Icon } from '../Icons';
import { useT } from '../../i18nReact';
import type { ToolStep } from '../../lib/toolProgress';

/**
 * True when the title already repeats the type (`Chapter 1 — Low Tide` +
 * `Chapter`, `Sari Winata` + `Bible entry`): the suffix adds nothing then.
 */
function typeEcho(detail: string, label: string): boolean {
  const d = detail.trim().toLowerCase();
  const l = label.trim().toLowerCase();
  return l.length > 0 && d.includes(l);
}

/**
 * Everything the AI did with a tool, in one expandable panel under the reply.
 *
 * The chat used to print tool names as inline chips *above* the answer, which
 * pushed the message body down and grew sideways as calls stacked up. A panel
 * keeps the transcript still: one line closed, rows stacked downward when open.
 * While a run is live it opens itself; once the reply lands it collapses, and a
 * reader can open it again without losing their place.
 */
export function ToolLog({
  tools, steps, live
}: {
  /** Tool names from a finished message (persisted with the reply). */
  tools: string[];
  /** Readable progress rows for a run that is still streaming. */
  steps?: ToolStep[];
  /** True while the answer is still being written. */
  live?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(!!live);
  // Folded rows are reachable: `+N` expands the whole run, `−N` folds it back.
  const [showAll, setShowAll] = useState(false);
  // A run that starts on screen should show its work immediately; when it ends
  // the panel folds away so the answer is not buried under diagnostics.
  useEffect(() => { setOpen(!!live); }, [live]);
  const rows = steps && steps.length ? steps.length : tools.length;
  if (!rows) return null;
  const failed = (steps || []).filter((s) => !s.ok).length;
  // A long run can log hundreds of calls. Rendering every row on each stream
  // update is what made the panel feel heavy, so the newest 40 are shown and
  // the rest collapse into a `+N` marker — the header still counts them all.
  const VISIBLE = 40;
  const hidden = Math.max(0, rows - VISIBLE);
  return (
    <div className={`tool-log ${live ? 'live' : ''} ${open ? 'open' : ''}`}>
      <button
        className="tl-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? t('tools.hide') : t('tools.show')}
      >
        <Icon name="tools" size={12} />
        <span className="tl-title">
          {live ? t('tools.live') : t('tools.used')}
          <span className="tl-count">{rows}</span>
        </span>
        {failed > 0 && <span className="tl-fail">{failed}</span>}
        <span className="tl-chev"><Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} /></span>
      </button>
      {open && (
        <div className="tl-body">
          {hidden > 0 && (
            <button className="tl-more" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? '\u2212' : '+'}{hidden}
            </button>
          )}
          {steps && steps.length
            ? steps.slice(showAll ? 0 : hidden).map((s, i) => (
              <div key={i} className={`tl-row ${s.ok ? 'ok' : 'err'}`}>
                <span className="tl-dot" aria-hidden />
                {/* The subject leads and the type follows: `$ Sari Winata · story bible`
                    reads like a command output; the old order led with the label,
                    which made every row start with the same word. */}
                {s.detail ? (
                  <>
                    <span className="tl-name" title={s.detail}>{s.detail}</span>
                    {/* "Chapter 1 — Low Tide · Chapter" is noise: when the title
                        already says the type, the tag is dropped. */}
                    {typeEcho(s.detail, t('tool.step.' + s.kind)) ? null : (
                      <span className="tl-kind">{t('tool.step.' + s.kind)}</span>
                    )}
                  </>
                ) : (
                  <span className="tl-name">{t('tool.step.' + s.kind)}</span>
                )}
                <span className="tl-state">{s.ok ? t('agent.stepOk') : t('agent.stepError')}</span>
              </div>
            ))
            : tools.slice(showAll ? 0 : hidden).map((n, i) => (
              <div key={i} className="tl-row ok">
                <span className="tl-dot" aria-hidden />
                <span className="tl-name mono">{n}</span>
                <span className="tl-state">{t('agent.stepOk')}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
