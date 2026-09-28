import { useEffect, useMemo, useState } from 'react';
import { useData, dbCall } from '../store';
import { useWriteStats, statsSummary, dayKey, projectStreak, DayStat } from '../writeStats';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Chapter } from '../types';

export function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) || []).length;
}

function fmtDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// 0 = no words, 1..4 = rising intensity buckets
function heatLevel(delta: number): number {
  if (delta <= 0) return 0;
  if (delta < 50) return 1;
  if (delta < 200) return 2;
  if (delta < 500) return 3;
  return 4;
}

function StatCard({ icon, label, value, sub, accent }: { icon: any; label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className={`card stat-card ${accent ? 'accent' : ''}`}>
      <div className="stat-icon"><Icon name={icon} size={16} /></div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function StatsView() {
  const t = useT();
  const { chapters, projects, activeProjectId } = useData();
  const days = useWriteStats((s) => s.days);
  const projectDays = useWriteStats((s) => s.projectDays);
  const projectStats = useWriteStats((s) => s.projects);
  const setGoal = useWriteStats((s) => s.setGoal);
  const recordStakes = useWriteStats((s) => s.recordStakes);
  const clearStakes = useWriteStats((s) => s.clearStakes);
  const summary = useMemo(() => statsSummary(days), [days]);

  const [goalProjectId, setGoalProjectId] = useState<string | null>(activeProjectId);
  useEffect(() => {
    if (!goalProjectId && projects.length) setGoalProjectId(projects[0].id);
  }, [projects, goalProjectId]);

  // live word counts per project (chapters are the source of truth)
  const perProject = useMemo(() => {
    const map = new Map<string, { title: string; words: number; chapters: number }>();
    for (const p of projects) {
      map.set(p.id, { title: p.name, words: 0, chapters: 0 });
    }
    for (const c of chapters) {
      const entry = map.get(c.project_id);
      if (entry) {
        entry.words += wordCount(c.content);
        entry.chapters += 1;
      }
    }
    return map;
  }, [projects, chapters]);

  const totalWords = [...perProject.values()].reduce((a, p) => a + p.words, 0);

  // heatmap: 90 cells, oldest -> newest
  const heatCells = useMemo(() => {
    const cells: Array<{ key: string; delta: number }> = [];
    for (let i = 89; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * 86400000));
      cells.push({ key, delta: days[key]?.delta ?? 0 });
    }
    return cells;
  }, [days]);

  const goalPid = goalProjectId || projects[0]?.id || null;
  const goalProject = projects.find((p) => p.id === goalPid);
  const goal = goalPid ? projectStats[goalPid]?.goal || 0 : 0;
  const goalToday = days[dayKey()]?.delta ?? 0;
  const goalPct = goal > 0 ? Math.min(100, Math.round((goalToday / goal) * 100)) : 0;

  // story arc: chapters of the selected project, in order
  const [arcProjectId, setArcProjectId] = useState<string | null>(activeProjectId);
  const arcPid = arcProjectId || activeProjectId || projects[0]?.id || null;
  const arcChapters = useMemo(
    () => chapters.filter((c) => c.project_id === arcPid).sort((a, b) => a.position - b.position),
    [chapters, arcPid]
  );
  const arcStakes = arcPid ? projectStats[arcPid]?.stakes || {} : {};

  function aiAnalyze() {
    if (!arcChapters.length) return;
    const list = arcChapters.map((c, i) => `${i + 1}. ${c.title} (${wordCount(c.content)} words)`).join('\n');
    const prompt = `Analyze the story arc of my chapters below. For EACH chapter, rate the stakes/tension level from 1 (calm) to 10 (climax) and give a one-line reason. Use your chapter tools to read them if needed. End with a short verdict: does tension escalate well or flatline?\n\n${list}`;
    (window as any).__inkwellPendingPrompt = prompt;
    useData.getState().navigate('chat');
    window.dispatchEvent(new CustomEvent('inkwell:pending-prompt'));
  }

  const bestDayLabel = summary.best.delta > 0 && summary.best.key
    ? `${summary.best.delta.toLocaleString()} ${t('stats.wordsUnit')} · ${fmtDate(summary.best.key)}`
    : '—';

  return (
    <div className="page">
      <div className="page-narrow">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="target" size={19} /> {t('stats.title')}</h1>
        <div className="subtitle">{t('stats.sub')}</div>
        <div className="stats-quote">
          <span className="q">“{t('stats.quote')}”</span>
          <span className="by">— {t('stats.quoteBy')}</span>
        </div>

        <div className="stats-grid">
          <div className="card stat-card goal-card">
            <div className="stat-icon"><Icon name="target" size={16} /></div>
            <div className="stat-body">
              <div className="stat-label">{t('stats.dailyGoal')}: {goal > 0 ? `${goal.toLocaleString()} ${t('stats.wordsUnit')}` : '—'}</div>
              {goal > 0 ? (
                <>
                  <div className="stat-value">{goalPct}%</div>
                  <div className="goal-bar"><i style={{ width: `${goalPct}%` }} /></div>
                </>
              ) : (
                <div className="stat-value">—</div>
              )}
              <div className="goal-controls">
                <select value={goalPid || ''} onChange={(e) => setGoalProjectId(e.target.value || null)} aria-label="Project">
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input
                  type="number" min={0} step={50} placeholder="500"
                  value={goal || ''}
                  onChange={(e) => goalPid && setGoal(goalPid, Number(e.target.value) || 0)}
                  aria-label={t('stats.dailyGoal')}
                />
              </div>
            </div>
          </div>

          <StatCard icon="flame" label={t('stats.streak')} accent
            value={<>{summary.streak}<span className="unit"> {t('stats.daysUnit')}</span></>}
            sub={summary.streak > 0 ? undefined : t('stats.streakStart')} />
          <StatCard icon="quill" label={t('stats.today')} value={goalToday.toLocaleString()} sub={t('stats.wordsUnit')} />
          <StatCard icon="clock" label={t('stats.thisWeek')} value={summary.thisWeek.toLocaleString()} sub={t('stats.wordsUnit')} />
          <StatCard icon="bolt" label={t('stats.bestDay')} value={bestDayLabel} />
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('stats.activity')}</h3>
          <div className="hint" style={{ marginBottom: 10 }}>{t('stats.last90')}</div>
          <div className="heatmap" role="img" aria-label={t('stats.activity')}>
            {heatCells.map((c) => (
              <div key={c.key} className={`hm hm-${heatLevel(c.delta)}`} title={`${fmtDate(c.key)}: ${c.delta.toLocaleString()} ${t('stats.wordsUnit')}`} />
            ))}
          </div>
          <div className="heatmap-legend">
            <span>{t('stats.less')}</span>
            <span className="hm hm-0" /><span className="hm hm-1" /><span className="hm hm-2" /><span className="hm hm-3" /><span className="hm hm-4" />
            <span>{t('stats.more')}</span>
          </div>
        </div>

        <div className="stats-grid three">
          <StatCard icon="folder" label={t('app.projects')} value={projects.length} />
          <StatCard icon="book" label={t('app.chapters')} value={chapters.length} />
          <StatCard icon="quill" label={t('stats.totalWords')} value={totalWords.toLocaleString()} />
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('stats.progressBy')}</h3>
          {[...perProject.entries()].map(([pid, p]) => {
            const st = projectStats[pid];
            const pg = st?.goal || 0;
            const pstreak = projectStreak(projectDays?.[pid]);
            return (
              <div key={pid} className="proj-progress">
                <div className="pp-head">
                  <span className="pp-title">{p.title}</span>
                  {pg > 0
                    ? <span className="pp-nums">{p.words.toLocaleString()} / {pg.toLocaleString()} · {Math.min(100, Math.round((p.words / pg) * 100))}%</span>
                    : <span className="pp-nums dim">{p.chapters} {t('stats.chaptersUnit')} · {t('stats.noGoal')}</span>}
                </div>
                {pg > 0 && <div className="goal-bar"><i style={{ width: `${Math.min(100, Math.round((p.words / pg) * 100))}%` }} /></div>}
                {pstreak > 0 && (
                  <div className="pp-streak">
                    <Icon name="flame" size={12} /> {pstreak} {t('stats.daysUnit')}
                  </div>
                )}
              </div>
            );
          })}
          {perProject.size === 0 && <div className="hint">{t('story.nothing')}</div>}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, flex: 1 }}>{t('stats.storyArc')}</h3>
            <select value={arcPid || ''} onChange={(e) => setArcProjectId(e.target.value || null)} aria-label="Project">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="primary" onClick={aiAnalyze} disabled={!arcChapters.length}>
              <Icon name="bolt" size={14} /> {t('stats.aiAnalyze')}
            </button>
          </div>
          <div className="hint" style={{ margin: '6px 0 12px' }}>{t('stats.storyArcDesc')}</div>

          {arcChapters.length > 0 && (
            <div className="arc-bars">
              {arcChapters.map((c, i) => {
                const level = arcStakes[c.id] ?? 0;
                return (
                  <div key={c.id} className="arc-row" title={c.title}>
                    <span className="arc-label">Ch {i + 1}</span>
                    <span className="arc-title">{c.title}</span>
                    <div className="arc-track">
                      <i style={{ width: level > 0 ? `${level * 10}%` : undefined }} className={level >= 8 ? 'hot' : ''} />
                    </div>
                    <span className="arc-level">{level > 0 ? level : '—'}</span>
                    <select
                      className="arc-set"
                      value={level}
                      onChange={(e) => arcPid && recordStakes(arcPid, c.id, Number(e.target.value))}
                      aria-label={`${c.title}: stakes`}
                    >
                      <option value={0}>—</option>
                      {Array.from({ length: 10 }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                    </select>
                  </div>
                );
              })}
              {Object.keys(arcStakes).length > 0 && (
                <button className="small ghost" style={{ marginTop: 8 }} onClick={() => arcPid && clearStakes(arcPid)}>
                  {t('stats.clearArc')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="hint" style={{ textAlign: 'center', marginBottom: 30 }}>{t('stats.autoNote')}</div>
      </div>
    </div>
  );
}

// keep DayStat referenced for consumers importing from here
export type { DayStat };
