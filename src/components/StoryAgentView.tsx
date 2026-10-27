import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi, dbCall, uid, runAutomations } from '../store';
import { Provider, StoryPlanRow } from '../types';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import {
  AUDIENCES, Choice, DEFAULT_BRIEF, FORMATS, GENRES, LENGTHS, LENGTH_WORDS, POVS, TONES,
  CastBundle, PremiseOption, StoryBrief, StoryPlanState, EMPTY_PLAN,
  buildProjectSeed, castPrompt, normalizeCast, normalizeOutline, normalizePlanState,
  normalizePremises, optionLabel, outlinePrompt, parseAgentJson, premisePrompt
} from '../lib/storyAgent';

const BRIEF_KEY = 'openplot.agentBrief.v1';
const MAX_STEP = 4;

type Busy = null | 'premise' | 'cast' | 'outline';

function loadBrief(lang: 'en' | 'id'): StoryBrief {
  try {
    const raw = localStorage.getItem(BRIEF_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        ...DEFAULT_BRIEF,
        idea: typeof p.idea === 'string' ? p.idea : '',
        notes: typeof p.notes === 'string' ? p.notes : '',
        genres: Array.isArray(p.genres) && p.genres.some((g: string) => GENRES.some((x) => x.id === g))
          ? p.genres.filter((g: string) => GENRES.some((x) => x.id === g)).slice(0, 3)
          : DEFAULT_BRIEF.genres,
        tone: TONES.some((x) => x.id === p.tone) ? p.tone : DEFAULT_BRIEF.tone,
        pov: POVS.some((x) => x.id === p.pov) ? p.pov : DEFAULT_BRIEF.pov,
        length: LENGTHS.some((x) => x.id === p.length) ? p.length : DEFAULT_BRIEF.length,
        format: FORMATS.some((x) => x.id === p.format) ? p.format : DEFAULT_BRIEF.format,
        audience: AUDIENCES.some((x) => x.id === p.audience) ? p.audience : DEFAULT_BRIEF.audience,
        language: p.language === 'id' || p.language === 'en' ? p.language : lang
      };
    }
  } catch { /* corrupted local draft — start clean */ }
  return { ...DEFAULT_BRIEF, language: lang };
}

function modelsOf(providers: Provider[]): string[] {
  return Array.from(new Set(providers.filter((p) => p.enabled).flatMap((p) => (Array.isArray(p.models) ? p.models : []))));
}

function providerFor(providers: Provider[], model: string | null): Provider | null {
  if (!model) return null;
  return providers.find((p) => p.enabled && (Array.isArray(p.models) ? p.models : []).includes(model)) || null;
}

// ---------------------------------------------------------------- fragments --

function StepBar({ step, maxStep, onGo }: { step: number; maxStep: number; onGo: (n: number) => void }) {
  const t = useT();
  const labels = [t('agent.stepBrief'), t('agent.stepPremise'), t('agent.stepCast'), t('agent.stepOutline')];
  return (
    <div className="agent-steps" role="tablist" aria-label={t('agent.steps')}>
      {labels.map((label, i) => {
        const n = i + 1;
        const state = n === step ? 'active' : n < step ? 'done' : n <= maxStep ? 'ready' : 'locked';
        return (
          <button
            key={label}
            role="tab"
            aria-selected={n === step}
            aria-disabled={n > maxStep}
            className={`agent-step ${state}`}
            onClick={() => { if (n <= maxStep) onGo(n); }}
          >
            <span className="num">{state === 'done' ? <Icon name="check" size={12} /> : n}</span>
            <span className="label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChoiceChips({
  choices, value, onPick, multi, lang
}: {
  choices: Choice[];
  value: string | string[];
  onPick: (id: string) => void;
  multi?: boolean;
  lang: 'en' | 'id';
}) {
  const isOn = (id: string) => (Array.isArray(value) ? value.includes(id) : value === id);
  return (
    <div className="chips agent-chips">
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`chip ${isOn(c.id) ? 'active' : ''}`}
          title={(lang === 'id' ? c.hintId : c.hintEn) || undefined}
          aria-pressed={isOn(c.id)}
          onClick={() => onPick(c.id)}
        >
          {multi && isOn(c.id) ? '✓ ' : ''}{lang === 'id' ? c.id_label : c.en}
        </button>
      ))}
    </div>
  );
}

function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="agent-field">
      <div className="agent-field-label">{label}</div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function BusyPanel({ label, onCancel }: { label: string; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="agent-busy card">
      <span className="agent-spinner" aria-hidden />
      <div className="agent-busy-text">
        <b>{label}</b>
        <span>{t('agent.generatingHint')}</span>
      </div>
      <button className="small ghost" onClick={onCancel}><Icon name="stop" size={12} /> {t('agent.cancel')}</button>
    </div>
  );
}

// ------------------------------------------------------------------- view --

export function StoryAgentView() {
  const t = useT();
  const ui = useUi();
  const settings = useSettings();
  const { providers, setActiveProject, navigate } = useData();
  const allModels = useMemo(() => modelsOf(providers), [providers]);

  const [brief, setBrief] = useState<StoryBrief>(() => loadBrief(settings.lang));
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const [plan, setPlan] = useState<StoryPlanState>(EMPTY_PLAN);
  const [premises, setPremises] = useState<PremiseOption[]>([]);
  const [premiseIdx, setPremiseIdx] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [planRows, setPlanRows] = useState<StoryPlanRow[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const planIdRef = useRef<string | null>(null);
  const reqRef = useRef<string | null>(null);
  const creatingRef = useRef(false);
  const [model, setModel] = useState<string | null>(settings.defaultModel);
  const [projectName, setProjectName] = useState('');
  const [includeBible, setIncludeBible] = useState(true);
  const [includeChapters, setIncludeChapters] = useState(true);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; entries: number; chapters: number; beats: number } | null>(null);

  const lang = settings.lang;
  const provider = providerFor(providers, model);
  // Persist the brief locally so a crash / navigation never loses the options.
  useEffect(() => {
    try { localStorage.setItem(BRIEF_KEY, JSON.stringify(brief)); } catch { /* storage full */ }
  }, [brief]);

  // Follow the global default until the user picks a model in this view;
  // fall back to the first available model so the wizard is never blocked by
  // an unset default.
  useEffect(() => {
    if (allModels.length === 0) return;
    if (model && allModels.includes(model)) return;
    if (settings.defaultModel && allModels.includes(settings.defaultModel)) setModel(settings.defaultModel);
    else setModel(allModels[0]);
  }, [settings.defaultModel, model, allModels]);

  const refreshPlans = async () => {
    try { setPlanRows((await dbCall<StoryPlanRow[]>('listStoryPlans')) || []); } catch { /* list is optional */ }
  };
  useEffect(() => { refreshPlans(); }, []);
  useEffect(() => {
    if (plan.premise && !projectName) setProjectName(plan.premise.title);
  }, [plan.premise, projectName]);

  const setPlanIdBoth = (id: string | null) => { planIdRef.current = id; setPlanId(id); };

  async function persistPlan(next: StoryPlanState) {
    try {
      const row = await dbCall<StoryPlanRow>('saveStoryPlan', {
        id: planIdRef.current || undefined,
        title: next.premise?.title || brief.idea.trim().slice(0, 80) || 'Untitled story plan',
        projectId: useData.getState().activeProjectId,
        brief,
        plan: next
      });
      setPlanIdBoth(row.id);
      refreshPlans();
    } catch (e: any) {
      ui.toast(e?.message || t('agent.saveFail'), 'error');
    }
  }

  async function callAgent(label: Busy, system: string, user: string): Promise<string> {
    const p = providerFor(useData.getState().providers, model);
    if (!p) { ui.toast(t('agent.noModel'), 'error'); throw new Error(t('agent.noModel')); }
    const reqId = 'agent-' + uid();
    reqRef.current = reqId;
    setBusy(label);
    setError(null);
    try {
      const res = await window.inkwell.generate({
        reqId,
        provider: {
          id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey,
          enabled: true, models: p.models as string[], kind: (p as any).kind
        },
        model: model!,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.85,
        maxTokens: Math.max(3000, Math.min(8000, settings.maxTokens)),
        topP: 1,
        thinkingEnabled: false,
        toolsEnabled: false,
        projectId: useData.getState().activeProjectId
      });
      if (reqRef.current !== reqId) throw new Error('aborted');
      if (!res.ok) throw new Error(res.error || t('agent.genFail'));
      return res.data?.text || '';
    } catch (e: any) {
      if (e?.message !== 'aborted') setError(e?.message || t('agent.genFail'));
      throw e;
    } finally {
      if (reqRef.current === reqId) { reqRef.current = null; setBusy(null); }
    }
  }

  async function cancelGeneration() {
    const id = reqRef.current;
    if (!id) return;
    reqRef.current = null;
    setBusy(null);
    try { await window.inkwell.abort(id); } catch { /* already finished */ }
  }

  // ------------------------------------------------------------- generate --

  async function generatePremises() {
    if (busy || reqRef.current) return;
    if (!model || !providerFor(providers, model)) { ui.toast(t('agent.noModel'), 'error'); return; }
    setError(null);
    try {
      const prompt = premisePrompt(brief);
      const raw = await callAgent('premise', prompt.system, prompt.user);
      const opts = normalizePremises(parseAgentJson(raw));
      if (!opts.length) throw new Error(t('agent.parseFail'));
      setPremises(opts);
      setPremiseIdx(null);
      // A new set of premises invalidates the old cast/outline: keeping them
      // would let a project from premise A silently reuse the cast of B.
      const cleared: StoryPlanState = { premise: null, cast: null, outline: null };
      setPlan(cleared);
      setExcluded(new Set());
      setMaxStep(2);
      setStep(2);
      await persistPlan(cleared);
    } catch (e: any) {
      if (e?.message && e.message !== 'aborted') setError(e.message);
    }
  }

  async function choosePremise(i: number) {
    const chosen = premises[i];
    if (!chosen) return;
    setPremiseIdx(i);
    setProjectName(chosen.title);
    const changed = plan.premise?.title !== chosen.title || plan.premise?.logline !== chosen.logline;
    const next: StoryPlanState = changed
      ? { premise: chosen, cast: null, outline: null }
      : { ...plan, premise: chosen };
    setPlan(next);
    if (changed) setExcluded(new Set());
    setMaxStep((s) => Math.max(s, 3));
    setStep(3);
    await persistPlan(next);
    if (!next.cast && !busy) void generateCast(next);
  }

  async function generateCast(base: StoryPlanState = plan) {
    if (busy || reqRef.current || !base.premise) return;
    setError(null);
    try {
      const prompt = castPrompt(brief, base.premise);
      const raw = await callAgent('cast', prompt.system, prompt.user);
      const cast = normalizeCast(parseAgentJson(raw));
      if (!cast) throw new Error(t('agent.parseFail'));
      // A fresh cast invalidates the outline that was built for the old one.
      const next: StoryPlanState = { ...base, cast, outline: null };
      setPlan(next);
      setExcluded(new Set());
      setMaxStep(3);
      await persistPlan(next);
    } catch (e: any) {
      if (e?.message && e.message !== 'aborted') setError(e.message);
    }
  }

  async function generateOutline(base: StoryPlanState = plan) {
    if (busy || reqRef.current || !base.premise || !base.cast) return;
    setError(null);
    try {
      const prompt = outlinePrompt(brief, base.premise, base.cast);
      const raw = await callAgent('outline', prompt.system, prompt.user);
      const outline = normalizeOutline(parseAgentJson(raw));
      if (!outline) throw new Error(t('agent.parseFail'));
      const next: StoryPlanState = { ...base, outline };
      setPlan(next);
      setMaxStep(MAX_STEP);
      setStep(4);
      await persistPlan(next);
    } catch (e: any) {
      if (e?.message && e.message !== 'aborted') setError(e.message);
    }
  }

  // --------------------------------------------------------------- project --

  const filteredCast: CastBundle | null = useMemo(() => {
    if (!plan.cast) return null;
    return {
      ...plan.cast,
      characters: plan.cast.characters.filter((c) => !excluded.has('c:' + c.name)),
      locations: plan.cast.locations.filter((l) => !excluded.has('l:' + l.name)),
      lore: plan.cast.lore.filter((l) => !excluded.has('r:' + l.title))
    };
  }, [plan.cast, excluded]);

  async function createProject() {
    if (!plan.premise || creating || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const seed = buildProjectSeed(brief, plan.premise, filteredCast, plan.outline, {
        name: projectName.trim() || plan.premise.title,
        includeBible,
        includeChapters
      });
      const res = await dbCall<any>('createProjectFromPlan', {
        project: seed.project,
        entries: seed.entries,
        chapters: seed.chapters,
        beats: seed.beats,
        planId: planIdRef.current || undefined
      });
      await useData.getState().load();
      setActiveProject(res.project.id);
      // Plot Smith creates a whole project in one call — the automation trigger
      // fires here too, so `project:created` has exactly one meaning.
      runAutomations('project:created', { projectId: res.project.id });
      setCreated({
        id: res.project.id,
        name: res.project.name,
        entries: Number(res.entries) || 0,
        chapters: Number(res.chapters) || 0,
        beats: Number(res.beats) || 0
      });
      ui.toast(t('agent.createdToast').replace('{n}', res.project.name), 'ok');
      refreshPlans();
    } catch (e: any) {
      setError(e?.message || t('agent.createFail'));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  function newPlan(clearBrief = false) {
    setPlan(EMPTY_PLAN);
    setPremises([]);
    setPremiseIdx(null);
    setExcluded(new Set());
    setPlanIdBoth(null);
    setCreated(null);
    setError(null);
    setMaxStep(1);
    setStep(1);
    setProjectName('');
    if (clearBrief) setBrief({ ...DEFAULT_BRIEF, language: lang });
  }

  async function loadPlan(id: string) {
    if (!id) return;
    try {
      const row = await dbCall<StoryPlanRow>('getStoryPlan', { id });
      let savedBrief = brief;
      try { savedBrief = { ...DEFAULT_BRIEF, ...JSON.parse(row.brief || '{}') }; } catch { /* keep current */ }
      let savedPlan = EMPTY_PLAN;
      try { savedPlan = normalizePlanState(JSON.parse(row.plan || '{}')); } catch { /* empty */ }
      setBrief(savedBrief);
      setPlan(savedPlan);
      setPlanIdBoth(row.id);
      setPremises(savedPlan.premise ? [savedPlan.premise] : []);
      setPremiseIdx(savedPlan.premise ? 0 : null);
      setExcluded(new Set());
      setCreated(null);
      setProjectName(savedPlan.premise?.title || '');
      setError(null);
      const furthest = savedPlan.outline ? 4 : savedPlan.cast ? 3 : savedPlan.premise ? 2 : 1;
      setMaxStep(furthest);
      setStep(furthest);
    } catch (e: any) {
      ui.toast(e?.message || t('agent.loadFail'), 'error');
    }
  }

  async function removePlan() {
    const id = planIdRef.current;
    if (!id) return;
    try {
      await dbCall('deleteStoryPlan', { id });
      refreshPlans();
      newPlan(false);
      ui.toast(t('agent.planDeleted'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || t('agent.saveFail'), 'error');
    }
  }

  function toggleExcluded(key: string) {
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const words = LENGTH_WORDS[brief.length] || 0;

  // ---------------------------------------------------------------- render --

  return (
    <div className="page agent-page">
      <div className="agent-header">
        <div>
          <h1><Icon name="sparkle" size={20} /> {t('agent.title')}</h1>
          <div className="subtitle">{t('agent.sub')}</div>
        </div>
        <div className="agent-model-picker">
          <label>{t('agent.model')}</label>
          {allModels.length > 0 ? (
            <select value={model || ''} onChange={(e) => setModel(e.target.value || null)} aria-label={t('agent.model')}>
              {allModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <button className="small" onClick={() => navigate('settings')}>
              <Icon name="settings" size={13} /> {t('agent.openSettings')}
            </button>
          )}
        </div>
      </div>

      <div className="agent-toolbar">
        <div className="agent-saved">
          <Icon name="scroll" size={13} />
          <select value={planId || ''} onChange={(e) => loadPlan(e.target.value)} aria-label={t('agent.savedPlans')} disabled={!!busy}>
            <option value="">{t('agent.savedPlans')} ({planRows.length})</option>
            {planRows.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
          {planId && (
            <button className="small ghost danger" onClick={removePlan} title={t('agent.deletePlan')} aria-label={t('agent.deletePlan')}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
        <button className="small ghost" onClick={() => newPlan(false)} disabled={!!busy}>
          <Icon name="plus" size={13} /> {t('agent.newPlan')}
        </button>
      </div>

      <StepBar step={step} maxStep={maxStep} onGo={(n) => { if (busy) return; setError(null); setStep(n); }} />

      {error && (
        <div className="agent-error" role="alert">
          <Icon name="bolt" size={14} />
          <span>{error}</span>
          <button className="small ghost" onClick={() => setError(null)} aria-label={t('agent.dismiss')}><Icon name="x" size={12} /></button>
        </div>
      )}

      {/* ---------------------------------------------------------- brief -- */}
      {step === 1 && (
        <div className="agent-panel card">
          <div className="agent-help">
            <Icon name="sparkle" size={14} />
            <span>{t('agent.briefHelp')}</span>
          </div>
          <FieldGroup label={t('agent.idea')} hint={t('agent.ideaHint')}>
            <textarea
              rows={3}
              value={brief.idea}
              onChange={(e) => setBrief({ ...brief, idea: e.target.value })}
              placeholder={t('agent.ideaPh')}
            />
          </FieldGroup>
          <div className="agent-grid-2">
            <FieldGroup label={t('agent.genres')} hint={t('agent.genresHint')}>
              <ChoiceChips
                choices={GENRES}
                lang={lang}
                multi
                value={brief.genres}
                onPick={(id) => {
                  setBrief((b) => {
                    const has = b.genres.includes(id);
                    if (has) return { ...b, genres: b.genres.length > 1 ? b.genres.filter((g) => g !== id) : b.genres };
                    return { ...b, genres: [...b.genres, id].slice(0, 3) };
                  });
                }}
              />
            </FieldGroup>
            <FieldGroup label={t('agent.tone')} hint={t('agent.toneHint')}>
              <ChoiceChips choices={TONES} lang={lang} value={brief.tone} onPick={(id) => setBrief({ ...brief, tone: id })} />
            </FieldGroup>
          </div>
          <div className="agent-grid-2">
            <FieldGroup label={t('agent.pov')} hint={t('agent.povHint')}>
              <ChoiceChips choices={POVS} lang={lang} value={brief.pov} onPick={(id) => setBrief({ ...brief, pov: id })} />
            </FieldGroup>
            <FieldGroup label={t('agent.length')} hint={words ? t('agent.lengthHint').replace('{n}', words.toLocaleString()) : t('agent.lengthHintPlain')}>
              <ChoiceChips choices={LENGTHS} lang={lang} value={brief.length} onPick={(id) => setBrief({ ...brief, length: id })} />
            </FieldGroup>
          </div>
          <div className="agent-grid-3">
            <FieldGroup label={t('agent.format')}>
              <ChoiceChips
                choices={FORMATS.map((f) => ({ id: f.id, en: f.en, id_label: f.id_label }))}
                lang={lang}
                value={brief.format}
                onPick={(id) => setBrief({ ...brief, format: id as StoryBrief['format'] })}
              />
            </FieldGroup>
            <FieldGroup label={t('agent.audience')}>
              <ChoiceChips
                choices={AUDIENCES.map((a) => ({ id: a.id, en: a.en, id_label: a.id_label }))}
                lang={lang}
                value={brief.audience}
                onPick={(id) => setBrief({ ...brief, audience: id as StoryBrief['audience'] })}
              />
            </FieldGroup>
            <FieldGroup label={t('agent.language')}>
              <div className="chips agent-chips">
                <button className={`chip ${brief.language === 'en' ? 'active' : ''}`} onClick={() => setBrief({ ...brief, language: 'en' })}>English</button>
                <button className={`chip ${brief.language === 'id' ? 'active' : ''}`} onClick={() => setBrief({ ...brief, language: 'id' })}>Bahasa Indonesia</button>
              </div>
            </FieldGroup>
          </div>
          <FieldGroup label={t('agent.notes')} hint={t('agent.notesHint')}>
            <input value={brief.notes} onChange={(e) => setBrief({ ...brief, notes: e.target.value })} placeholder={t('agent.notesPh')} />
          </FieldGroup>
          <div className="agent-actions">
            <div className="hint">{t('agent.nextHint')}</div>
            <button className="primary" onClick={generatePremises} disabled={!!busy || !provider}>
              <Icon name="sparkle" size={14} /> {t('agent.generatePremises')}
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------- premise -- */}
      {step === 2 && (
        <div className="agent-panel">
          <div className="agent-panel-head">
            <div className="agent-help">
              <Icon name="sparkle" size={14} />
              <span>{t('agent.premiseHelp')}</span>
            </div>
            <button className="small ghost" onClick={() => setStep(1)} disabled={!!busy}>{t('agent.editBrief')}</button>
          </div>
          <div className="agent-brief-strip">
            <span><b>{t('agent.genres')}:</b> {brief.genres.map((g) => optionLabel(GENRES, g, lang)).join(', ')}</span>
            <span><b>{t('agent.tone')}:</b> {optionLabel(TONES, brief.tone, lang)}</span>
            <span><b>{t('agent.pov')}:</b> {optionLabel(POVS, brief.pov, lang)}</span>
            <span><b>{t('agent.length')}:</b> {optionLabel(LENGTHS, brief.length, lang)}</span>
          </div>
          {busy === 'premise' ? (
            <BusyPanel label={t('agent.generatingPremise')} onCancel={cancelGeneration} />
          ) : (
            <>
              {premises.length > 0 && (
                <div className="agent-card-grid">
                  {premises.map((p, i) => (
                    <div key={i} className={`agent-card ${premiseIdx === i ? 'selected' : ''}`}>
                      <div className="agent-card-top">
                        <span className="agent-badge">{t('agent.option')} {i + 1}</span>
                        {premiseIdx === i && <span className="agent-picked"><Icon name="check" size={12} /> {t('agent.picked')}</span>}
                      </div>
                      <h3>{p.title}</h3>
                      <p className="logline">{p.logline}</p>
                      {p.hook && <p className="agent-detail"><b>{t('agent.hook')}:</b> {p.hook}</p>}
                      {p.stakes && <p className="agent-detail"><b>{t('agent.stakes')}:</b> {p.stakes}</p>}
                      {p.openingImage && <p className="agent-detail muted"><b>{t('agent.opening')}:</b> {p.openingImage}</p>}
                      {p.themes.length > 0 && (
                        <div className="agent-tags">{p.themes.map((th) => <span key={th} className="agent-tag">{th}</span>)}</div>
                      )}
                      <button className="primary agent-card-action" onClick={() => choosePremise(i)} disabled={!!busy}>
                        {t('agent.usePremise')} <Icon name="chevronRight" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="agent-actions">
                <div className="hint">{t('agent.regenerateHint')}</div>
                <button className={premises.length ? 'ghost' : 'primary'} onClick={generatePremises} disabled={!!busy || !provider}>
                  <Icon name="refresh" size={14} /> {premises.length ? t('agent.regenerate') : t('agent.generatePremises')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ----------------------------------------------------------- cast -- */}
      {step === 3 && (
        <div className="agent-panel">
          <div className="agent-panel-head">
            <div className="agent-help">
              <Icon name="person" size={14} />
              <span>{t('agent.castHelp')}</span>
            </div>
            <button className="small ghost" onClick={() => setStep(2)} disabled={!!busy}>{t('agent.backToPremise')}</button>
          </div>
          {plan.premise && (
            <div className="agent-brief-strip">
              <span><b>{t('agent.premise')}:</b> {plan.premise.title} — {plan.premise.logline}</span>
            </div>
          )}
          {busy === 'cast' ? (
            <BusyPanel label={t('agent.generatingCast')} onCancel={cancelGeneration} />
          ) : plan.cast ? (
            <>
              {plan.cast.world.name || plan.cast.world.premise ? (
                <div className="agent-world card">
                  <div className="agent-section-title"><Icon name="globe" size={14} /> {t('agent.world')}: {plan.cast.world.name || t('agent.unnamed')}</div>
                  {plan.cast.world.premise && <p>{plan.cast.world.premise}</p>}
                  {plan.cast.world.rules && <p className="agent-detail"><b>{t('agent.rules')}:</b> {plan.cast.world.rules}</p>}
                  {plan.cast.world.conflict && <p className="agent-detail"><b>{t('agent.conflict')}:</b> {plan.cast.world.conflict}</p>}
                </div>
              ) : null}

              <div className="agent-section-title"><Icon name="person" size={14} /> {t('agent.characters')} <span className="agent-count">{plan.cast.characters.length}</span></div>
              <div className="agent-card-grid small">
                {plan.cast.characters.map((c) => {
                  const off = excluded.has('c:' + c.name);
                  return (
                    <div key={c.name} className={`agent-card compact ${off ? 'off' : ''}`}>
                      <label className="agent-toggle">
                        <input type="checkbox" checked={!off} onChange={() => toggleExcluded('c:' + c.name)} />
                        <span>{off ? t('agent.excluded') : t('agent.included')}</span>
                      </label>
                      <h4>{c.name}</h4>
                      {c.role && <div className="agent-role">{c.role}{c.age ? ` · ${c.age}` : ''}</div>}
                      {c.description && <p className="agent-detail">{c.description}</p>}
                      <div className="agent-mini-facts">
                        {c.want && <div><b>{t('agent.want')}:</b> {c.want}</div>}
                        {c.flaw && <div><b>{t('agent.flaw')}:</b> {c.flaw}</div>}
                        {c.secret && <div><b>{t('agent.secret')}:</b> {c.secret}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="agent-grid-2">
                <div>
                  <div className="agent-section-title"><Icon name="pin" size={14} /> {t('agent.locations')} <span className="agent-count">{plan.cast.locations.length}</span></div>
                  {plan.cast.locations.map((l) => {
                    const off = excluded.has('l:' + l.name);
                    return (
                      <div key={l.name} className={`agent-line ${off ? 'off' : ''}`}>
                        <label className="agent-toggle">
                          <input type="checkbox" checked={!off} onChange={() => toggleExcluded('l:' + l.name)} />
                        </label>
                        <div>
                          <b>{l.name}</b>
                          {l.description && <div className="agent-detail">{l.description}</div>}
                          {l.significance && <div className="agent-detail muted">{l.significance}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <div className="agent-section-title"><Icon name="scroll" size={14} /> {t('agent.lore')} <span className="agent-count">{plan.cast.lore.length}</span></div>
                  {plan.cast.lore.map((l) => {
                    const off = excluded.has('r:' + l.title);
                    return (
                      <div key={l.title} className={`agent-line ${off ? 'off' : ''}`}>
                        <label className="agent-toggle">
                          <input type="checkbox" checked={!off} onChange={() => toggleExcluded('r:' + l.title)} />
                        </label>
                        <div>
                          <b>{l.title}</b>
                          {l.content && <div className="agent-detail">{l.content}</div>}
                          {l.relevance && <div className="agent-detail muted">{l.relevance}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="agent-actions">
                <div className="hint">{t('agent.castNextHint')}</div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="ghost" onClick={() => generateCast()} disabled={!!busy}>
                    <Icon name="refresh" size={14} /> {t('agent.regenerate')}
                  </button>
                  <button className="primary" onClick={() => generateOutline()} disabled={!!busy || !provider}>
                    <Icon name="sparkle" size={14} /> {t('agent.generateOutline')}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="agent-empty">
              <Icon name="person" size={26} />
              <h3>{t('agent.castEmpty')}</h3>
              <p>{t('agent.castEmptyHint')}</p>
              <button className="primary" onClick={() => generateCast()} disabled={!!busy || !provider}>
                <Icon name="sparkle" size={14} /> {t('agent.generateCast')}
              </button>
            </div>
          )}
          {busy === 'outline' && <BusyPanel label={t('agent.generatingOutline')} onCancel={cancelGeneration} />}
        </div>
      )}

      {/* -------------------------------------------------------- outline -- */}
      {step === 4 && (
        <div className="agent-panel">
          <div className="agent-panel-head">
            <div className="agent-help">
              <Icon name="target" size={14} />
              <span>{t('agent.outlineHelp')}</span>
            </div>
            <button className="small ghost" onClick={() => setStep(3)} disabled={!!busy}>{t('agent.backToCast')}</button>
          </div>
          {busy === 'outline' ? (
            <BusyPanel label={t('agent.generatingOutline')} onCancel={cancelGeneration} />
          ) : plan.outline ? (
            <>
              <div className="agent-outline">
                {plan.outline.acts.map((a) => (
                  <div key={a.act} className="agent-act">
                    <div className="agent-act-head">
                      <span className="agent-act-num">{t('agent.act')} {a.act}</span>
                      <b>{a.title}</b>
                    </div>
                    {a.summary && <div className="agent-detail muted">{a.summary}</div>}
                    <div className="agent-beats">
                      {a.beats.map((b, i) => (
                        <div key={`${b.title}-${i}`} className="agent-beat">
                          <span className="dot" />
                          <div>
                            <b>{b.title}</b>
                            {b.summary && <div className="agent-detail">{b.summary}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="agent-section-title" style={{ marginTop: 14 }}>
                <Icon name="book" size={14} /> {t('agent.chapterPlan')} <span className="agent-count">{plan.outline.chapters.length}</span>
              </div>
              <div className="agent-chapter-grid">
                {plan.outline.chapters.map((c, i) => (
                  <div key={`${c.title}-${i}`} className="agent-chapter">
                    <span className="agent-chapter-num">{i + 1}</span>
                    <div>
                      <b>{c.title}</b>
                      {c.summary && <div className="agent-detail">{c.summary}</div>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="agent-create card">
                <div className="agent-section-title"><Icon name="folderPlus" size={14} /> {t('agent.finish')}</div>
                {created ? (
                  <div className="agent-success">
                    <div className="agent-success-icon"><Icon name="check" size={20} /></div>
                    <div>
                      <b>{t('agent.created').replace('{n}', created.name)}</b>
                      <div className="agent-detail">
                        {t('agent.createdStats')
                          .replace('{entries}', String(created.entries))
                          .replace('{chapters}', String(created.chapters))
                          .replace('{beats}', String(created.beats))}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button className="primary" onClick={() => { setActiveProject(created.id); navigate('chapters'); }}>
                        <Icon name="book" size={13} /> {t('agent.openChapters')}
                      </button>
                      <button className="ghost" onClick={() => { setActiveProject(created.id); navigate('story'); }}>
                        <Icon name="globe" size={13} /> {t('agent.openStory')}
                      </button>
                      <button className="ghost" onClick={() => newPlan(false)}>{t('agent.newPlan')}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="agent-create-grid">
                      <label className="agent-create-field">
                        <span>{t('agent.projectName')}</span>
                        <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder={plan.premise?.title || t('agent.projectName')} />
                      </label>
                      <label className="agent-check"><input type="checkbox" checked={includeBible} onChange={(e) => setIncludeBible(e.target.checked)} /> {t('agent.includeBible')}</label>
                      <label className="agent-check"><input type="checkbox" checked={includeChapters} onChange={(e) => setIncludeChapters(e.target.checked)} /> {t('agent.includeChapters')}</label>
                    </div>
                    <div className="hint" style={{ marginTop: 8 }}>
                      {t('agent.createHint')
                        .replace('{entries}', String(includeBible ? (filteredCast?.characters.length || 0) + (filteredCast?.locations.length || 0) + (filteredCast?.lore.length || 0) + (filteredCast?.world.premise ? 1 : 0) : 0))
                        .replace('{chapters}', String(includeChapters ? plan.outline.chapters.length : 0))}
                    </div>
                    <div className="agent-actions" style={{ marginTop: 12 }}>
                      <button className="ghost" onClick={() => generateOutline()} disabled={!!busy || !provider}>
                        <Icon name="refresh" size={14} /> {t('agent.regenerateOutline')}
                      </button>
                      <button className="primary" onClick={createProject} disabled={creating || !plan.premise || !projectName.trim()}>
                        {creating ? <span className="agent-spinner small" aria-hidden /> : <Icon name="folderPlus" size={14} />}
                        {creating ? t('agent.creating') : t('agent.createProject')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="agent-empty">
              <Icon name="target" size={26} />
              <h3>{t('agent.outlineEmpty')}</h3>
              <p>{t('agent.outlineEmptyHint')}</p>
              <button className="primary" onClick={() => generateOutline()} disabled={!!busy || !provider || !plan.cast}>
                <Icon name="sparkle" size={14} /> {t('agent.generateOutline')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="agent-footer-hint">
        <Icon name="bolt" size={12} /> {t('agent.footerHint')}
      </div>
    </div>
  );
}
