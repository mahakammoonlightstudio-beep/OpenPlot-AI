import { useState } from 'react';
import { useData, useUi, dbCall, runAutomations } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { Modal, Switch } from '../Ui';
import { confirmDialog } from '../TextPrompt';
import { buildSkillLab } from '../../lib/skillLab';
import { parseSkillsOff, parseSkillsOn } from '../../lib/prompt';
import type { SkillCategory, SkillRow } from '../../types';

interface SkillDraft {
  id: string | null;
  name: string;
  description: string;
  content: string;
  category: SkillCategory;
}

const CATEGORIES: Array<{ id: 'all' | SkillCategory; key: string }> = [
  { id: 'all', key: 'skills.category.all' },
  { id: 'chat', key: 'skills.category.chat' },
  { id: 'agent', key: 'skills.category.agent' },
  { id: 'writing', key: 'skills.category.writing' }
];

const TEMPLATES: Array<{ id: string; key: string; name: string; description: string; content: string; category: SkillCategory }> = [
  {
    id: 'blank',
    key: 'skills.template.blank',
    name: 'New skill',
    description: '',
    content: 'Describe, in the imperative, what the assistant should do differently when this skill is active.',
    category: 'writing'
  },
  {
    id: 'line',
    key: 'skills.template.line',
    name: 'Line editor',
    description: 'Tightens sentences without changing the voice.',
    content: 'When editing: keep the author\'s voice and intent. Cut redundancy, replace clichés with concrete images, and tighten rhythm. Show the edited paragraph only, then list at most three changes and the reason for each.',
    category: 'writing'
  },
  {
    id: 'beta',
    key: 'skills.template.beta',
    name: 'Beta reader',
    description: 'Reports the reading experience, not a rewrite.',
    content: 'Read the passage once. Report where you were confused, bored, or hooked, quoting the exact lines. Do not rewrite unless asked; separate craft problems from taste.',
    category: 'chat'
  },
  {
    id: 'world',
    key: 'skills.template.world',
    name: 'Worldbuilding architect',
    description: 'Derives culture from constraints, not decoration.',
    content: 'Start from one constraint (geography, scarcity, magic cost, power). Derive the consequences people live with: work, food, etiquette, taboos. Save durable facts as story bible entries.',
    category: 'agent'
  }
];

/** Normalise old rows (no category) and any hand-edited value. */
function categoryOf(skill: { category?: string }): SkillCategory {
  return skill.category === 'chat' || skill.category === 'agent' || skill.category === 'writing'
    ? skill.category
    : 'writing';
}

/**
 * Settings → Skills (v1.3.0 workbench).
 *
 * The list stays a compact grid; pressing a skill opens the right inspector
 * with the full instructions and every action. Categories map to the desk the
 * instruction fits (Chat / Agent / Writing), while enabling remains per chat
 * via /skill. Adding a skill still saves it DISABLED.
 */
export function SkillsSection() {
  const t = useT();
  const { skills, chats, activeChatId } = useData();
  const ui = useUi();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [savedDisabled, setSavedDisabled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [filter, setFilter] = useState<'all' | SkillCategory>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeCount = skills.filter((s) => Number(s.enabled) === 1).length;
  const counts = {
    all: skills.length,
    chat: skills.filter((s) => categoryOf(s) === 'chat').length,
    agent: skills.filter((s) => categoryOf(s) === 'agent').length,
    writing: skills.filter((s) => categoryOf(s) === 'writing').length
  };
  const filtered = filter === 'all' ? skills : skills.filter((s) => categoryOf(s) === filter);
  const selected = skills.find((s) => s.id === selectedId) || null;
  const activeChat = chats.find((c) => c.id === activeChatId) || null;
  const chatSkillsOn = parseSkillsOn(activeChat?.skills_on);
  const chatSkillsOff = parseSkillsOff(activeChat?.skills_off);
  const selectedInChat = !!selected && !!activeChat &&
    (Number(selected.enabled) === 1 || chatSkillsOn.includes(selected.id)) &&
    !chatSkillsOff.includes(selected.id);
  const chatDesk: SkillCategory = activeChat?.workspace === 'agent' ? 'agent' : 'chat';
  const lab = selected
    ? buildSkillLab(selected, skills, { skillsOn: chatSkillsOn, skillsOff: chatSkillsOff })
    : null;

  function startNew(category: SkillCategory = filter === 'all' ? 'writing' : filter) {
    setDraft({ id: null, name: '', description: '', content: '', category });
    setGallery(false);
  }

  async function toggle(s: SkillRow, on: boolean) {
    await dbCall('saveSkill', {
      id: s.id, name: s.name, description: s.description || '', content: s.content,
      category: categoryOf(s), enabled: on
    });
    await useData.getState().load();
    if (on && savedDisabled === s.id) setSavedDisabled(null);
    // `skill:enabled` fires only on the off→on edge: an automation that runs
    // "whenever a skill is on" should not fire again when it is toggled off.
    if (on) runAutomations('skill:enabled', { skillId: s.id });
  }

  async function saveDraft() {
    if (!draft || busy) return;
    const name = draft.name.trim() || 'Untitled skill';
    setBusy(true);
    try {
      const row = await dbCall<SkillRow>('saveSkill', {
        id: draft.id || undefined,
        name,
        description: draft.description.trim(),
        content: draft.content,
        category: draft.category,
        // Only an edit keeps its current state; a new row lets the DB default
        // to disabled, which is the whole point of the gate.
        ...(draft.id ? { enabled: Number(skills.find((s) => s.id === draft.id)?.enabled) === 1 } : {})
      });
      await useData.getState().load();
      if (!draft.id) setSavedDisabled(row?.id || null);
      if (row?.id) setSelectedId(row.id);
      setDraft(null);
      ui.toast(!draft.id ? t('skills.savedDisabled') : t('toast.saved'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(s: SkillRow) {
    const row = await dbCall<SkillRow>('saveSkill', {
      name: `${s.name} copy`,
      description: s.description || '',
      content: s.content,
      category: categoryOf(s)
    });
    await useData.getState().load();
    if (row?.id) {
      setSavedDisabled(row.id);
      setSelectedId(row.id);
    }
  }

  async function remove(s: SkillRow) {
    if (Number(s.builtin) === 1) {
      ui.toast(t('skills.builtinNoDelete'), 'error');
      return;
    }
    if (!(await confirmDialog({
      title: t('skills.deleteConfirm').replace('{name}', s.name),
      danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel')
    }))) return;
    try {
      await dbCall('deleteSkill', { id: s.id });
      setSelectedId(null);
      await useData.getState().load();
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    }
  }

  async function reset(s: SkillRow) {
    if (!(await confirmDialog({
      title: t('skills.resetConfirm').replace('{name}', s.name),
      danger: true, confirmLabel: t('skills.reset'), cancelLabel: t('confirm.cancel')
    }))) return;
    try {
      await dbCall('resetSkill', { id: s.id });
      await useData.getState().load();
      ui.toast(t('skills.resetDone'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    }
  }

  async function importSkill() {
    const paths = await window.inkwell.pickFiles();
    if (!paths.length) return;
    const files = await window.inkwell.readFiles(paths, 256 * 1024);
    const file = files[0];
    if (!file) return;
    const heading = (file.content.match(/^#\s+(.+)$/m) || [])[1];
    const name = heading || file.name.replace(/\.(md|txt)$/i, '');
    const row = await dbCall<SkillRow>('saveSkill', {
      name,
      description: '',
      content: file.content.replace(/^#\s+.+\n?/, '').trim(),
      category: filter === 'all' ? 'writing' : filter
    });
    await useData.getState().load();
    if (row?.id) {
      setSavedDisabled(row.id);
      setSelectedId(row.id);
    }
    ui.toast(t('skills.imported').replace('{name}', name), 'ok');
  }

  async function exportSkill(s: SkillRow) {
    const md = `# ${s.name}\n\n${s.description ? s.description + '\n\n' : ''}${s.content}\n`;
    await window.inkwell.exportFile(s.name.replace(/[^\w\- ]+/g, '').trim() || 'skill', md, 'md');
  }

  /** Lab action: switch the selected skill on for the chat that is open. */
  async function useInChat(s: SkillRow) {
    if (!activeChat) return;
    const on = new Set(parseSkillsOn(activeChat.skills_on));
    on.add(s.id);
    const off = parseSkillsOff(activeChat.skills_off).filter((id) => id !== s.id);
    try {
      await dbCall('updateChat', {
        id: activeChat.id,
        skills_on: [...on],
        skills_off: off
      });
      await useData.getState().reloadChatRelated();
      ui.toast(t('skills.lab.applied').replace('{name}', s.name), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    }
  }

  return (
    <div id="set-skills-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="bolt" size={18} /> {t('settings.skills')}
        <span className="count-badge">{t('skills.activeCount').replace('{n}', String(activeCount))}</span>
      </h1>
      <div className="subtitle">{t('skills.sub')}</div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="primary" onClick={() => startNew()}>
          <Icon name="plus" size={14} /> {t('skills.add')}
        </button>
        <button className="ghost" onClick={() => setGallery(!gallery)} aria-expanded={gallery}>
          <Icon name="sparkle" size={14} /> {t('skills.templates')}
        </button>
        <button className="ghost" onClick={importSkill}><Icon name="download" size={14} /> {t('skills.import')}</button>
        <span className="hint">{t('skills.gateHint')}</span>
      </div>

      <div className="skill-filter" role="tablist" aria-label={t('skills.category')}>
        {CATEGORIES.map((category) => (
          <button
            key={category.id}
            role="tab"
            aria-selected={filter === category.id}
            className={filter === category.id ? 'active' : 'ghost'}
            onClick={() => setFilter(category.id)}
          >
            {t(category.key)} <span className="count-badge">{counts[category.id]}</span>
          </button>
        ))}
      </div>

      {gallery && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('skills.templates')}</h3>
          <div className="skill-templates">
            {TEMPLATES.map((tpl) => (
              <button key={tpl.id} className="template-card" onClick={() => {
                setDraft({ id: null, name: tpl.name, description: tpl.description, content: tpl.content, category: tpl.category });
                setGallery(false);
              }}>
                <b>{t(tpl.key)}</b>
                <small>{tpl.description || t('skills.template.blankHint')}</small>
                <span className="skill-card-category">{t(`skills.category.${tpl.category}`)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={`skills-workbench ${selected ? 'with-inspector' : ''}`}>
        <div className="skills-grid">
          {filtered.map((s) => {
            const enabled = Number(s.enabled) === 1;
            const builtin = Number(s.builtin) === 1;
            const category = categoryOf(s);
            return (
              <div
                key={s.id}
                className={`skill-card ${enabled ? '' : 'off'} ${selectedId === s.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(s.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(s.id); }
                }}
              >
                <div className="skill-card-head">
                  <b className="t">{s.name}</b>
                  <span className="skill-card-category">{t(`skills.category.${category}`)}</span>
                  {builtin && <span className="v-src builtin">{t('skills.builtin')}</span>}
                  <span style={{ flex: 1 }} />
                  <span onClick={(e) => e.stopPropagation()}>
                    <Switch checked={enabled} onChange={(v) => toggle(s, v)} label={s.name} />
                  </span>
                </div>
                <div className="skill-card-desc">{s.description || s.content.slice(0, 140)}</div>
                {savedDisabled === s.id && !enabled && (
                  <div className="skill-note" onClick={(e) => e.stopPropagation()}>
                    <span>{t('skills.savedDisabled')}</span>
                    <button className="small primary" onClick={() => toggle(s, true)}>{t('skills.enableNow')}</button>
                  </div>
                )}
                <div className="skill-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="small" onClick={() => setDraft({ id: s.id, name: s.name, description: s.description || '', content: s.content, category })}>
                    <Icon name="pencil" size={12} /> {t('models.edit')}
                  </button>
                  <button className="small ghost" onClick={() => duplicate(s)}>{t('skills.duplicate')}</button>
                  <button className="small ghost" onClick={() => exportSkill(s)}>{t('skills.export')}</button>
                  {builtin ? (
                    <button className="small ghost" onClick={() => reset(s)}>{t('skills.reset')}</button>
                  ) : (
                    <button className="small danger" onClick={() => remove(s)} aria-label={t('confirm.delete')}><Icon name="trash" size={12} /></button>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="skill-inspector-empty">{t('skills.categoryEmpty')}</div>
          )}
        </div>

        {selected && (
          <aside className="skill-inspector" aria-label={t('skills.details')}>
            <div className="skill-inspector-head">
              <h3>{selected.name}</h3>
              <button className="small ghost" onClick={() => setSelectedId(null)} aria-label={t('confirm.cancel')}>
                <Icon name="x" size={13} />
              </button>
            </div>
            <div className="skill-inspector-meta">
              <span className="skill-card-category">{t(`skills.category.${categoryOf(selected)}`)}</span>
              {Number(selected.builtin) === 1 && <span className="v-src builtin">{t('skills.builtin')}</span>}
              <span className={`library-badge ${Number(selected.enabled) === 1 ? 'current' : ''}`}>
                {Number(selected.enabled) === 1 ? t('skills.enabled') : t('skills.disabled')}
              </span>
            </div>
            <div className="skill-inspector-desc">
              {selected.description || t('skills.noDescription')}
            </div>
            <div className="skill-inspector-actions">
              <span className="switch-row">
                <Switch
                  checked={Number(selected.enabled) === 1}
                  onChange={(v) => toggle(selected, v)}
                  label={selected.name}
                />
                <span>{Number(selected.enabled) === 1 ? t('skills.enabled') : t('skills.disabled')}</span>
              </span>
              <button className="small" onClick={() => setDraft({
                id: selected.id,
                name: selected.name,
                description: selected.description || '',
                content: selected.content,
                category: categoryOf(selected)
              })}>
                <Icon name="pencil" size={12} /> {t('models.edit')}
              </button>
              <button className="small ghost" onClick={() => duplicate(selected)}>{t('skills.duplicate')}</button>
              <button className="small ghost" onClick={() => exportSkill(selected)}>{t('skills.export')}</button>
              {Number(selected.builtin) === 1 ? (
                <button className="small ghost" onClick={() => reset(selected)}>{t('skills.reset')}</button>
              ) : (
                <button className="small danger" onClick={() => remove(selected)}>
                  <Icon name="trash" size={12} /> {t('skills.delete')}
                </button>
              )}
            </div>
            {savedDisabled === selected.id && Number(selected.enabled) !== 1 && (
              <div className="skill-note">
                <span>{t('skills.savedDisabled')}</span>
                <button className="small primary" onClick={() => toggle(selected, true)}>{t('skills.enableNow')}</button>
              </div>
            )}
            <div>
              <label className="hint">{t('skills.content')}</label>
              <pre className="skill-inspector-content">{selected.content}</pre>
            </div>
            {lab && (
              <div className="skill-lab">
                <div className="skill-lab-head">
                  <b>{t('skills.lab.title')}</b>
                  <span>{t('skills.lab.hint')}</span>
                </div>
                <div className="skill-lab-stats">
                  <span>{t('skills.lab.size').replace('{tokens}', String(lab.tokens)).replace('{chars}', lab.chars.toLocaleString())}</span>
                  <span>{t(activeChat ? 'skills.lab.activeSet' : 'skills.lab.activeGlobal').replace('{n}', String(lab.activeCount)).replace('{used}', lab.activeChars.toLocaleString()).replace('{max}', lab.budget.toLocaleString())}</span>
                </div>
                {activeChat && categoryOf(selected) !== chatDesk && (
                  <div className="skill-lab-warn">
                    {t('skills.lab.mismatch')
                      .replace('{skill}', t(`skills.category.${categoryOf(selected)}`))
                      .replace('{chat}', t(`skills.category.${chatDesk}`))}
                  </div>
                )}
                <div>
                  <label className="hint">{t('skills.lab.preview')}</label>
                  <pre className="skill-lab-preview">{lab.body}</pre>
                </div>
                {lab.truncated && <div className="skill-lab-warn danger">{t('skills.lab.truncated')}</div>}
                {lab.issues.length > 0 ? (
                  <div className="skill-lab-issues">
                    <div className="hint">{t('skills.lab.issues')}</div>
                    {lab.issues.map((issue) => (
                      <button
                        key={`${issue.kind}-${issue.id}`}
                        className={`skill-lab-issue ${issue.kind}`}
                        onClick={() => setSelectedId(issue.id)}
                        title={t('skills.details')}
                      >
                        {issue.kind === 'duplicate'
                          ? t('skills.lab.duplicate').replace('{name}', issue.name)
                          : issue.kind === 'overlap'
                            ? t('skills.lab.overlap').replace('{name}', issue.name).replace('{terms}', issue.shared.join(', '))
                            : t('skills.lab.tension')
                              .replace('{name}', issue.name)
                              .replace('{topic}', t(`skills.lab.tension.${issue.topic}`))}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="skill-lab-clear">{t('skills.lab.clear')}</div>
                )}
                {activeChat ? (
                  <button
                    className={`small ${selectedInChat ? '' : 'primary'}`}
                    disabled={selectedInChat}
                    onClick={() => void useInChat(selected)}
                  >
                    {selectedInChat ? t('skills.lab.activeInChat') : t('skills.lab.useInChat')}
                  </button>
                ) : (
                  <div className="hint">{t('skills.lab.noChat')}</div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {draft && (
        <Modal
          title={draft.id ? t('skills.editTitle') : t('skills.newTitle')}
          onClose={() => setDraft(null)}
          width={720}
          footer={
            <>
              <span className="hint">{draft.id ? '' : t('skills.gateHint')}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setDraft(null)}>{t('model.cancel')}</button>
              <button className="primary" disabled={busy || !draft.content.trim()} onClick={saveDraft}>
                <Icon name="check" size={14} /> {t('skills.save')}
              </button>
            </>
          }
        >
          <div className="field">
            <label>{t('skills.name')}</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('skills.namePh')} />
          </div>
          <div className="field">
            <label>{t('skills.category')}</label>
            <select
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value as SkillCategory })}
              style={{ maxWidth: 280 }}
            >
              <option value="chat">{t('skills.category.chat')}</option>
              <option value="agent">{t('skills.category.agent')}</option>
              <option value="writing">{t('skills.category.writing')}</option>
            </select>
            <div className="hint">{t('skills.categoryHint')}</div>
          </div>
          <div className="field">
            <label>{t('skills.description')}</label>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={t('skills.descriptionPh')} maxLength={200} />
          </div>
          <div className="skill-editor">
            <div className="field" style={{ margin: 0 }}>
              <label>{t('skills.content')}</label>
              <textarea rows={12} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>{t('skills.preview')}</label>
              <pre className="skill-preview">{`## ${draft.name || t('skills.namePh')}\n[${t(`skills.category.${draft.category}`)}]\n${draft.description ? draft.description + '\n' : ''}${draft.content || t('skills.previewHint')}`}</pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
