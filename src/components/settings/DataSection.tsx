import { useEffect, useState } from 'react';
import { useData, useSettings, useUi, dbCall, DONATE_LINKS } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { confirmDialog, textPrompt } from '../TextPrompt';
import { formatBytes } from '../../lib/storyImport';
import type { AppInfo, DbStats, LibraryEntry, LibraryState, SnapshotEntry, SnapshotState } from '../../types';

// ---------------- Data ----------------
export function DataSection({ appInfo }: { appInfo: AppInfo | null }) {
  const t = useT();
  const ui = useUi();
  const [stats, setStats] = useState<DbStats | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [clearingFiles, setClearingFiles] = useState(false);
  const [libraries, setLibraries] = useState<LibraryState | null>(null);
  const [libraryBusy, setLibraryBusy] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotState | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState<string | null>(null);
  const refreshStats = async () => {
    try { setStats(await dbCall<DbStats>('dbStats')); } catch { /* stats are optional */ }
  };
  const refreshLibraries = async () => {
    try {
      const api = (window.inkwell as any).libraries;
      if (!api) return;
      const res = await api();
      if (res?.ok) setLibraries(res.data);
    } catch { /* library manager is optional in browser-only dev */ }
  };
  const refreshSnapshots = async () => {
    try {
      const api = (window.inkwell as any).snapshots;
      if (!api) return;
      const res = await api();
      if (res?.ok) setSnapshots(res.data);
    } catch { /* Time Machine is optional in browser-only dev */ }
  };
  useEffect(() => { refreshStats(); void refreshLibraries(); void refreshSnapshots(); }, []);

  const libraryLabel = (entry: LibraryEntry) => {
    if (entry.status === 'current') return t('library.current');
    if (entry.status === 'legacy') return entry.schema === 0 ? t('library.unversioned') : t('library.legacy').replace('{n}', String(entry.schema));
    if (entry.status === 'newer') return t('library.newer');
    return t('library.unreadable');
  };

  const snapshotReason = (reason: string) => {
    if (reason.startsWith('pre-migration')) return t('snapshot.reason.pre-migration');
    return t(`snapshot.reason.${reason}`);
  };
  const snapshotDate = (savedAt: number) => new Date(savedAt).toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'short'
  });

  async function useLibrary(entry: LibraryEntry) {
    if (entry.active || libraryBusy) return;
    if (entry.status === 'newer' || entry.status === 'unreadable') {
      ui.toast(t(entry.status === 'newer' ? 'library.newerHint' : 'library.unreadableHint'), 'error');
      return;
    }
    const ok = await confirmDialog({
      title: t('library.switchConfirm').replace('{name}', entry.name),
      confirmLabel: t('library.restart'), cancelLabel: t('confirm.cancel')
    });
    if (!ok) return;
    setLibraryBusy(entry.name);
    try {
      const res = await window.inkwell.librarySwitch(entry.name);
      if (!res.ok) throw new Error(res.error || 'Could not switch library');
      ui.toast(t('library.restarting'), 'ok');
    } catch (e: any) {
      setLibraryBusy(null);
      ui.toast(e?.message || String(e), 'error');
    }
  }

  async function createLibrary() {
    if (libraryBusy) return;
    const name = await textPrompt({ title: t('library.createPrompt'), confirmLabel: t('library.create') });
    if (!name) return;
    setLibraryBusy('new');
    try {
      const res = await window.inkwell.libraryCreate(name);
      if (!res.ok) throw new Error(res.error || 'Could not create library');
      ui.toast(t('library.restarting'), 'ok');
    } catch (e: any) {
      setLibraryBusy(null);
      ui.toast(e?.message || String(e), 'error');
    }
  }

  async function importLibrary() {
    if (libraryBusy) return;
    setLibraryBusy('import');
    try {
      const res = await window.inkwell.libraryImport();
      if (!res.ok) {
        if (res.error !== 'cancelled') ui.toast(res.error || 'Import failed', 'error');
        return;
      }
      await refreshLibraries();
      await refreshSnapshots();
      if (res.data?.entry) {
        ui.toast(t('library.imported').replace('{name}', res.data.entry.name), 'ok');
      }
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setLibraryBusy(null);
    }
  }

  async function exportLibrary() {
    if (libraryBusy) return;
    setLibraryBusy('export');
    try {
      const res = await window.inkwell.libraryExport();
      if (!res.ok) {
        if (res.error !== 'cancelled') ui.toast(res.error || 'Export failed', 'error');
        return;
      }
      if (res.data) {
        ui.toast(t('library.exported')
          .replace('{name}', res.data.name)
          .replace('{size}', formatBytes(res.data.bytes)), 'ok');
      }
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setLibraryBusy(null);
    }
  }

  async function createSnapshot() {
    if (snapshotBusy || libraryBusy) return;
    setSnapshotBusy('create');
    try {
      const res = await window.inkwell.snapshotCreate();
      if (!res.ok) throw new Error(res.error || 'Could not create snapshot');
      if (res.data?.state) setSnapshots(res.data.state);
      else await refreshSnapshots();
      ui.toast(t('snapshot.created'), 'ok');
    } catch (e: any) {
      ui.toast(e?.message || String(e), 'error');
    } finally {
      setSnapshotBusy(null);
    }
  }

  async function restoreSnapshot(entry: SnapshotEntry) {
    if (snapshotBusy || libraryBusy) return;
    const when = snapshotDate(entry.savedAt);
    const ok = await confirmDialog({
      title: t('snapshot.restoreConfirm').replace('{time}', when),
      danger: true,
      confirmLabel: t('snapshot.restore'),
      cancelLabel: t('confirm.cancel')
    });
    if (!ok) return;
    setSnapshotBusy(entry.name);
    try {
      const res = await window.inkwell.snapshotRestore(entry.name);
      if (!res.ok) throw new Error(res.error || 'Could not restore snapshot');
      ui.toast(t('snapshot.restoreDone'), 'ok');
    } catch (e: any) {
      setSnapshotBusy(null);
      ui.toast(e?.message || String(e), 'error');
    }
  }
  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="folder" size={18} /> {t('settings.data')}</h1>
      <div className="subtitle">{t('data.sub')}</div>
      <div className="card" id="set-libraries">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon name="folder" size={15} /> {t('library.title')}
        </h3>
        <div className="subtitle" style={{ marginBottom: 8 }}>{t('library.sub')}</div>
        <div className="library-list">
          {!libraries && <div className="hint">{t('library.loading')}</div>}
          {libraries?.entries.map((entry) => (
            <div key={entry.name} className={`library-row ${entry.active ? 'active' : ''}`}>
              <div className="library-main">
                <div className="library-name" title={entry.name}>{entry.name}</div>
                <div className="library-meta">
                  {entry.status === 'unreadable'
                    ? t('library.unreadableHint')
                    : `${formatBytes(entry.bytes)} · schema ${entry.schema ?? '?'}`}
                </div>
              </div>
              <div className="library-badges">
                {entry.active && <span className="library-badge current">{t('library.active')}</span>}
                <span className={`library-badge ${entry.status}`}>{libraryLabel(entry)}</span>
                {!entry.active && entry.status !== 'newer' && entry.status !== 'unreadable' && (
                  <button
                    className="small"
                    disabled={!!libraryBusy}
                    onClick={() => void useLibrary(entry)}
                  >{libraryBusy === entry.name ? t('library.restarting') : t('library.use')}</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="library-actions">
          <button className="small" disabled={!!libraryBusy} onClick={() => void createLibrary()}>
            <Icon name="plus" size={13} /> {t('library.create')}
          </button>
          <button className="small" disabled={!!libraryBusy} onClick={() => void importLibrary()}>
            <Icon name="download" size={13} /> {t('library.import')}
          </button>
          <button className="small" id="set-library-export" disabled={!!libraryBusy} onClick={() => void exportLibrary()}>
            <Icon name="upload" size={13} /> {libraryBusy === 'export' ? t('library.exporting') : t('library.export')}
          </button>
          <button className="small ghost" onClick={() => void window.inkwell.revealDataFolder()}>{t('library.reveal')}</button>
          <button className="small ghost" onClick={() => void refreshLibraries()} disabled={!!libraryBusy}>
            <Icon name="refresh" size={13} /> {t('data.refresh')}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{t('library.exportHint')}</div>
        <div className="hint" style={{ marginTop: 4 }}>{t('library.universal')}</div>
        {libraries && (
          <div className="hint" style={{ marginTop: 4 }}>
            {t('library.folder')}: <code>{libraries.dir}</code>
          </div>
        )}
      </div>

      <div className="card" id="set-snapshots">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon name="clock" size={15} /> {t('snapshot.title')}
        </h3>
        <div className="subtitle" style={{ marginBottom: 8 }}>
          {t('snapshot.sub').replace('{max}', String(snapshots?.max ?? 12))}
        </div>
        <div className="snapshot-list">
          {!snapshots && <div className="hint">{t('snapshot.loading')}</div>}
          {snapshots && snapshots.entries.length === 0 && (
            <div className="snapshot-empty">{t('snapshot.empty')}</div>
          )}
          {snapshots?.entries.map((entry) => (
            <div key={entry.name} className="snapshot-row">
              <div className="snapshot-icon"><Icon name="clock" size={14} /></div>
              <div className="snapshot-main">
                <div className="snapshot-name">{snapshotReason(entry.reason)}</div>
                <div className="snapshot-meta">
                  {snapshotDate(entry.savedAt)} · {formatBytes(entry.bytes)} · schema {entry.schema ?? '?'}{' '}
                  {entry.status === 'legacy' && (
                    <span className="snapshot-tag">{t('snapshot.migrates')}</span>
                  )}
                  {entry.status === 'unreadable' && (
                    <span className="snapshot-tag danger">{t('library.unreadable')}</span>
                  )}
                </div>
              </div>
              <button
                className="small"
                disabled={!!snapshotBusy || !!libraryBusy || entry.status === 'unreadable' || entry.status === 'newer'}
                onClick={() => void restoreSnapshot(entry)}
              >
                {snapshotBusy === entry.name ? t('snapshot.restoring') : t('snapshot.restore')}
              </button>
            </div>
          ))}
        </div>
        <div className="library-actions">
          <button className="small" disabled={!!snapshotBusy || !!libraryBusy} onClick={() => void createSnapshot()}>
            <Icon name="plus" size={13} /> {snapshotBusy === 'create' ? t('snapshot.creating') : t('snapshot.create')}
          </button>
          <button className="small ghost" disabled={!!snapshotBusy} onClick={() => void refreshSnapshots()}>
            <Icon name="refresh" size={13} /> {t('data.refresh')}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{t('snapshot.hint')}</div>
        {snapshots && <div className="hint" style={{ marginTop: 4 }}>{t('snapshot.for').replace('{name}', snapshots.active)}</div>}
      </div>

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
          {appInfo?.dbPath && <div className="hint" style={{ marginTop: 5 }}>{t('library.activeFile')}: <code>{appInfo.dbPath}</code></div>}
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
          try {
            await dbCall('resetAll');
            await useData.getState().load();
            await useSettings.getState().load(); // in-memory settings must match wiped DB
            await refreshSnapshots(); // the automatic before-reset copy is now listed
            ui.toast(t('data.resetDone'), 'ok');
          } catch (e: any) {
            ui.toast(e?.message || 'Reset failed', 'error');
          }
        }}>{t('data.reset')}</button>
        {/* Say exactly what a reset destroys before the confirm dialog appears. */}
        <div className="reset-note">
          <div className="rn-title"><Icon name="bolt" size={13} /> {t('data.resetIncludes')}</div>
          <div className="rn-body">
            {stats
              ? `${stats.messages.toLocaleString()} ${t('data.msgUnit')} · ${stats.chats.toLocaleString()} ${t('data.chatUnit')} · ${stats.chapters.toLocaleString()} ${t('data.chapterUnit')} · ${stats.story.toLocaleString()} ${t('data.entryUnit')}`
              : t('data.resetHint')}
          </div>
        </div>
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
