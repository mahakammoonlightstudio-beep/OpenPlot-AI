import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useUi, dbCall } from '../store';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { Popover, MenuItem } from './Ui';
import { Provider, StyleRow } from '../types';
import {
  PROMPT_LIBRARY, PROMPT_CATEGORIES, applyPromptTemplate, mergePrompts,
  LibraryPrompt, PromptCategory
} from '../promptLibrary';
import { PromptEditorModal } from './PromptEditorModal';
import { MentionCandidate, mentionToken, buildCandidates } from '../mentions';

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
  thinkOn, setThinkOn, toolsOn, setToolsOn,
  chatProjectId, onPickProject, onDetachProject,
  goal, setGoal,
  wordCount,
  styles, activeStyleId, onPickStyle,
  attachments, onRemoveAttachment, onAttachClick,
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
  toolsOn: boolean;
  setToolsOn: (v: boolean) => void;
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
  /** Files/story/chapter chips for the NEXT message. */
  attachments: Array<{ id: string; name: string; kind: 'file' | 'story' | 'chapter'; content: string }>;
  onRemoveAttachment: (id: string) => void;
  onAttachClick: () => void | Promise<void>;
}) {
  const t = useT();
  const ui = useUi();
  const { projects, providers, userPrompts } = useData();
  const [addOpen, setAddOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkOpen, setThinkOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const activeStyle = styles.find((s) => s.id === activeStyleId) || null;
  const chatProject = projects.find((p) => p.id === chatProjectId) || null;

  // ---- @-mentions (story bible & chapters) ----
  // Typing "@word" opens a picker; inserting appends a compact token like
  // @["character:Kael Ardent"] that ChatView expands before sending.
  const { story, chapters } = useData();
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

  function insertPrompt(p: LibraryPrompt) {
    const text = applyPromptTemplate(p.template, promptSeed);
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
  useEffect(() => {
    const handler = () => {
      if (streaming) return;
      if (input.trim()) {
        setPromptOpen(true);
        setTimeout(() => taRef.current?.focus(), 0);
      } else {
        openPromptLibrary();
      }
    };
    window.addEventListener('inkwell:open-prompts', handler);
    return () => window.removeEventListener('inkwell:open-prompts', handler);
  }, [input, streaming]);

  const isUserPrompt = (p: LibraryPrompt) => p.category === 'user' && p.id.startsWith('user-');
  const userRowId = (p: LibraryPrompt) => p.id.slice('user-'.length);

  async function deleteUserPrompt(p: LibraryPrompt) {
    await dbCall('deletePrompt', { id: userRowId(p) });
    await useData.getState().load();
    setEditorState(null);
    ui.toast(t('prompt.deleted'), 'ok');
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

  return (
    <div className="composer2">
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <span key={a.id} className={`attach-chip kind-${a.kind}`} title={`${a.name} · ${a.content.length.toLocaleString()} chars`}>
              <Icon name={a.kind === 'file' ? 'paperclip' : a.kind === 'story' ? 'book' : 'file'} size={12} />
              <span className="n">{a.name}</span>
              <button className="x" aria-label="Remove attachment" onClick={() => onRemoveAttachment(a.id)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
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
            <span>{t('prompt.menuTitle')}</span>
            <span className="spacer" />
            <button className="small ghost" title={t('prompt.newTitle')} aria-label={t('prompt.newTitle')}
              onClick={() => setEditorState({ mode: 'new' })}>
              <Icon name="plus" size={13} />
            </button>
            <button className="small ghost" aria-label="Close" onClick={() => setPromptOpen(false)}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="prompt-menu-cats">
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
          </div>
          <div className="prompt-menu-list">
            {promptCat === null && promptQuery === '' && userOnly.length > 0 && (
              <div className="prompt-cat">
                <div className="prompt-cat-label">{t('prompt.mine')}</div>
                {userOnly.map((p) => (
                  <div key={p.id} className="prompt-item-row">
                    <button className="prompt-item" role="menuitem" onClick={() => insertPrompt(p)}>
                      <span className="pi-text">
                        <span className="pi-label">{p.label}</span>
                      </span>
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
            {renderCats.map((cat) => {
              const list = promptItems.filter((p) => p.category === cat);
              if (!list.length) return null;
              return (
                <div key={cat} className="prompt-cat">
                  <div className="prompt-cat-label">{cat === 'user' ? t('prompt.mine') : t('prompt.category.' + cat)}</div>
                  {list.map((p) => (
                    <button key={p.id} className="prompt-item" role="menuitem" onClick={() => insertPrompt(p)}>
                      <span className="pi-text">
                        <span className="pi-label">{p.label}</span>
                        <span className="pi-desc">{p.desc}</span>
                      </span>
                      <span className="pi-insert">{t('prompt.insert')}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {promptItems.length === 0 && <div className="prompt-empty">{t('palette.noResults')}</div>}
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
                title={effProvider ? `${effProvider.name} · ${effModel}` : effModel || ''}>
                {effModel || t('chat.noModel')}
                <Icon name="chevronDown" size={12} />
              </button>
              <Popover open={modelOpen} onClose={() => setModelOpen(false)} align="right" width={340}>
                {allModels.map((m) => {
                  const owner = providers.find((p) => p.enabled && (Array.isArray(p.models) ? p.models : []).includes(m));
                  return (
                    <MenuItem key={m} label={m} desc={owner?.name} active={m === effModel}
                      onClick={() => { setModelOpen(false); onPickModel(m); }} />
                  );
                })}
                {allModels.length === 0 && <div className="ui-menu-empty">{t('chat.noProvider')}</div>}
              </Popover>
            </div>

            <div className="comp-menu-wrap">
              <button className={`think-btn ${thinkOn ? 'on' : ''}`} onClick={() => setThinkOpen(!thinkOpen)}
                aria-expanded={thinkOpen} title={t('chat.think')}>
                <Icon name="brain" size={14} /> {thinkOn ? t('composer.on') : t('composer.off')}
                <Icon name="chevronDown" size={12} />
              </button>
              <Popover open={thinkOpen} onClose={() => setThinkOpen(false)} align="right" width={230}>
                <MenuItem label={t('composer.off')} active={!thinkOn} onClick={() => { setThinkOpen(false); setThinkOn(false); }} />
                <MenuItem label={t('composer.on')} active={thinkOn} onClick={() => { setThinkOpen(false); setThinkOn(true); }} />
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
              <button className="send-btn" onClick={onSend} disabled={!input.trim()} aria-label={t('chat.send')} title={t('chat.send')}>
                <Icon name="send" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="comp-hints">
        <label className="toggle"><input type="checkbox" checked={toolsOn} onChange={(e) => setToolsOn(e.target.checked)} /> <Icon name="tools" size={13} /> {t('chat.tools')}</label>
        <span className="spacer" />
        {wordCount > 0 && <span className="composer-words">{t('chat.words').replace('{n}', wordCount.toLocaleString())}</span>}
        <span><kbd>Enter</kbd> {t('composer.send')} · <kbd>Shift+Enter</kbd> {t('composer.newline')}</span>
      </div>
    </div>
  );
}
