import { useEffect, useMemo, useState } from 'react';
import { useData, useUi, dbCall } from '../store';
import { FlowBeat, Chapter } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { useWriteStats } from '../writeStats';

const ACTS: { id: 1 | 2 | 3; labelKey: string; hintKey: string }[] = [
  { id: 1, labelKey: 'flow.act1', hintKey: 'flow.act1Hint' },
  { id: 2, labelKey: 'flow.act2', hintKey: 'flow.act2Hint' },
  { id: 3, labelKey: 'flow.act3', hintKey: 'flow.act3Hint' }
];

const STATUS_FLOW: Record<FlowBeat['status'], FlowBeat['status']> = {
  planned: 'drafting',
  drafting: 'written',
  written: 'planned'
};

function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) || []).length;
}

const STATUS_LABEL_KEYS: Record<FlowBeat['status'], string> = {
  planned: 'flow.status.planned',
  drafting: 'flow.status.drafting',
  written: 'flow.status.written'
};

/**
 * One outline card. Text edits stay local and commit onBlur — writing to the
 * DB (plus a full store reload) on every keystroke would be a storm.
 */
function BeatCard({
  beat, linked, chapters, onPatch, onRemove, labels, onDragStart, onDragEnd, onWrite
}: {
  beat: FlowBeat;
  linked: Chapter | null;
  chapters: Chapter[];
  onPatch: (id: string, patch: Partial<Omit<FlowBeat, 'chapter_id' | 'id' | 'project_id'> & { chapterId?: string | null }>) => void;
  onRemove: (id: string) => void;
  labels: { title: string; summary: string; summaryPh: string; cycle: string; link: string; noChapter: string; del: string; linkedTo: string; write: string };
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onWrite: () => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState(beat.title);
  const [summary, setSummary] = useState(beat.summary);
  useEffect(() => { setTitle(beat.title); }, [beat.title]);
  useEffect(() => { setSummary(beat.summary); }, [beat.summary]);
  return (
    <div
      className={`beat st-${beat.status} ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={() => { setDragging(true); onDragStart(beat.id); }}
      onDragEnd={() => { setDragging(false); onDragEnd(); }}
    >
      <span className="grip" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
      <input
        className="beat-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title.trim() && title !== beat.title) onPatch(beat.id, { title: title.trim() }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        aria-label={labels.title}
      />
      <textarea
        className="beat-summary"
        value={summary}
        rows={2}
        placeholder={labels.summaryPh}
        onChange={(e) => setSummary(e.target.value)}
        onBlur={() => { if (summary !== beat.summary) onPatch(beat.id, { summary }); }}
        aria-label={labels.summary}
      />
      <div className="beat-foot">
        <button
          className={`status-chip s-${beat.status}`}
          title={labels.cycle}
          onClick={() => onPatch(beat.id, { status: STATUS_FLOW[beat.status] })}
        >
          {t(STATUS_LABEL_KEYS[beat.status])}
        </button>
        {!linked && (
          <button className="small" title={labels.write} aria-label={labels.write} onClick={onWrite}>
            <Icon name="pencil" size={12} /> {labels.write}
          </button>
        )}
        <select
          className="beat-link"
          value={beat.chapter_id || ''}
          onChange={(e) => onPatch(beat.id, { chapterId: e.target.value || null })}
          aria-label={labels.link}
        >
          <option value="">{labels.noChapter}</option>
          {chapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button className="small ghost danger" title={labels.del} aria-label={labels.del} onClick={() => onRemove(beat.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {linked && <div className="beat-linked">{labels.linkedTo.replace('{t}', linked.title)}</div>}
    </div>
  );
}

/**
 * Story Flow — a three-act outline board (the "alur cerita" feature).
 * Beats are cards grouped by act, drag-reorderable inside an act, linkable
 * to a chapter, and can be sent to the AI as an outline-building prompt.
 * All actions run on the local DB — no AI required to plan.
 */
export function FlowView() {
  const t = useT();
  const ui = useUi();
  const { projects, chapters, flowBeats, activeProjectId, setActiveProject, load } = useData();

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverAct, setDragOverAct] = useState<number | null>(null);
  const [beforeId, setBeforeId] = useState<string | 'end' | null>(null);
  const [busy, setBusy] = useState(false);

  const project = projects.find((p) => p.id === activeProjectId) || projects[0] || null;
  const beats = useMemo(
    () => flowBeats.filter((b) => b.project_id === project?.id),
    [flowBeats, project?.id]
  );
  const projChapters = useMemo(
    () => chapters.filter((c) => c.project_id === project?.id),
    [chapters, project?.id]
  );

  useEffect(() => {
    if (!activeProjectId && projects.length) setActiveProject(projects[0].id);
  }, [activeProjectId, projects]);

  async function refresh() { await load(); }

  async function addBeat(act: 1 | 2 | 3) {
    if (!project) return;
    await dbCall('createFlowBeat', { projectId: project.id, act, title: t('flow.newBeat') });
    await refresh();
  }

  // The DB op takes `chapterId` (camelCase payload), so the patch type mirrors
  // that instead of the raw row's `chapter_id`.
  async function patchBeat(
    id: string,
    patch: Partial<Omit<FlowBeat, 'chapter_id' | 'id' | 'project_id'> & { chapterId?: string | null }>
  ) {
    await dbCall('updateFlowBeat', { id, ...patch });
    await refresh();
  }

  async function removeBeat(id: string) {
    await dbCall('deleteFlowBeat', { id });
    await refresh();
  }

  /** Move a beat: same-act reorder or cross-act move (HTML5 drag & drop). */
  async function dropBeat(act: 1 | 2 | 3) {
    setDragOverAct(null);
    setBeforeId(null);
    if (!dragId || !project) return;
    const beat = flowBeats.find((b) => b.id === dragId);
    setDragId(null);
    if (!beat) return;

    const targetList = beats
      .filter((b) => b.act === act && b.id !== beat.id)
      .sort((a, b) => a.position - b.position);
    const idx = beforeId === 'end' ? targetList.length : targetList.findIndex((b) => b.id === beforeId);

    if (beat.act === act) {
      // Reorder inside the act: rebuild the id order and persist it.
      const list = beats.filter((b) => b.act === act).sort((a, b) => a.position - b.position);
      const without = list.filter((b) => b.id !== beat.id);
      const at = idx < 0 ? without.length : idx;
      without.splice(at, 0, beat);
      await dbCall('reorderFlowBeats', { order: without.map((b) => b.id) });
    } else {
      // Move across acts: reposition + re-act in one patch. Fractional insert
      // BETWEEN neighbors — a flat 0.5 always lands after position 0, so the
      // top-of-list insert uses first-1 and the tail uses last+1.
      const at = idx < 0 ? targetList.length : idx;
      let pos: number;
      if (targetList.length === 0) pos = 0;
      else if (at === 0) pos = targetList[0].position - 1;
      else if (at >= targetList.length) pos = targetList[targetList.length - 1].position + 1;
      else pos = (targetList[at - 1].position + targetList[at].position) / 2;
      await dbCall('updateFlowBeat', { id: beat.id, act, position: pos });
      await normalizeAct(act);
    }
    await refresh();
  }

  /** Create a chapter from a beat: title + summary as seed content, link
   *  it back to the beat, and mark the beat as drafting. */
  async function writeBeat(b: FlowBeat) {
    if (!project) return;
    const ch = await dbCall<Chapter>('createChapter', {
      projectId: project.id,
      title: b.title,
      content: b.summary ? `${b.summary}\n\n` : '',
      status: 'draft'
    });
    await dbCall('updateFlowBeat', { id: b.id, chapterId: ch.id, status: 'drafting' });
    await useData.getState().load();
    // recordDelta(0, 0) used to overwrite the project's stored word count
    // with 0 — always pass the real total (delta 0 still refreshes `words`).
    const totalWords = useData
      .getState()
      .chapters.filter((c) => c.project_id === project.id)
      .reduce((a, c) => a + wordCount(c.content), 0);
    useWriteStats.getState().recordDelta(project.id, project.name, 0, totalWords);
    ui.toast(t('flow.beatToChapter').replace('{t}', b.title), 'ok');
  }

  /** Rewrite integer positions for every beat of an act (after 0.5 insertion). */
  async function normalizeAct(act: number) {
    if (!project) return;
    const list = beats.filter((b) => b.act === act).sort((a, b) => a.position - b.position);
    await dbCall('reorderFlowBeats', { order: list.map((b) => b.id) });
  }

  function onDragOverCard(e: React.DragEvent, target: FlowBeat) {
    if (!dragId || dragId === target.id) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setBeforeId(e.clientY < rect.top + rect.height / 2 ? target.id : 'end');
    setDragOverAct(target.act);
  }

  function onDragOverAct(e: React.DragEvent, act: number) {
    if (!dragId) return;
    e.preventDefault();
    setDragOverAct(act);
    setBeforeId('end');
  }

  /** Send the outline to the AI: ask for gaps, escalation, and next-beat advice. */
  async function askAi() {
    if (!project || busy) return;
    if (!beats.length) { ui.toast(t('flow.emptyFirst'), 'error'); return; }
    setBusy(true);
    try {
      const lines = ACTS.map(({ id, labelKey }) => {
        const list = beats.filter((b) => b.act === id).sort((a, b) => a.position - b.position);
        const body = list.map((b, i) => `   ${i + 1}. [${b.status}] ${b.title}${b.summary ? ' — ' + b.summary : ''}`).join('\n');
        return `${t(labelKey)}:\n${body || '   (empty)'}`;
      }).join('\n\n');
      const chapterMap = beats
        .filter((b) => b.chapter_id)
        .map((b) => {
          const ch = chapters.find((c) => c.id === b.chapter_id);
          return ch ? `- "${b.title}" -> chapter "${ch.title}" (${ch.status}, ${wordCount(ch.content)} words)` : '';
        })
        .filter(Boolean)
        .join('\n');
      const prompt = `${t('flow.aiPromptIntro')}\n\n${project.name}\n\n${lines}${chapterMap ? `\n\n${t('flow.aiPromptChapters')}\n${chapterMap}` : ''}\n\n${t('flow.aiPromptAsk')}`;
      (window as any).__inkwellPendingPrompt = prompt;
      useData.getState().navigate('chat');
      window.dispatchEvent(new CustomEvent('inkwell:pending-prompt'));
    } finally {
      setBusy(false);
    }
  }

  /** Generate three starter beats per act from the project description. */
  async function seedOutline() {
    if (!project || busy) return;
    setBusy(true);
    try {
      const existing = beats.length > 0;
      if (existing && !confirm(t('flow.seedConfirm'))) return;
      const starters: Record<number, { title: string; summary: string }[]> = {
        1: [
          { title: t('flow.seed1a'), summary: t('flow.seed1aS') },
          { title: t('flow.seed1b'), summary: t('flow.seed1bS') },
          { title: t('flow.seed1c'), summary: t('flow.seed1cS') }
        ],
        2: [
          { title: t('flow.seed2a'), summary: t('flow.seed2aS') },
          { title: t('flow.seed2b'), summary: t('flow.seed2bS') },
          { title: t('flow.seed2c'), summary: t('flow.seed2cS') }
        ],
        3: [
          { title: t('flow.seed3a'), summary: t('flow.seed3aS') },
          { title: t('flow.seed3b'), summary: t('flow.seed3bS') },
          { title: t('flow.seed3c'), summary: t('flow.seed3cS') }
        ]
      };
      for (const act of [1, 2, 3] as const) {
        for (const s of starters[act]) {
          await dbCall('createFlowBeat', { projectId: project.id, act, title: s.title, summary: s.summary });
        }
      }
      await refresh();
      ui.toast(t('flow.seeded'), 'ok');
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <div className="page">
        <h1>{t('flow.title')}</h1>
        <div className="empty-state">{t('flow.noProject')}</div>
      </div>
    );
  }

  const writtenCount = beats.filter((b) => b.status === 'written').length;
  const progress = beats.length ? Math.round((writtenCount / beats.length) * 100) : 0;

  return (
    <div className="page flow-page">
      <div className="flow-head">
        <div>
          <h1>{t('flow.title')}</h1>
          <div className="subtitle">{t('flow.sub')}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select value={project.id} onChange={(e) => setActiveProject(e.target.value)} aria-label={t('flow.pickProject')}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {beats.length === 0 && (
            <button onClick={seedOutline} disabled={busy}><Icon name="sparkle" size={14} /> {t('flow.seed')}</button>
          )}
          <button className="primary" onClick={askAi} disabled={busy || !beats.length}>
            <Icon name="sparkle" size={14} /> {t('flow.askAi')}
          </button>
        </div>
      </div>

      <div className="flow-progress">
        <div className="bar"><span style={{ width: `${progress}%` }} /></div>
        <span className="lbl">{t('flow.progress').replace('{w}', String(writtenCount)).replace('{n}', String(beats.length))}</span>
      </div>

      <div className="flow-board">
        {ACTS.map(({ id, labelKey, hintKey }) => {
          const list = beats.filter((b) => b.act === id).sort((a, b) => a.position - b.position);
          const active = dragOverAct === id;
          return (
            <div
              key={id}
              className={`flow-act ${active ? 'drag-over' : ''}`}
              onDragOver={(e) => onDragOverAct(e, id)}
              onDrop={(e) => { e.preventDefault(); dropBeat(id); }}
            >
              <div className="act-head">
                <h2>{t(labelKey)}</h2>
                <button className="small ghost" title={t('flow.addBeat')} aria-label={t('flow.addBeat')} onClick={() => addBeat(id)}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
              <div className="act-hint">{t(hintKey)}</div>

              {list.map((b) => {
                const linked = chapters.find((c) => c.id === b.chapter_id) || null;
                const dropBefore = beforeId === b.id && dragOverAct === id && dragId !== b.id;
                return (
                  <div
                    key={b.id}
                    className={`beat-wrap ${dropBefore ? 'drop-before' : ''}`}
                    onDragOver={(e) => onDragOverCard(e, b)}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropBeat(id); }}
                  >
                    <BeatCard
                      beat={b}
                      linked={linked}
                      chapters={projChapters}
                      onPatch={patchBeat}
                      onRemove={removeBeat}
                      onDragStart={setDragId}
                      onDragEnd={() => { setDragId(null); setDragOverAct(null); setBeforeId(null); }}
                      labels={{
                        title: t('flow.beatTitle'),
                        summary: t('flow.beatSummary'),
                        summaryPh: t('flow.beatSummaryPh'),
                        cycle: t('flow.cycleStatus'),
                        link: t('flow.linkChapter'),
                        noChapter: t('flow.noChapter'),
                        del: t('flow.deleteBeat'),
                        linkedTo: t('flow.linkedTo'),
                        write: t('flow.writeBeat')
                      }}
                      onWrite={() => writeBeat(b)}
                    />
                  </div>
                );
              })}

              {list.length === 0 && <div className="act-empty">{t('flow.emptyAct')}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
