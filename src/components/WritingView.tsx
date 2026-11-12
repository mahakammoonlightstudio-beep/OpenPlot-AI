import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi, dbCall, uid, createProjectUi } from '../store';
import { Chapter, Provider } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { diffCounts, diffWords } from '../lib/textDiff';
import { buildSkillsBlock } from '../lib/prompt';
import { RevisionTimeline } from './RevisionTimeline';

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

type Action = 'critique' | 'rephrase' | 'expand' | 'shrink';

type Pending = {
  source: string;
  action: Action | 'custom';
  start: number;
  end: number;
  scope: 'passage' | 'chapter';
};
const ACTIONS: Action[] = ['critique', 'rephrase', 'expand', 'shrink'];

/** What each button actually asks the model for. */
const INSTRUCTIONS: Record<Action, string> = {
  critique:
    'Give a focused critique of this passage: its strengths, the three biggest problems, and one concrete fix for each. Do not rewrite the passage.',
  rephrase:
    'Rewrite this passage with the same meaning and information, in clearer, more natural prose. Return only the rewritten passage.',
  expand:
    'Expand this passage to about 1.5 times its length with concrete sensory detail, interiority and action, keeping every existing plot point. Return only the expanded passage.',
  shrink:
    'Cut this passage to about 60% of its length, keeping every plot point, character beat and line of dialogue that matters. Return only the shortened passage.'
};

const SYSTEM = [
  'You are a professional line editor for a novelist.',
  'Work only on the passage you are given: never invent plot, characters or facts that are not in it.',
  'Write in the language of the passage. Return plain prose with no preamble, headings or closing commentary unless the task asks for feedback.'
].join('\n');

/**
 * Writing workspace (v1.3.0): the manuscript board in the middle, the chapter
 * list on the left and an AI editor on the right. Unlike the chat workspaces it
 * has no sessions of its own — the chapter being edited is the session, so the
 * text you were writing is still there when you come back.
 */
export function WritingView() {
  const t = useT();
  const ui = useUi();
  const settings = useSettings();
  const chapters = useData((s) => s.chapters);
  const projects = useData((s) => s.projects);
  const providers = useData((s) => s.providers);
  const skills = useData((s) => s.skills);
  const activeProjectId = useData((s) => s.activeProjectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [resultLabel, setResultLabel] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Novel switcher: a panel over the board so changing project or chapter
  // never means leaving the draft.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Chapter-scoped revision history: the board is where rewrites happen, so
  // the timeline belongs one click away from the draft.
  const [timelineOpen, setTimelineOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const reqRef = useRef<string | null>(null);

  const scoped = useMemo(
    () => chapters
      .filter((c) => !activeProjectId || c.project_id === activeProjectId)
      .sort((a, b) => a.position - b.position),
    [chapters, activeProjectId]
  );
  const selected = scoped.find((c) => c.id === selectedId) || null;
  const project = projects.find((p) => p.id === activeProjectId) || null;
  // Writing has no chat row to carry per-chat /skill state, so it uses the
  // Writing category's globally enabled skills. This is what makes the category
  // functional instead of a label only Settings can see.
  const writingSkills = useMemo(
    () => skills.filter((s) => Number(s.enabled) === 1 && (!s.category || s.category === 'writing')),
    [skills]
  );
  const writingSkillsBlock = useMemo(
    () => buildSkillsBlock(writingSkills as any) || '',
    [writingSkills]
  );
  const novels = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  );
  const chaptersOf = (projectId: string) =>
    chapters.filter((c) => c.project_id === projectId).sort((a, b) => a.position - b.position);

  // Escape closes the novel switcher like any other panel.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen]);

  // Open the first chapter so the board is never empty for no reason.
  useEffect(() => {
    if (selectedId && scoped.some((c) => c.id === selectedId)) return;
    setSelectedId(scoped[0]?.id || null);
  }, [scoped, selectedId]);

  // Load the draft only when the chapter changes. A save reloads the chapter
  // rows, and that refresh must never overwrite what is still being typed.
  useEffect(() => {
    const ch = useData.getState().chapters.find((c) => c.id === selectedId);
    setTitle(ch?.title || '');
    setContent(ch?.content || '');
    setDirty(false);
    setResult('');
    setResultLabel('');
    setPending(null);
    setApplied(false);
    setError(null);
  }, [selectedId]);

  const models = useMemo(
    () => Array.from(new Set(providers.filter((p) => p.enabled).flatMap((p) => (Array.isArray(p.models) ? p.models : [])))),
    [providers]
  );
  useEffect(() => {
    if (!models.length) return;
    if (model && models.includes(model)) return;
    setModel(settings.defaultModel && models.includes(settings.defaultModel) ? settings.defaultModel : models[0]);
  }, [models, model, settings.defaultModel]);
  const provider: Provider | null = useMemo(
    () => providers.find((p) => p.enabled && (Array.isArray(p.models) ? p.models : []).includes(model || '')) || null,
    [providers, model]
  );

  // ---- saving ----
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  async function save() {
    if (!selected || !dirtyRef.current || saving) return;
    setSaving(true);
    try {
      await dbCall('updateChapter', {
        id: selected.id,
        title: title.trim() || t('writing.untitled'),
        content
      });
      await useData.getState().reloadChapters();
      setDirty(false);
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setSaving(false);
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  async function openTimeline() {
    if (!selectedId) return;
    if (dirty) await save();
    setTimelineOpen(true);
  }

  // Restore writes the chapter row directly; the board's draft loads only when
  // the chapter id changes, so sync it here explicitly.
  async function handleTimelineRestored(chapterId: string) {
    await useData.getState().reloadChapters();
    if (selectedId !== chapterId) return;
    const fresh = useData.getState().chapters.find((c) => c.id === chapterId);
    if (!fresh) return;
    setTitle(fresh.title);
    setContent(fresh.content);
    setDirty(false);
  }

  // Debounced autosave: the board is for writing, not for remembering to save.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => { void saveRef.current(); }, 1200);
    return () => clearTimeout(timer);
  }, [dirty, content, title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Switching chapters saves the current draft first — autosave may not have
   *  fired yet, and losing a paragraph to a click is not acceptable. */
  async function openChapter(id: string) {
    await save();
    setSelectedId(id);
  }

  /** Jump to a novel (and optionally a chapter inside it) from the switcher,
   *  saving the current draft first so the switch cannot lose a paragraph. */
  async function openFromPicker(projectId: string, chapterId: string | null) {
    await save();
    useData.getState().setActiveProject(projectId);
    setSelectedId(chapterId);
    setPickerOpen(false);
  }

  async function newChapter() {
    let projectId = activeProjectId;
    if (!projectId) {
      const p = await createProjectUi('Untitled project');
      projectId = p.id;
    }
    try {
      const row = await dbCall<Chapter>('createChapter', {
        projectId,
        title: `Chapter ${scoped.length + 1}`,
        content: '',
        status: 'draft'
      });
      await useData.getState().reloadChapters();
      setSelectedId(row.id);
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    }
  }

  // ---- AI editor ----
  /** Selected text + its offsets, otherwise the whole chapter. The offsets are
   *  what let Apply touch only the selection and let Text Dump restore it to
   *  the same slot later. */
  function passage(): Pending {
    const el = taRef.current;
    if (el && el.selectionStart !== el.selectionEnd) {
      return {
        source: content.slice(el.selectionStart, el.selectionEnd),
        action: 'custom',
        start: el.selectionStart,
        end: el.selectionEnd,
        scope: 'passage'
      };
    }
    return { source: content, action: 'custom', start: 0, end: content.length, scope: 'chapter' };
  }

  async function cancel() {
    const id = reqRef.current;
    if (!id) return;
    reqRef.current = null;
    setBusy(false);
    try { await window.inkwell.abort(id); } catch { /* already finished */ }
  }

  async function run(kind: Action | 'custom') {
    if (busy) return;
    if (!provider || !model) { ui.toast(t('writing.noModel'), 'error'); return; }
    const selection = passage();
    const text = selection.source.trim();
    if (!text) { ui.toast(t('writing.empty'), 'info'); return; }
    const instruction = kind === 'custom' ? ask.trim() : INSTRUCTIONS[kind];
    if (!instruction) return;
    setPending({ ...selection, action: kind });
    setApplied(false);

    const reqId = 'write-' + uid();
    reqRef.current = reqId;
    setBusy(true);
    setError(null);
    setResult('');
    setResultLabel(t('writing.' + kind));
    let acc = '';
    const off = window.inkwell.onAiChunk(({ reqId: id, chunk }) => {
      if (id !== reqId) return;
      if (chunk.type === 'text' && chunk.text) {
        acc += chunk.text;
        setResult(acc);
      }
    });
    try {
      const res = await window.inkwell.generate({
        reqId,
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          enabled: true,
          models: provider.models as string[],
          kind: (provider as any).kind
        },
        model: model!,
        messages: [
          { role: 'system', content: writingSkillsBlock ? `${SYSTEM}\n\n${writingSkillsBlock}` : SYSTEM },
          { role: 'user', content: `${instruction}\n\n---\n${text}` }
        ],
        temperature: 0.7,
        maxTokens: Math.max(1200, Math.min(8000, settings.maxTokens)),
        topP: 1,
        thinkingEnabled: false,
        toolsEnabled: false,
        projectId: activeProjectId
      });
      if (!res.ok) throw new Error(res.error || t('writing.failed'));
      setResult(res.data?.text || acc);
    } catch (e: any) {
      if (reqRef.current === reqId) {
        setError(e?.message || String(e));
        ui.toast(`${t('writing.failed')}: ${e?.message || e}`, 'error');
      }
    } finally {
      off();
      if (reqRef.current === reqId) {
        reqRef.current = null;
        setBusy(false);
      }
    }
  }

  async function applyResult(mode: 'replace' | 'append') {
    if (!result.trim() || !selected || applied) return;
    if (pending?.action === 'critique') return; // feedback, not replacement prose
    if (mode === 'replace' && pending) {
      // Keep the displaced passage before touching the chapter. Best-effort:
      // a dump failure must not lose the edit the user asked for.
      if (pending.source.trim() && pending.source !== result) {
        try {
          await dbCall('addTextDump', {
            projectId: selected.project_id,
            chapterId: selected.id,
            chapterTitle: title.trim() || selected.title,
            source: 'writing',
            action: pending.action === 'custom' ? 'edit' : pending.action,
            scope: pending.scope,
            original: pending.source,
            replacement: result,
            startOffset: pending.start,
            endOffset: pending.end
          });
        } catch { /* recovery is a safety net, not a blocker */ }
      }
      setContent(pending.scope === 'passage'
        ? content.slice(0, pending.start) + result + content.slice(pending.end)
        : result);
    } else {
      setContent(`${content.trimEnd()}\n\n${result}`);
    }
    setDirty(true);
    setApplied(true);
    ui.toast(t('writing.applied'), 'ok');
  }

  const diff = useMemo(
    () => (!busy && result && pending && pending.action !== 'critique'
      ? diffWords(pending.source, result)
      : []),
    [busy, result, pending]
  );
  const diffStat = useMemo(() => diffCounts(diff), [diff]);

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(result);
      ui.toast(t('writing.copied'), 'ok');
    } catch {
      ui.toast(t('chat.copyFailed'), 'error');
    }
  }

  return (
    <div className="page write-page">
      <header className="write-head">
        <div>
          <h1>{t('writing.title')}</h1>
          <p className="sub">
            {project ? `${project.name} · ` : ''}{t('writing.sub')}
          </p>
        </div>
        <div className="write-head-right">
          <button className={`small ${pickerOpen ? 'primary' : ''}`} onClick={() => setPickerOpen((v) => !v)}
            title={t('writing.switchHint')} aria-expanded={pickerOpen}>
            <Icon name="folder" size={13} /> {t('writing.projects')}
            {project ? ` · ${project.name}` : ''}
          </button>
          <span className={`write-status ${dirty ? 'dirty' : ''}`}>
            {saving ? t('writing.saving') : dirty ? t('writing.unsaved') : t('writing.saved')}
          </span>
          <button className="small ghost" onClick={() => { void openTimeline(); }} disabled={!selected}
            title={t('revision.openHint')}>
            <Icon name="clock" size={13} /> {t('revision.open')}
          </button>
          <button className="primary" onClick={() => { void save(); }} disabled={!selected || !dirty}>
            {t('writing.save')}
          </button>
        </div>
      </header>

      {pickerOpen && (
        <div className="write-picker-wrap" onClick={() => setPickerOpen(false)}>
          <div className="write-picker" role="dialog" aria-label={t('writing.projects')}
            onClick={(e) => e.stopPropagation()}>
            <div className="wp-head">
              <span>{t('writing.projects')}</span>
              <button className="small ghost" aria-label={t('confirm.cancel')} onClick={() => setPickerOpen(false)}>
                <Icon name="x" size={13} />
              </button>
            </div>
            <div className="wp-list">
              {novels.map((p) => {
                const list = chaptersOf(p.id);
                return (
                  <div key={p.id} className={`wp-project ${p.id === activeProjectId ? 'active' : ''}`}>
                    <button className="wp-project-name" onClick={() => { void openFromPicker(p.id, list[0]?.id || null); }}>
                      <Icon name="project" size={13} />
                      <span className="wp-name">{p.name}</span>
                      <em>{list.length}</em>
                    </button>
                    {list.length > 0 && (
                      <div className="wp-chapters">
                        {list.map((c) => (
                          <button key={c.id} className={`wp-chapter ${c.id === selectedId ? 'active' : ''} ${c.id === selectedId && p.id === activeProjectId ? 'current' : ''}`}
                            onClick={() => { void openFromPicker(p.id, c.id); }}>
                            <span className="wc-title">{c.title}</span>
                            <em>{wordCount(c.content)}</em>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!novels.length && <div className="hint">{t('writing.noProjects')}</div>}
            </div>
          </div>
        </div>
      )}

      <div className="write-body">
        <aside className="write-chapters" aria-label={t('writing.chapters')}>
          <div className="write-chapters-head">
            <span>{t('writing.chapters')}</span>
            <button className="small ghost" onClick={() => { void newChapter(); }}
              title={t('writing.newChapter')} aria-label={t('writing.newChapter')}>
              <Icon name="plus" size={12} />
            </button>
          </div>
          {scoped.map((c) => (
            <button key={c.id} className={`write-chapter ${c.id === selectedId ? 'active' : ''}`}
              onClick={() => { void openChapter(c.id); }}>
              <span className="wc-title">{c.title}</span>
              <span className="wc-words">{wordCount(c.content)}</span>
            </button>
          ))}
          {!scoped.length && <div className="hint">{t('writing.noChapters')}</div>}
        </aside>

        <section className="write-board">
          {selected ? (
            <>
              <input className="write-title" value={title}
                placeholder={t('writing.untitled')}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }} />
              <textarea
                ref={taRef}
                className="write-text"
                value={content}
                spellCheck
                placeholder={t('writing.placeholder')}
                onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                onBlur={() => { void save(); }}
              />
              <div className="write-foot">
                <span>{t('writing.words').replace('{n}', wordCount(content).toLocaleString())}</span>
                <span>{selected.status}</span>
              </div>
            </>
          ) : (
            <div className="write-empty">{t('writing.noChapters')}</div>
          )}
        </section>

        <aside className="write-ai" aria-label={t('writing.ai')}>
          <div className="write-ai-head">
            <Icon name="sparkle" size={13} /> <span>{t('writing.ai')}</span>
            {writingSkills.length > 0 && (
              <span className="write-skill-count" title={writingSkills.map((s) => s.name).join(', ')}>
                {t('writing.skillsActive').replace('{n}', String(writingSkills.length))}
              </span>
            )}
          </div>
          <p className="hint">{t('writing.aiHint')}</p>

          {models.length > 0 ? (
            <select className="write-model" value={model || ''} onChange={(e) => setModel(e.target.value)}
              aria-label={t('chat.model')}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <div className="hint">{t('writing.noModel')}</div>
          )}

          <div className="write-ai-actions">
            {ACTIONS.map((a) => (
              <button key={a} className="chip" disabled={busy} onClick={() => { void run(a); }}>
                {t('writing.' + a)}
              </button>
            ))}
          </div>

          <div className="write-ask">
            <input value={ask} placeholder={t('writing.customPh')}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run('custom'); } }} />
            <button className="small primary" disabled={busy || !ask.trim()} onClick={() => { void run('custom'); }}>
              {t('writing.run')}
            </button>
          </div>

          {busy && (
            <div className="write-busy">
              <span>{t('writing.running')}</span>
              <button className="link" onClick={() => { void cancel(); }}>{t('writing.cancel')}</button>
            </div>
          )}
          {error && <div className="write-error">{error}</div>}

          {!busy && !result && !error && (
            <div className="write-ai-empty">
              <span className="we-icon"><Icon name="sparkle" size={14} /></span>
              <p><strong>{t('writing.aiEmptyTitle')}</strong><br />{t('writing.aiEmpty')}</p>
              <div className="legend">
                <span className="add">+ {t('writing.diffAdded')}</span>
                <span className="del">− {t('writing.diffRemoved')}</span>
              </div>
            </div>
          )}

          {result && (
            <div className="write-result">
              <div className="wr-head">
                <span className={`wr-action ${pending?.action || 'edit'}`}>{resultLabel || t('writing.result')}</span>
                {pending && <span className="wr-scope">{pending.scope === 'passage' ? t('writing.selection') : t('writing.wholeChapter')}</span>}
              </div>
              {diff.length > 0 ? (
                <div className="write-diff" aria-label={t('writing.diffLabel')}>
                  {diff.map((part, i) => part.kind === 'same'
                    ? <span key={i}>{part.text}</span>
                    : part.kind === 'add'
                      ? <ins key={i} className="diff-add">{part.text}</ins>
                      : <del key={i} className="diff-del">{part.text}</del>)}
                </div>
              ) : (
                <pre>{result}</pre>
              )}
              {diff.length > 0 && (
                <div className="diff-legend">
                  <span className="add">+ {diffStat.added.toLocaleString()} {t('writing.diffAdded')}</span>
                  <span className="del">− {diffStat.removed.toLocaleString()} {t('writing.diffRemoved')}</span>
                </div>
              )}
              <div className="wr-actions">
                {pending?.action !== 'critique' && (
                  <>
                    <button className="small" disabled={!selected || applied} onClick={() => { void applyResult('replace'); }}>
                      {pending?.scope === 'passage' ? t('writing.replaceSelection') : t('writing.replace')}
                    </button>
                    <button className="small" disabled={!selected || applied} onClick={() => { void applyResult('append'); }}>{t('writing.append')}</button>
                  </>
                )}
                <button className="small ghost" onClick={() => { void copyResult(); }}>{t('writing.copy')}</button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {timelineOpen && selectedId && (
        <RevisionTimeline
          projectId={activeProjectId}
          chapterId={selectedId}
          onClose={() => setTimelineOpen(false)}
          onRestored={handleTimelineRestored}
        />
      )}
    </div>
  );
}
