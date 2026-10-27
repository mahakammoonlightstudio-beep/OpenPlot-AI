import { useEffect, useMemo, useState } from 'react';
import { dbCall, useData, useSettings, useUi } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { buildSystemPrompt } from '../../lib/prompt';

/**
 * Draft survives section switches: leaving Settings → Skills and coming back
 * must not silently throw away half an edited agent.md. It is module scope, so
 * it also survives the component unmounting; only Save or Discard clears it.
 */
let draftCache: string | null = null;

/** Model-facing starter texts. Short on purpose — agent.md is not a novel. */
const TEMPLATES: Array<{ id: 'novelist' | 'editor' | 'minimal'; text: string }> = [
  {
    id: 'novelist',
    text: `You are my co-writer on long-form fiction.

## Priorities
- Keep POV, tense and voice consistent with the previous chapter.
- Every scene needs a goal, an obstacle and a turn; cut scenes that have none.

## Craft
- Concrete sensory detail over adjectives; verbs over adverbs.
- Dialogue carries subtext. No character explains the plot to another.
- End scenes on a decision, a discovery or a reversal.

## Workflow
- Ask about the story bible before inventing canon, and use the story tools to record what we establish.
- When drafting, write prose first; keep notes and options after the scene, clearly separated.
- Match my language.`
  },
  {
    id: 'editor',
    text: `You are a rigorous developmental editor.

## How to critique
- Lead with the single biggest problem, then the rest in order of impact.
- Name the page or line, say what is not working, and why — then give one concrete fix.
- Praise only what is genuinely working, and say why it works.

## Rules
- Do not rewrite my prose unless I ask; show a two-line example instead.
- Distinguish taste from craft: label opinions as opinions.
- Check continuity against the story bible and flag contradictions explicitly.

## Format
- Short sections: What works / What does not / Next steps. No more than five bullets each.`
  },
  {
    id: 'minimal',
    text: `Answer directly and briefly. Use the story tools when a question is about my project's canon. Do not add summaries, caveats or follow-up questions unless they change the answer.`
  }
];

export function AgentMdSection() {
  const t = useT();
  const settings = useSettings();
  const ui = useUi();
  const { skills, styles, memories } = useData();
  const [val, setVal] = useState<string | null>(draftCache);
  const [showPreview, setShowPreview] = useState(false);
  const value = val === null ? settings.agentMd : val;
  const dirty = val !== null && val !== settings.agentMd;

  // Keep the draft in module scope so switching sections is not a data loss.
  useEffect(() => { draftCache = val; }, [val]);

  const style = styles.find((s) => s.id === settings.defaultStyleId) || null;
  const compiled = useMemo(() => buildSystemPrompt({
    defaultSystem: settings.defaultSystem,
    agentMd: value,
    memories: memories.map((m) => m.content),
    memoryEnabled: settings.memoryEnabled,
    skills,
    skillsOff: [],
    style: style as any,
    toolsEnabled: settings.toolsEnabled
  }), [value, settings.defaultSystem, settings.memoryEnabled, settings.toolsEnabled, memories, skills, style]);

  async function restoreDefault() {
    try {
      const shipped = await dbCall<{ version: number; content: string }>('agentMdDefault');
      if (shipped?.content) {
        setVal(shipped.content);
        ui.toast(t('agentmd.restored'), 'info');
      }
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    }
  }

  return (
    <div id="set-agentmd-editor">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="file" size={18} /> agent.md
        {dirty && <span className="agentmd-dirty">{t('agentmd.unsaved')}</span>}
      </h1>
      <div className="subtitle">{t('agentmd.sub')}</div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="hint" style={{ flex: 1 }}>{t('agentmd.templates')}</div>
          {TEMPLATES.map((tpl) => (
            <button key={tpl.id} className="small ghost" onClick={() => setVal(tpl.text)}>{t(`agentmd.tpl.${tpl.id}`)}</button>
          ))}
        </div>
        <textarea
          className="agentmd-editor"
          rows={18}
          value={value}
          spellCheck={false}
          placeholder={'# My agent rules\n- Always answer in English\n- Prefer concise prose…'}
          onChange={(e) => setVal(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
          <div className="hint" style={{ flex: 1 }}>
            {t('agentmd.counter')
              .replace('{chars}', String(value.length))
              .replace('{tokens}', String(Math.round(value.length / 4)))}
          </div>
          <button className="ghost" onClick={() => setShowPreview((v) => !v)}>
            <Icon name="book" size={14} /> {showPreview ? t('agentmd.hidePreview') : t('agentmd.showPreview')}
          </button>
          <button className="ghost" disabled={!dirty} onClick={() => setVal(null)}>{t('agentmd.discard')}</button>
          <button className="ghost" onClick={restoreDefault}>{t('agentmd.restore')}</button>
          <button
            className="primary"
            disabled={!dirty}
            onClick={async () => {
              settings.set('agentMd', value);
              setVal(null);
              draftCache = null;
              ui.toast(t('agentmd.saved'), 'ok');
            }}
          >
            <Icon name="check" size={14} /> {t('agentmd.save')}
          </button>
        </div>
      </div>

      {showPreview && (
        <div className="card">
          <div className="hint" style={{ marginBottom: 8 }}>{t('agentmd.previewHint')}</div>
          <pre className="agentmd-preview">{compiled || t('agentmd.empty')}</pre>
        </div>
      )}
    </div>
  );
}
