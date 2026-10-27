import { useEffect, useState } from 'react';
import { useData, useSettings, useUi, dbCall, DONATE_LINKS } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { confirmDialog } from '../TextPrompt';
import { formatBytes } from '../../lib/storyImport';
import type { AppInfo, DbStats } from '../../types';

// ---------------- Data ----------------
export function DataSection({ appInfo }: { appInfo: AppInfo | null }) {
  const t = useT();
  const ui = useUi();
  const [stats, setStats] = useState<DbStats | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [clearingFiles, setClearingFiles] = useState(false);
  const refreshStats = async () => {
    try { setStats(await dbCall<DbStats>('dbStats')); } catch { /* stats are optional */ }
  };
  useEffect(() => { refreshStats(); }, []);
  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="folder" size={18} /> {t('settings.data')}</h1>
      <div className="subtitle">{t('data.sub')}</div>
      <div className="card">
        <label>{t('data.storage')}</label>
        <div className="db-stats" id="set-data-chatfiles">
          <div className="db-size">{stats ? formatBytes(stats.bytes) : '…'}</div>
          {stats && (
            <div className="hint">
              {t('data.counts')
                .replace('{messages}', stats.messages.toLocaleString())
                .replace('{chats}', stats.chats.toLocaleString())
                .replace('{chapters}', stats.chapters.toLocaleString())
                .replace('{story}', stats.story.toLocaleString())}
              {stats.storyFiles > 0 ? <> · {t('data.files').replace('{n}', String(stats.storyFiles))}</> : null}
              {stats.chatFiles > 0 ? <> · {t('data.chatFiles').replace('{n}', String(stats.chatFiles)).replace('{size}', formatBytes(stats.chatFileBytes))}</> : null}
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="small ghost" onClick={refreshStats}><Icon name="refresh" size={13} /> {t('data.refresh')}</button>
            <button className="small" id="set-data-compact" disabled={compacting} onClick={async () => {
              setCompacting(true);
              try {
                await dbCall('compactDb');
                await refreshStats();
                ui.toast(t('data.compacted'), 'ok');
              } catch (e: any) {
                ui.toast(e?.message || 'Compaction failed', 'error');
              } finally { setCompacting(false); }
            }}>
              <Icon name="bolt" size={13} /> {compacting ? t('data.compacting') : t('data.compact')}
            </button>
            {stats && stats.chatFiles > 0 && (
              <button className="small danger" disabled={clearingFiles} onClick={async () => {
                if (!(await confirmDialog({
                  title: t('data.clearChatFilesConfirm'), danger: true,
                  confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel')
                }))) return;
                setClearingFiles(true);
                try {
                  const res = await dbCall<{ removed: number }>('clearChatFiles');
                  await refreshStats();
                  ui.toast(t('data.chatFilesCleared').replace('{n}', String(res?.removed ?? 0)), 'ok');
                } catch (e: any) {
                  ui.toast(e?.message || 'Clear failed', 'error');
                } finally { setClearingFiles(false); }
              }}>
                <Icon name="trash" size={13} /> {t('data.clearChatFiles')}
              </button>
            )}
          </div>
          <div className="hint">{t('data.compactHint')}</div>
          {stats && stats.chatFiles > 0 ? <div className="hint">{t('data.clearChatFilesHint')}</div> : null}
        </div>
        <hr />
        <div id="set-data-path">
          <label>{t('data.location')}</label>
          <code>{appInfo?.dataPath || '…'}</code>
        </div>
        <div className={`enc-badge ${appInfo?.encryption ? 'on' : 'off'}`}>
          <span className="enc-dot" />
          <div className="enc-text">
            <b>{t('data.encTitle')}</b>
            <span>{appInfo?.encryption ? t('data.encOn') : t('data.encOff')}</span>
            {!appInfo?.encryption && <span className="hint">{t('data.encHint')}</span>}
          </div>
        </div>
        <hr />
        <button className="danger" id="set-data-reset" onClick={async () => {
          if (!(await confirmDialog({ title: t('data.resetConfirm'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
          await dbCall('resetAll');
          await useData.getState().load();
          await useSettings.getState().load(); // in-memory settings must match wiped DB
          ui.toast(t('data.resetDone'), 'ok');
        }}>{t('data.reset')}</button>
      </div>
      <div className="card">
        <h3>{t('about.donate')}</h3>
        <div className="row" style={{ gap: 8 }}>
          {DONATE_LINKS.map((d, i) => (
            <button key={d.id} className={i === 0 ? 'primary' : ''} onClick={() => window.inkwell.openExternal(d.url)}>
              <Icon name={d.id === 'saweria' ? 'heart' : 'donate'} size={14} /> {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
