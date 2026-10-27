import { useUi } from '../store';
import { useT } from '../i18nReact';
import { Modal } from './Ui';
import { SHORTCUTS, formatCombo, type ShortcutSpec } from '../lib/shortcuts';

const GROUPS: Array<{ id: ShortcutSpec['group']; labelKey: string }> = [
  { id: 'global', labelKey: 'shortcut.group.global' },
  { id: 'composer', labelKey: 'shortcut.group.composer' },
  { id: 'chat', labelKey: 'shortcut.group.chat' }
];

/**
 * The sheet is generated from `SHORTCUTS`, so it cannot drift from the handler
 * or the guide article — there is one list.
 */
export function ShortcutsSheet() {
  const t = useT();
  const open = useUi((s) => s.shortcutsOpen);
  const setShortcuts = useUi((s) => s.setShortcuts);
  if (!open) return null;

  return (
    <Modal title={t('shortcut.title')} onClose={() => setShortcuts(false)} width={560}>
      <div className="shortcut-sheet">
        {GROUPS.map((g) => {
          const rows = SHORTCUTS.filter((s) => s.group === g.id);
          if (!rows.length) return null;
          return (
            <div key={g.id} className="shortcut-group">
              <h4>{t(g.labelKey)}</h4>
              {rows.map((s) => (
                <div key={s.id} className="shortcut-row">
                  <span className="lbl">{t(s.labelKey)}</span>
                  <span className="keys">
                    {s.keys.map((k) => <kbd key={k}>{formatCombo(k)}</kbd>)}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        <div className="hint" style={{ marginTop: 10 }}>{t('shortcut.hint')}</div>
      </div>
    </Modal>
  );
}
