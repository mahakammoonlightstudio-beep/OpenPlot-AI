import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi, dbCall } from '../store';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Popover, MenuItem } from './Ui';
import { Provider, SkillCategory, SkillRow, StyleRow, ThinkingSupport } from '../types';
import {
  PROMPT_LIBRARY, PROMPT_CATEGORIES, applyPromptTemplate, mergePrompts,
  buildPromptBundle, parsePromptImport, notePromptUse, promptUsage,
  LibraryPrompt, PromptCategory
} from '../promptLibrary';
import { PromptEditorModal } from './PromptEditorModal';
import { FilePreviewModal } from './FilePreviewModal';
import { MentionCandidate, mentionToken, buildCandidates } from '../mentions';
import { formatBytes, attachmentBytes } from '../lib/chatFiles';
import { thinkingSupport } from '../lib/modelCaps';
import { CHAT_MODES, ChatMode, matchSkills } from '../lib/prompt';

/**
 * The bottom composer:
 *  - project chip on top (select project, X to detach)
 *  - textarea with "/" trigger for the Prompt Library
 *  - left row: + ADD panel (attachments / prompt library / goal)
 *  - right row: model picker, thinking On/Off popover, round send button
 * The component is fully controlled — state (input, model, thinking, tools…)
 * lives in ChatView so streaming + send logic stays in one place.
 */
export function Composer({
  input, setInput, onSend, streaming, onAbort,
  effModel, effProvider, allModels, onPickModel,
  thinkOn, setThinkOn,  thinkSupport, thinkingUi, thinkBudget, setThinkBudget, maxThinkBudget, onPickThinkLevel, thinkLevelMode,
  webSearchOn, onToggleWebSearch, mode, onPickMode, modes, agentWorkspace, workspace, skillsOn, onRunSkillCommand,
  chatProjectId, onPickProject, onDetachProject,
  goal, setGoal,
  wordCount,
  styles, activeStyleId, onPickStyle,
  attachments, onRemoveAttachment, onAttachClick,
  chatSkillsOff, onToggleSkill, chatId,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  streaming: boolean;
  onAbort: () => void;
  effModel: string | null;
  effProvider: Provider | null;
  allModels: string[];
  onPickModel: (m: string) => void;
  thinkOn: boolean;
  setThinkOn: (v: boolean) => void;
  /** What the selected model can actually expose (Task 4). */
  thinkSupport: ThinkingSupport;
  /** auto hides the control for `no` models; always keeps the plain switch. */
  thinkingUi: 'auto' | 'always';
  /** Per-chat reasoning budget, already bounded by the context window. */
  thinkBudget: number;
  setThinkBudget: (v: number) => void;
  /** Persists the picked level on the chat row (v8). */
  onPickThinkLevel?: (level: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max') => void;
  /** The level stored on the chat row; 'auto' = follow Settings. */
  thinkLevelMode?: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';
  maxThinkBudget: number;
  /** Web research for this chat: search + fetch without the agent loop. */
  webSearchOn: boolean;
  onToggleWebSearch: (v: boolean) => void;
  /** Working mode — prompt-level, works with any model, agent mode or not. */
  mode: ChatMode;
  onPickMode: (m: ChatMode) => void;
  /** Which modes this desk offers: Chat = plan + brainstorm, Agent = all four. */
  modes?: ChatMode[];
  /** True in the Agent workspace, where the bar shows an agent status chip. */
  agentWorkspace?: boolean;
  /** Which desk this composer belongs to; the skill picker recommends its category first. */
  workspace?: 'chat' | 'agent';
  /** Skill ids switched on for this chat (/skill). */
  skillsOn: string[];
  onRunSkillCommand: (cmd: { all: true } | { name: string }) => void;
  chatProjectId: string | null;
  onPickProject: (id: string) => void;
  onDetachProject: () => void;
  /** Session goal (pinned instruction) — owned by ChatView, injected into the system prompt. */
  goal: string | null;
  setGoal: (v: string | null) => void;
  wordCount: number;
  /** Reply styles (builtin + custom) and the active pick. */
  styles: StyleRow[];
  activeStyleId: string | null;
  onPickStyle: (id: string | null) => void;
  /** Files/story/chapter cards for the NEXT message. */
  attachments: Array<{ id: string; name: string; kind: 'file' | 'story' | 'chapter'; content: string; bytes?: number }>;
  onRemoveAttachment: (id: string) => void;
  onAttachClick: () => void | Promise<void>;
  /** Skill ids this chat muted in the composer popover. */
  chatSkillsOff?: string[];
  onToggleSkill?: (id: string) => void;
  /** Active chat, used only to count prompt-library insertions per chat. */
  chatId?: string | null;
}) {
  const t = useT();
  const ui = useUi();
  // Chat plans and brainstorms; writing/revising lives in the Agent workspace.
  const modeList = modes && modes.length ? modes : CHAT_MODES;
  // Narrow selectors (Task 11): the composer re-rendered on every data-store
  // write — including story-bible edits and message reloads — because it
  // subscribed to the whole store.
  const projects = useData((s) => s.projects);
  const providers = useData((s) => s.providers);
  const userPrompts = useData((s) => s.userPrompts);
  const skills = useData((s) => s.skills);
  const modelCaps = useSettings((s) => s.modelCaps);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Skills that actually reach the prompt: enabled in Settings AND not muted
  // for this chat. The popover toggles the per-chat half.
  const offSkills = chatSkillsOff || [];
  // Skills that actually reach the prompt: on globally OR switched on for this
  // chat with /skill, and not muted here.
  const onSkills = skillsOn || [];
  const isSkillActive = (s: SkillRow) =>
    (Number(s.enabled) === 1 || onSkills.includes(s.id)) && !offSkills.includes(s.id);
  const enabledSkills = skills.filter(isSkillActive);
  // Categories are a recommendation, not a second permission gate: this desk's
  // skills come first, while active skills from another desk stay reachable
  // instead of disappearing from a picker that claims to show what is on.
  const categoryOf = (s: { category?: string }): SkillCategory =>
    s.category === 'chat' || s.category === 'agent' || s.category === 'writing' ? s.category : 'writing';
  const desk: SkillCategory = workspace === 'agent' ? 'agent' : 'chat';
  const deskSkills = skills.filter((s) => categoryOf(s) === desk);
  const otherSkills = skills.filter((s) => categoryOf(s) !== desk);
  const orderedSkills = [...deskSkills, ...otherSkills];
  const skillCmd = /^\/skill\b\s*\/?\s*(.*)$/i.exec(input);
  const skillCmdQuery = skillCmd ? (skillCmd[1] || '').trim() : null;
  const skillCmdItems = skillCmdQuery === null
    ? []
    : (skillCmdQuery ? matchSkills(orderedSkills, skillCmdQuery) : orderedSkills).slice(0, 8);

  function skillToggleRow(s: SkillRow) {
    const active = isSkillActive(s);
    const muted = offSkills.includes(s.id);
    return (
      <label
        key={s.id}
        className={`skill-toggle ${active ? '' : 'off'} ${muted ? 'muted' : ''}`}
        title={s.description || s.content.slice(0, 120)}
      >
        <input
          type="checkbox"
          checked={active}
          disabled={!onToggleSkill}
          onChange={() => onToggleSkill?.(s.id)}
        />
        <span className="skill-toggle-text">
          <span className="t">{s.name}</span>
          {s.description ? <small>{s.description}</small> : null}
        </span>
        <span className="skill-toggle-cat">{t(`skills.category.${categoryOf(s)}`)}</span>
        {!active && <span className="badge">{t('composer.skillOff')}</span>}
      </label>
    );
  }
  const draftTokens = Math.ceil((input || '').length / 4);
  // Hide the thinking control entirely when the model cannot expose reasoning;
  // the `always` preference keeps the familiar On/Off switch (with a hint that
  // this model may ignore it).
  const showThink = thinkSupport !== 'no' || thinkingUi === 'always';
  const thinkTitle = thinkSupport === 'no'
    ? t('think.mayIgnore')
    : thinkSupport === 'unknown'
      ? t('think.unverifiedTitle')
      : t('chat.think');
  const [addOpen, setAddOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkOpen, setThinkOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  // Attachment preview lives here because the composer already holds the
  // in-memory content — no DB round-trip until the message is sent.
  const [previewFile, setPreviewFile] = useState<{ name: string; kind: 'file' | 'story' | 'chapter'; bytes: number; content: string } | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const activeStyle = styles.find((s) => s.id === activeStyleId) || null;
  const chatProject = projects.find((p) => p.id === chatProjectId) || null;

  // ---- @-mentions (story bible & chapters) ----
  // Typing "@word" opens a picker; inserting appends a compact token like
  // @["character:Kael Ardent"] that ChatView expands before sending.
  const story = useData((s) => s.story);
  const chapters = useData((s) => s.chapters);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionCandidates = useMemo(
    () => buildCandidates(story, chapters, chatProjectId),
    [story, chapters, chatProjectId]
  );
  const mentionItems = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    const list = q ? mentionCandidates.filter((c) => c.title.toLowerCase().includes(q)) : mentionCandidates;
    return list.slice(0, 8);
  }, [mentionQuery, mentionCandidates]);
  const mentionOpen = mentionQuery !== null;

  function detectMention(v: string) {
    const m = /(?:^|\s)@([^\s]*)$/.exec(v);
    setMentionQuery(m ? m[1] : null);
    setMentionIdx(0);
  }

  function insertMention(c: MentionCandidate) {
    const el = taRef.current;
    if (!el) { setMentionQuery(null); return; }
    // Replace the trailing "@query" fragment with the full token.
    const pos = el.selectionStart ?? input.length;
    const before = input.slice(0, pos).replace(/@[^\s]*$/, mentionToken(c));
    const next = before + input.slice(pos);
    setInput(next);
    setMentionQuery(null);
    setTimeout(() => {
      const end = before.length;
      try { el.setSelectionRange(end, end); el.focus(); } catch { /* not focusable */ }
    }, 0);
  }

  // ---- Prompt Library ----
  // Opens when the input starts with "/" — the text after the slash doubles as
  // a live filter AND as the seed for the template's first {placeholder}.
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptCat, setPromptCat] = useState<PromptCategory | null>(null);
  // Hovered/focused prompt → live preview under the list. `usageTick` forces a
  // re-read of the session counters after an insertion.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  const [editorState, setEditorState] = useState<
    | { mode: 'new'; seed?: string }
    | { mode: 'edit'; prompt: LibraryPrompt }
    | null
  >(null);
  const allPrompts = mergePrompts(userPrompts);
  const userOnly = allPrompts.filter((p) => p.category === 'user');
  const promptSeed = promptOpen && input.startsWith('/') ? input.slice(1) : '';
  const promptQuery = promptSeed.trim().toLowerCase();
  const promptItems = allPrompts.filter(
    (p) =>
      (!promptCat || p.category === promptCat) &&
      (!promptQuery || p.label.toLowerCase().includes(promptQuery) || p.desc.toLowerCase().includes(promptQuery))
  );
  // Which category sections to render. With a live query, user prompts MUST
  // be included — the dedicated "Mine" block below only renders when the
  // query is empty, and the old loop skipped category 'user' entirely, so
  // filtered custom prompts were invisible in the menu.
  const renderCats: PromptCategory[] = promptCat
    ? [promptCat]
    : promptQuery
      ? ['user', 'craft', 'bible', 'revise', 'chat']
      : ['craft', 'bible', 'revise', 'chat'];

  function handleInputChange(v: string) {
    setInput(v);
    detectMention(v);
    if (v.startsWith('/')) setPromptOpen(true);
    else if (promptOpen) setPromptOpen(false);
  }

  /** A click in the /skill list runs the command instead of inserting text. */
  function runSkill(name?: string) {
    onRunSkillCommand(name ? { name } : { all: true });
    setPromptOpen(false);
  }

  function insertPrompt(p: LibraryPrompt) {
    const text = applyPromptTemplate(p.template, promptSeed);
    notePromptUse(chatId, p.id);
    setUsageTick((n) => n + 1);
    setInput(text);
    setPromptOpen(false);
    // Focus + put the caret at the end once React has flushed the new value.
    setTimeout(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* not focusable */ }
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 220) + 'px';
    }, 0);
  }

  const openPromptLibrary = () => {
    setAddOpen(false);
    setInput(input.startsWith('/') ? input : '/');
    setPromptOpen(true);
    setTimeout(() => taRef.current?.focus(), 0);
  };

  // Global shortcut (native menu Ctrl+/ or command palette): only open from a
  // real chat with a DRAFT-SAFE seed — empty composer types a lone '/', but
  // existing text just opens the menu over it (the text doubles as filter).
  // The listener is attached ONCE and reads the latest draft from a ref;
  // re-binding it on every keystroke churned the listener list and could drop
  // a shortcut fired during the re-render gap.
  const openPromptsRef = useRef<() => void>(() => {});
  openPromptsRef.current = () => {
    if (streaming) return;
    if (input.trim()) {
      setPromptOpen(true);
      setTimeout(() => taRef.current?.focus(), 0);
    } else {
      openPromptLibrary();
    }
  };
  useEffect(() => {
    const handler = () => openPromptsRef.current();
    window.addEventListener('inkwell:open-prompts', handler);
    return () => window.removeEventListener('inkwell:open-prompts', handler);
  }, []);

  const isUserPrompt = (p: LibraryPrompt) => p.category === 'user' && p.id.startsWith('user-');
  const userRowId = (p: LibraryPrompt) => p.id.slice('user-'.length);

  async function deleteUserPrompt(p: LibraryPrompt) {
    await dbCall('deletePrompt', { id: userRowId(p) });
    await useData.getState().load();
    setEditorState(null);
    ui.toast(t('prompt.deleted'), 'ok');
  }

  const promptUses = useMemo(() => promptUsage(chatId), [chatId, usageTick]);
  const previewPrompt = allPrompts.find((p) => p.id === previewId) || null;

  /** Copy any prompt (builtin or mine) into my own library as an editable row. */
  async function duplicatePrompt(p: LibraryPrompt) {
    const title = `${p.label} (copy)`;
    await dbCall('createPrompt', { title, category: 'user', template: p.template });
    await useData.getState().load();
    ui.toast(t('prompt.duplicated').replace('{name}', title), 'ok');
  }

  async function exportPrompts() {
    if (!userPrompts.length) { ui.toast(t('prompt.exportEmpty'), 'info'); return; }
    const res = await window.inkwell.exportFile('openplot-prompt-library.json', buildPromptBundle(userPrompts), 'json');
    if (res.ok) ui.toast(t('prompt.exported').replace('{n}', String(userPrompts.length)), 'ok');
    else if (res.error !== 'cancelled') ui.toast(t('prompt.exportFailed'), 'error');
  }

  /** Pick one or more .json bundles; each file is parsed and deduped on its own
   *  so a single bad file cannot swallow the rest. */
  async function importPrompts() {
    const paths = await window.inkwell.pickFiles();
    if (!paths.length) return;
    const files = await window.inkwell.readFiles(paths, 2_000_000);
    if (!files.length) { ui.toast(t('prompt.importUnreadable'), 'error'); return; }
    let added = 0;
    let dupes = 0;
    const problems: string[] = [];
    for (const f of files) {
      const res = parsePromptImport(f.content, useData.getState().userPrompts);
      for (const p of res.accepted) await dbCall('createPrompt', p);
      added += res.accepted.length;
      dupes += res.duplicates;
      problems.push(...res.errors);
      await useData.getState().load();
    }
    if (added) ui.toast(t('prompt.imported').replace('{n}', String(added)), 'ok');
    else if (!problems.length) ui.toast(t('prompt.importNothing'), 'info');
    if (dupes) ui.toast(t('prompt.importSkipped').replace('{n}', String(dupes)), 'info');
    if (problems.length) ui.toast(problems[0], 'error');
  }

  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  };
  useEffect(() => { autoGrow(taRef.current); }, [input]);

  function saveComposerAsPrompt() {
    const text = input.trim();
    if (!text) return;
    setAddOpen(false);
    setEditorState({ mode: 'new', seed: text });
  }

  const hasProject = !!chatProject;

  // Thinking levels: the budget prop stays the source of truth, the level is
  // just the friendlier way to set it. Off/Low/Medium/High/Max covers what
  // providers actually accept (a plain model simply gets Off/On semantics
  // because anything above Off is a preference it may ignore).
  const THINK_LEVELS: Array<{ id: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'; budget: number }> = [
    { id: 'auto', budget: 0 },
    { id: 'off', budget: 0 },
    { id: 'low', budget: 2048 },
    { id: 'medium', budget: 8192 },
    { id: 'high', budget: 16384 },
    { id: 'max', budget: 32768 }
  ];
  const derivedLevel = !thinkOn ? 'off'
    : thinkBudget <= 2048 ? 'low'
      : thinkBudget <= 8192 ? 'medium'
        : thinkBudget <= 16384 ? 'high' : 'max';
  // A stored per-chat level wins over the derivation: 'auto' must read as
  // "following Settings", not as whatever budget Settings happens to hold.
  const thinkLevel = thinkLevelMode ?? derivedLevel;
  const pickLevel = (id: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max', budget: number) => {
    setThinkOpen(false);
    // 'auto' hands control back to Settings; the chat row stores the intent.
    if (id === 'auto') { onPickThinkLevel?.('auto'); return; }
    if (id === 'off') { setThinkOn(false); onPickThinkLevel?.('off'); return; }
    setThinkOn(true);
    setThinkBudget(Math.min(maxThinkBudget, Math.max(1024, budget)));
    onPickThinkLevel?.(id);
  };

  // Thinking lives in the ability row (tools / thinking / skills) instead of
  // the send toolbar; the popover keeps the per-chat budget for `yes` models.
  const thinkingControl = showThink ? (
    <div className="comp-menu-wrap">
      <button
        className={`think-btn lvl-${thinkLevel} ${thinkOn && thinkSupport !== 'no' ? 'on' : ''} support-${thinkSupport}`}
        onClick={() => setThinkOpen(!thinkOpen)}
        aria-expanded={thinkOpen}
        title={thinkTitle}
      >
        <Icon name="brain" size={14} /> {t('think.level.' + thinkLevel)}
        {thinkSupport === 'unknown' && <span className="think-unknown" aria-label={t('think.unverifiedTitle')}>?</span>}
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={thinkOpen} onClose={() => setThinkOpen(false)} align="right" width={250}>
        {thinkSupport === 'no' && <div className="ui-menu-empty">{t('think.mayIgnore')}</div>}
        {thinkSupport === 'unknown' && <div className="ui-menu-empty">{t('think.unverifiedTitle')}</div>}
        {THINK_LEVELS.map((lv) => (
          <MenuItem
            key={lv.id}
            label={t('think.level.' + lv.id)}
            desc={lv.id === 'auto'
              ? t('think.autoHint')
              : lv.id === 'off'
                ? t('composer.off')
                : t('think.budgetShort').replace('{n}', String(Math.round(Math.min(maxThinkBudget, lv.budget) / 1024)))}
            active={thinkLevel === lv.id}
            onClick={() => pickLevel(lv.id, lv.budget)}
          />
        ))}
        {thinkSupport === 'yes' && thinkOn && (
          <div className="think-budget">
            <label>{t('think.budgetLabel')}</label>
            <input
              type="number" min={1024} max={maxThinkBudget} step={256}
              value={thinkBudget}
              onChange={(e) => setThinkBudget(Math.min(maxThinkBudget, Math.max(1024, Number(e.target.value) || thinkBudget)))}
            />
            <div className="hint">{t('think.budgetHint').replace('{n}', String(Math.round(maxThinkBudget / 1024)))}</div>
          </div>
        )}
      </Popover>
    </div>
  ) : null;

  return (
    <div className="composer2">
      {attachments.length > 0 && (
        <div className="attach-cards" aria-label={t('composer.attachments')}>
          {attachments.map((a) => {
            const bytes = attachmentBytes(a);
            return (
              <div key={a.id} className={`file-card kind-${a.kind}`}>
                <button className="fc-main" title={t('chat.openFile').replace('{name}', a.name)}
                  aria-label={t('chat.openFile').replace('{name}', a.name)}
                  onClick={() => setPreviewFile({ name: a.name, kind: a.kind, bytes, content: a.content })}>
                  <span className="fc-icon">
                    <Icon name={a.kind === 'file' ? 'paperclip' : a.kind === 'story' ? 'book' : 'file'} size={14} />
                  </span>
                  <span className="fc-text">
                    <span className="fc-name">{a.name}</span>
                    <span className="fc-size">{formatBytes(bytes)} · {t('file.chars').replace('{n}', a.content.length.toLocaleString())}</span>
                  </span>
                </button>
                <button className="fc-x" aria-label={t('composer.removeAttachment')}
                  title={t('composer.removeAttachment')} onClick={() => onRemoveAttachment(a.id)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {previewFile && (
        <FilePreviewModal
          name={previewFile.name}
          kind={previewFile.kind}
          bytes={previewFile.bytes}
          content={previewFile.content}
          onClose={() => setPreviewFile(null)}
        />
      )}
      {editorState && (
        <PromptEditorModal
          existing={editorState.mode === 'edit' ? (userPrompts.find((u) => u.id === userRowId(editorState.prompt)) || null) : null}
          seedTemplate={editorState.mode === 'new' ? editorState.seed : undefined}
          onClose={() => setEditorState(null)}
          onSave={async (data) => {
            if (editorState.mode === 'edit') {
              await dbCall('updatePrompt', { id: userRowId(editorState.prompt), ...data });
            } else {
              await dbCall('createPrompt', data);
            }
            await useData.getState().load();
            setEditorState(null);
            ui.toast(t('prompt.saved'), 'ok');
          }}
          onDelete={editorState.mode === 'edit' ? () => deleteUserPrompt(editorState.prompt) : undefined}
        />
      )}

      {promptOpen && <div className="prompt-backdrop" onMouseDown={() => setPromptOpen(false)} />}

      {promptOpen && (
        <div className="prompt-menu" role="menu" aria-label={t('prompt.menuTitle')}>
          <div className="prompt-menu-head">
            <Icon name="sparkle" size={13} />
            <span>{skillCmdQuery !== null ? t('skill.cmdTitle') : t('prompt.menuTitle')}</span>
            <span className="spacer" />
            {skillCmdQuery === null && (<>
            <button className="small ghost" data-testid="prompt-import" title={t('prompt.importTitle')} aria-label={t('prompt.importTitle')}
              onClick={() => { setPromptOpen(false); void importPrompts(); }}>
              <Icon name="folderOpen" size={13} />
            </button>
            <button className="small ghost" data-testid="prompt-export" title={t('prompt.exportTitle')} aria-label={t('prompt.exportTitle')}
              onClick={exportPrompts}>
              <Icon name="download" size={13} />
            </button>
            <button className="small ghost" data-testid="prompt-new" title={t('prompt.newTitle')} aria-label={t('prompt.newTitle')}
              onClick={() => setEditorState({ mode: 'new' })}>
              <Icon name="plus" size={13} />
            </button>
            </>)}
            <button className="small ghost" aria-label={t('file.close')} onClick={() => setPromptOpen(false)}>
              <Icon name="x" size={13} />
            </button>
          </div>
          {skillCmdQuery === null && <div className="prompt-menu-cats">
            <button className={`chip ${promptCat === null ? 'active' : ''}`} onClick={() => setPromptCat(null)}>
              {t('prompt.all')}
            </button>
            {userOnly.length > 0 && (
              <button className={`chip ${promptCat === 'user' ? 'active' : ''}`} onClick={() => setPromptCat('user')}>
                {t('prompt.mine')} ({userOnly.length})
              </button>
            )}
            {PROMPT_CATEGORIES.map((c) => (
              <button key={c} className={`chip ${promptCat === c ? 'active' : ''}`} onClick={() => setPromptCat(c)}>
                {t('prompt.category.' + c)}
              </button>
            ))}
          </div>}
          <div className="prompt-menu-list">
            {skillCmdQuery !== null && (
              <div className="prompt-cat">
                {skillCmdItems.map((s) => (
                  <button key={s.id} className="prompt-item skill-cmd" role="menuitem"
                    onClick={() => runSkill(s.name)}>
                    <span className="pi-text">
                      <span className="pi-label">{s.name} <span className="skill-card-category">{t(`skills.category.${categoryOf(s)}`)}</span></span>
                      {s.description ? <span className="pi-desc">{s.description}</span> : null}
                    </span>
                    <span className="pi-insert">{isSkillActive(s) ? t('skill.active') : t('skill.enable')}</span>
                  </button>
                ))}
                {skillCmdItems.length === 0 && <div className="prompt-empty">{t('palette.noResults')}</div>}
                <button className="prompt-item skill-cmd" role="menuitem" onClick={() => runSkill()}>
                  <span className="pi-text">
                    <span className="pi-label">/skill/all</span>
                    <span className="pi-desc">{t('skill.allHint')}</span>
                  </span>
                  <span className="pi-insert">{t('skill.enable')}</span>
                </button>
                <div className="prompt-foot">{t('skill.cmdHint')}</div>
              </div>
            )}
            {skillCmdQuery === null && promptCat === null && promptQuery === '' && userOnly.length > 0 && (
              <div className="prompt-cat">
                <div className="prompt-cat-label">{t('prompt.mine')}</div>
                {userOnly.map((p) => (
                  <div key={p.id} className="prompt-item-row">
                    <button className="prompt-item" role="menuitem" onClick={() => insertPrompt(p)}
                      onMouseEnter={() => setPreviewId(p.id)} onFocus={() => setPreviewId(p.id)}>
                      <span className="pi-text">
                        <span className="pi-label">{p.label}</span>
                      </span>
                      {promptUses[p.id] ? <span className="pi-used">{promptUses[p.id]}×</span> : null}
                      <span className="pi-insert">{t('prompt.insert')}</span>
                    </button>
                    <button className="small ghost prompt-edit-btn" title={t('prompt.edit')}
                      aria-label={t('prompt.edit')} onClick={() => setEditorState({ mode: 'edit', prompt: p })}>
                      <Icon name="pencil" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {skillCmdQuery === null && renderCats.map((cat) => {
              const list = promptItems.filter((p) => p.category === cat);
              if (!list.length) return null;
              return (
                <div key={cat} className="prompt-cat">
                  <div className="prompt-cat-label">{cat === 'user' ? t('prompt.mine') : t('prompt.category.' + cat)}</div>
                  {list.map((p) => (
                    <button key={p.id} className="prompt-item" role="menuitem" onClick={() => insertPrompt(p)}
                      onMouseEnter={() => setPreviewId(p.id)} onFocus={() => setPreviewId(p.id)}>
                      <span className="pi-text">
                        <span className="pi-label">{p.label}</span>
                        <span className="pi-desc">{p.desc}</span>
                      </span>
                      {promptUses[p.id] ? <span className="pi-used">{promptUses[p.id]}×</span> : null}
                      <span className="pi-insert">{t('prompt.insert')}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {skillCmdQuery === null && promptItems.length === 0 && <div className="prompt-empty">{t('palette.noResults')}</div>}
            {skillCmdQuery === null && previewPrompt && (
              <div className="prompt-preview">
                <div className="pp-head">
                  <span className="pp-label">{previewPrompt.label}</span>
                  <span className="spacer" />
                  <button className="small ghost" onClick={() => duplicatePrompt(previewPrompt)}
                    title={t('prompt.duplicate')}>
                    <Icon name="copy" size={12} /> {t('prompt.duplicate')}
                  </button>
                </div>
                <pre>{applyPromptTemplate(previewPrompt.template, promptSeed)}</pre>
              </div>
            )}
            <div className="prompt-foot">
              <span>{t('prompt.templateHint')}</span>
              <button className="link" onClick={() => setEditorState({ mode: 'new' })}>{t('prompt.newTitle')}</button>
            </div>
          </div>
        </div>
      )}

      {hasProject && (
        <div className="proj-chip-row">
          <Popover open={projOpen} onClose={() => setProjOpen(false)} width={280}>
            {projects.map((p) => (
              <MenuItem key={p.id} icon="folder" label={p.name} active={p.id === chatProjectId}
                onClick={() => { setProjOpen(false); onPickProject(p.id); }} />
            ))}
            {projects.length === 0 && <div className="ui-menu-empty">{t('composer.noProjects')}</div>}
          </Popover>
          <button className="proj-chip" onClick={() => setProjOpen(!projOpen)} aria-expanded={projOpen}
            title={chatProject!.name}>
            <span className="x" role="button" tabIndex={0} aria-label={t('composer.detachProject')}
              onClick={(e) => { e.stopPropagation(); onDetachProject(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDetachProject(); } }}>
              <Icon name="x" size={12} />
            </span>
            <span className="name">{chatProject!.name}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      )}

      {!hasProject && (
        <div className="proj-chip-row">
          <button className="proj-chip ghosted" onClick={() => setProjOpen(true)} aria-expanded={projOpen}>
            <Icon name="folderOpen" size={13} />
            {t('composer.attachProject')}
            <Icon name="chevronDown" size={12} />
          </button>
          <Popover open={projOpen} onClose={() => setProjOpen(false)} width={280}>
            {projects.map((p) => (
              <MenuItem key={p.id} icon="folder" label={p.name}
                onClick={() => { setProjOpen(false); onPickProject(p.id); }} />
            ))}
            {projects.length === 0 && <div className="ui-menu-empty">{t('composer.noProjects')}</div>}
          </Popover>
        </div>
      )}

      <div className="comp-box">
        {mentionOpen && (
          <div className="mention-menu" role="listbox" aria-label={t('mention.title')}>
            <div className="mention-menu-head">
              <Icon name="book" size={12} />
              <span>{mentionItems.length ? t('mention.title') : t('mention.none')}</span>
            </div>
            {mentionItems.map((c, i) => (
              <button
                key={c.kind + c.id}
                className={`mention-item ${i === mentionIdx ? 'active' : ''}`}
                role="option"
                aria-selected={i === mentionIdx}
                onMouseDown={(e) => { e.preventDefault(); insertMention(c); }}
                onMouseEnter={() => setMentionIdx(i)}
              >
                <span className="mention-kind">{t('mention.' + (c.kind === 'story' ? c.sub : 'chapter'))}</span>
                <span className="mention-title">{c.title}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={input}
          placeholder={t('composer.placeholder')}
          rows={1}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && promptOpen) { e.preventDefault(); setPromptOpen(false); return; }
            if (mentionOpen && mentionItems.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionItems.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length); return; }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); insertMention(mentionItems[Math.min(mentionIdx, mentionItems.length - 1)]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
              e.preventDefault();
              // A complete /skill command is executed, not typed into the draft.
              if (promptOpen && skillCmdQuery !== null) {
                if (skillCmdQuery) onSend(); // bare "/skill" keeps the picker open
                return;
              }
              if (promptOpen) { setPromptOpen(false); return; }
              onSend();
            }
          }}
        />

        <div className="comp-toolbar">
          <div className="comp-left">
            <button className="round-btn" title={t('composer.add')} aria-label={t('composer.add')}
              aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)}>
              <Icon name="plus" size={15} />
            </button>
            <Popover open={addOpen} onClose={() => setAddOpen(false)} width={380}>
              <div className="add-head">{t('composer.addPanel')}</div>
              <button className="add-row" onClick={() => { setAddOpen(false); void onAttachClick(); }}>
                <Icon name="paperclip" size={15} /> <span className="lbl">{t('composer.attachments')}</span>
                <span className="desc">{t('composer.attachDesc')}</span>
              </button>
              <button className="add-row" onClick={openPromptLibrary}>
                <Icon name="scroll" size={15} /> <span className="lbl">{t('prompt.title')}</span>
                <span className="desc">{t('prompt.addDesc')}</span>
              </button>
              <button className="add-row" onClick={saveComposerAsPrompt} disabled={!input.trim()}>
                <Icon name="plus" size={15} /> <span className="lbl">{t('prompt.saveComposerText')}</span>
                <span className="desc">{t('prompt.addDesc')}</span>
              </button>
              {goal === null ? (
                <button className="add-row" onClick={() => { setGoal(''); }}>
                  <Icon name="target" size={15} /> <span className="lbl">{t('composer.goal')}</span>
                  <span className="desc">{t('composer.goalDesc')}</span>
                </button>
              ) : (
                <div className="goal-editor">
                  <input autoFocus value={goal} placeholder={t('composer.goalPh')}
                    onChange={(e) => setGoal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && goal.trim()) { setAddOpen(false); } if (e.key === 'Escape') setGoal(null); }} />
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                    <button className="small ghost" onClick={() => setGoal(null)}>{t('model.cancel')}</button>
                    <button className="small primary" disabled={!goal.trim()} onClick={() => setAddOpen(false)}>{t('model.save')}</button>
                  </div>
                </div>
              )}
              <div className="add-head">{t('composer.plugins')}</div>
              <div className="add-row static"><span className="plugin-dot" /><span className="lbl">{t('composer.pluginCreator')}</span><span className="desc">{t('composer.pluginCreatorDesc')}</span></div>
              <div className="add-row static"><Icon name="pencil" size={14} /><span className="lbl">{t('composer.skillCreator')}</span><span className="desc">{t('composer.skillCreatorDesc')}</span></div>
              <div className="add-foot">
                <span><kbd>/</kbd> {t('prompt.menuTitle')}</span>
                <span><kbd>@</kbd> {t('composer.hintContext')}</span>
              </div>
            </Popover>

            {goal !== null && goal.trim() && (
              <span className="mini-chip" title={goal}>
                <Icon name="target" size={12} /> {t('composer.goalChip')}
              </span>
            )}
          </div>

          <div className="comp-right">
            <div className="comp-menu-wrap">
              <button className="model-btn" onClick={() => setModelOpen(!modelOpen)} aria-expanded={modelOpen}
                title={allModels.length === 0
                  ? t('composer.noModelsTitle')
                  : effProvider ? `${effProvider.name} · ${effModel}` : effModel || ''}>
                {effModel || t('chat.noModel')}
                <Icon name="chevronDown" size={12} />
              </button>
              <Popover open={modelOpen} onClose={() => setModelOpen(false)} align="right" width={340}>
                {allModels.map((m) => {
                  const owner = providers.find((p) => p.enabled && (Array.isArray(p.models) ? p.models : []).includes(m));
                  // Say up front that a model has nothing to show for reasoning,
                  // so the missing control is never a surprise.
                  const support = thinkingSupport(m, {
                    kind: (owner as any)?.kind || 'auto',
                    record: owner ? modelCaps[`${owner.id}::${m}`] : undefined
                  });
                  const desc = [owner?.name, support === 'no' ? t('think.noReasoning') : ''].filter(Boolean).join(' · ');
                  return (
                    <MenuItem key={m} label={m} desc={desc} active={m === effModel}
                      onClick={() => { setModelOpen(false); onPickModel(m); }} />
                  );
                })}
                {allModels.length === 0 && <div className="ui-menu-empty">{t('chat.noProvider')}</div>}
              </Popover>
            </div>

            {/* Reply style picker (Claude-style) — edit builtins in Settings → Styles */}
            <div className="comp-menu-wrap">
              <button className={`style-btn ${activeStyle ? 'on' : ''}`} onClick={() => setStyleOpen(!styleOpen)}
                aria-expanded={styleOpen} title={t('style.pick')}>
                <Icon name="sparkle" size={13} /> {activeStyle ? activeStyle.name : t('style.none')}
                <Icon name="chevronDown" size={12} />
              </button>
              <Popover open={styleOpen} onClose={() => setStyleOpen(false)} align="right" width={280}>
                <MenuItem label={t('style.none')} desc={t('style.noneDesc')} active={!activeStyle} onClick={() => { setStyleOpen(false); onPickStyle(null); }} />
                {styles.map((s) => (
                  <MenuItem key={s.id} label={s.name} desc={s.content.length > 60 ? s.content.slice(0, 60) + '…' : s.content}
                    active={s.id === activeStyleId} onClick={() => { setStyleOpen(false); onPickStyle(s.id); }} />
                ))}
              </Popover>
            </div>

            {streaming ? (
              <button className="send-btn stop" onClick={onAbort} aria-label={t('chat.stop')} title={t('chat.stop')}>
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button className="send-btn" onClick={onSend} disabled={!input.trim()}
                aria-label={t('chat.send')}
                title={allModels.length === 0
                  ? t('composer.sendNoModel')
                  : !input.trim() ? t('composer.sendEmpty') : t('chat.send')}>
                <Icon name="send" size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="comp-modes">
          <button className={`web-toggle ${webSearchOn ? 'on' : ''}`} onClick={() => onToggleWebSearch(!webSearchOn)}
            aria-pressed={webSearchOn} title={t('composer.webHint')}>
            <Icon name="search" size={13} /> {t('composer.web')}
            <span className="wb-state">{webSearchOn ? t('composer.on') : t('composer.off')}</span>
          </button>

          {/* Working modes: one framed control, each mode with its own colour. */}
          <div className="mode-box">
          <div
            className={`mode-seg mode-${mode}`}
            role="group"
            aria-label={t('mode.label')}
            style={{ ['--mi' as any]: String(Math.max(0, modeList.indexOf(mode))), ['--mn' as any]: String(modeList.length) }}
          >
            <span className="mode-thumb" aria-hidden="true" />
            {modeList.map((m) => (
              <button key={m} className={`mode-btn mode-${m} ${mode === m ? 'on' : ''}`}
                aria-pressed={mode === m} onClick={() => onPickMode(m)} title={t('mode.' + m + 'Hint')}>
                <Icon name={m === 'plan' ? 'target' : m === 'brainstorm' ? 'sparkle' : m === 'edit' ? 'pencil' : 'quill'} size={13} />
                {t('mode.' + m)}
              </button>
            ))}
          </div>
          </div>

          {agentWorkspace && (
            /* The agent moves itself between modes: this chip is the visible
               "mode switched" status, like the thinking / web-search chips. */
            <span key={mode} className="agent-chip" title={t('mode.hintAgent')}>
              <Icon name="tools" size={12} /> {t('advance.agent')}
              <b>{t('mode.' + mode)}</b>
            </span>
          )}

          {thinkingControl}

          <div className="comp-menu-wrap">
            <button className={`ability-btn ${enabledSkills.length ? 'on' : ''}`}
              onClick={() => setSkillsOpen(!skillsOpen)} aria-expanded={skillsOpen}
              title={t('composer.skillsHint')}>
              <Icon name="sparkle" size={13} /> {t('composer.skills').replace('{n}', String(enabledSkills.length))}
              <Icon name="chevronDown" size={11} />
            </button>
            <Popover open={skillsOpen} onClose={() => setSkillsOpen(false)} width={340}>
              {skills.length === 0 && <div className="ui-menu-empty">{t('composer.skillsNone')}</div>}
              {deskSkills.length > 0 && (
                <div className="skill-group-label">
                  {t('composer.skillsDesk').replace('{desk}', t(`skills.category.${desk}`))}
                </div>
              )}
              {deskSkills.map(skillToggleRow)}
              {deskSkills.length === 0 && skills.length > 0 && (
                <div className="skill-group-empty">
                  {t('composer.skillsDeskEmpty').replace('{desk}', t(`skills.category.${desk}`))}
                </div>
              )}
              {otherSkills.length > 0 && (
                <details className="skill-other" open={otherSkills.some(isSkillActive)}>
                  <summary>{t('composer.skillsOther').replace('{n}', String(otherSkills.length))}</summary>
                  <div className="skill-other-list">{otherSkills.map(skillToggleRow)}</div>
                </details>
              )}
              <div className="skill-cmd-hint">{t('skill.cmdHint')}</div>
              <button className="link skills-manage" onClick={() => { setSkillsOpen(false); useData.getState().navigate('settings'); }}>
                {t('composer.manageSkills')}
              </button>
            </Popover>
          </div>
        </div>
      </div>

      <div className="comp-hints">
        <span className="composer-mode-hint">{agentWorkspace ? t('mode.hintAgent') : t('mode.hintChat')}</span>
        <span className="spacer" />
        {draftTokens > 0 && (
          <span className="composer-words">
            {t('composer.tokens').replace('{n}', draftTokens.toLocaleString())}
            {wordCount > 0 ? ` · ${t('chat.words').replace('{n}', wordCount.toLocaleString())}` : ''}
          </span>
        )}
        <span><kbd>Enter</kbd> {t('composer.send')} · <kbd>Shift+Enter</kbd> {t('composer.newline')}</span>
      </div>
      <div className="composer-disclaimer" role="note">
        <Icon name="bolt" size={11} /> {t('composer.disclaimer')}
      </div>
    </div>
  );
}
