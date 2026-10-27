import { useState } from 'react';
import { useData, useUi, dbCall } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { Modal, Switch } from '../Ui';
import { confirmDialog } from '../TextPrompt';
import type { SkillRow } from '../../types';

interface SkillDraft {
  id: string | null;
  name: string;
  description: string;
  content: string;
}

const TEMPLATES: Array<{ id: string; key: string; name: string; description: string; content: string }> = [
  {
    id: 'blank',
    key: 'skills.template.blank',
    name: 'New skill',
    description: '',
    content: 'Describe, in the imperative, what the assistant should do differently when this skill is active.'
  },
  {
    id: 'line',
    key: 'skills.template.line',
    name: 'Line editor',
    description: 'Tightens sentences without changing the voice.',
    content: 'When editing: keep the author\'s voice and intent. Cut redundancy, replace clichés with concrete images, and tighten rhythm. Show the edited paragraph only, then list at most three changes and the reason for each.'
  },
  {
    id: 'beta',
    key: 'skills.template.beta',
    name: 'Beta reader',
    description: 'Reports the reading experience, not a rewrite.',
    content: 'Read the passage once. Report where you were confused, bored, or hooked, quoting the exact lines. Do not rewrite unless asked; separate craft problems from taste.'
  },
  {
    id: 'world',
    key: 'skills.template.world',
    name: 'Worldbuilding architect',
    description: 'Derives culture from constraints, not decoration.',
    content: 'Start from one constraint (geography, scarcity, magic cost, power). Derive the consequences people live with: work, food, etiquette, taboos. Save durable facts as story bible entries.'
  }
];

/**
 * Settings → Skills (v1.2.3 Task 7).
 *
 * A card per skill, an editor with a preview of what actually gets injected,
 * builtin reset instead of deletion, and the rule that matters: adding a skill
 * saves it DISABLED, with the Enable button right there.
 */
export function SkillsSection() {
  const t = useT();
  const { skills } = useData();
  const ui = useUi();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [savedDisabled, setSavedDisabled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gallery, setGallery] = useState(false);

  const activeCount = skills.filter((s) => Number(s.enabled) === 1).length;

  async function toggle(s: SkillRow, on: boolean) {
    await dbCall('saveSkill', { id: s.id, name: s.name, description: s.description || '', content: s.content, enabled: on });
    await useData.getState().load();
    if (on && savedDisabled === s.id) setSavedDisabled(null);
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
        // Only an edit keeps its current state; a new row lets the DB default
        // to disabled, which is the whole point of the gate.
        ...(draft.id ? { enabled: Number(skills.find((s) => s.id === draft.id)?.enabled) === 1 } : {})
      });
      await useData.getState().load();
      if (!draft.id) setSavedDisabled(row?.id || null);
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
      content: s.content
    });
    await useData.getState().load();
    if (row?.id) setSavedDisabled(row.id);
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
      content: file.content.replace(/^#\s+.+\n?/, '').trim()
    });
    await useData.getState().load();
    if (row?.id) setSavedDisabled(row.id);
    ui.toast(t('skills.imported').replace('{name}', name), 'ok');
  }

  async function exportSkill(s: SkillRow) {
    const md = `# ${s.name}\n\n${s.description ? s.description + '\n\n' : ''}${s.content}\n`;
    await window.inkwell.exportFile(s.name.replace(/[^\w\- ]+/g, '').trim() || 'skill', md, 'md');
  }

  return (
    <div id="set-skills-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="bolt" size={18} /> {t('settings.skills')}
        <span className="count-badge">{t('skills.activeCount').replace('{n}', String(activeCount))}</span>
      </h1>
      <div className="subtitle">{t('skills.sub')}</div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="primary" onClick={() => setDraft({ id: null, name: '', description: '', content: '' })}>
          <Icon name="plus" size={14} /> {t('skills.add')}
        </button>
        <button className="ghost" onClick={() => setGallery(!gallery)} aria-expanded={gallery}>
          <Icon name="sparkle" size={14} /> {t('skills.templates')}
        </button>
        <button className="ghost" onClick={importSkill}><Icon name="download" size={14} /> {t('skills.import')}</button>
        <span className="hint">{t('skills.gateHint')}</span>
      </div>

      {gallery && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('skills.templates')}</h3>
          <div className="skill-templates">
            {TEMPLATES.map((tpl) => (
              <button key={tpl.id} className="template-card" onClick={() => {
                setDraft({ id: null, name: tpl.name, description: tpl.description, content: tpl.content });
                setGallery(false);
              }}>
                <b>{t(tpl.key)}</b>
                <small>{tpl.description || t('skills.template.blankHint')}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="skills-grid">
        {skills.map((s) => {
          const enabled = Number(s.enabled) === 1;
          const builtin = Number(s.builtin) === 1;
          return (
            <div key={s.id} className={`skill-card ${enabled ? '' : 'off'}`}>
              <div className="skill-card-head">
                <b className="t">{s.name}</b>
                {builtin && <span className="v-src builtin">{t('skills.builtin')}</span>}
                <span style={{ flex: 1 }} />
                <Switch checked={enabled} onChange={(v) => toggle(s, v)} label={s.name} />
              </div>
              <div className="skill-card-desc">{s.description || s.content.slice(0, 140)}</div>
              {savedDisabled === s.id && !enabled && (
                <div className="skill-note">
                  <span>{t('skills.savedDisabled')}</span>
                  <button className="small primary" onClick={() => toggle(s, true)}>{t('skills.enableNow')}</button>
                </div>
              )}
              <div className="skill-card-actions">
                <button className="small" onClick={() => setDraft({ id: s.id, name: s.name, description: s.description || '', content: s.content })}>
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
              <pre className="skill-preview">{`## ${draft.name || t('skills.namePh')}\n${draft.description ? draft.description + '\n' : ''}${draft.content || t('skills.previewHint')}`}</pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
