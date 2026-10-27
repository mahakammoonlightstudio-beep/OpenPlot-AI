import { useEffect, useState } from 'react';
import { useData, dbCall, uid, useUi } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import { Modal } from '../Ui';
import { confirmDialog } from '../TextPrompt';
import type { McpRow, McpServerStatus } from '../../types';

// ---------------- MCP ----------------
const MCP_RECOMMENDATIONS = [
  { name: 'Filesystem', desc: 'Read/write files in a folder you allowlist', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","C:\\\\path\\\\to\\\\folder"]' },
  { name: 'Memory', desc: 'Persistent knowledge graph the model can query', command: 'npx', args: '["-y","@modelcontextprotocol/server-memory"]' },
  { name: 'Fetch', desc: 'Fetch web pages and convert to markdown', command: 'npx', args: '["-y","@modelcontextprotocol/server-fetch"]' },
  { name: 'Git', desc: 'Inspect and operate on a local git repo', command: 'npx', args: '["-y","@modelcontextprotocol/server-git"]' },
  { name: 'SQLite', desc: 'Query a local SQLite database', command: 'npx', args: '["-y","@modelcontextprotocol/server-sqlite","C:\\\\path\\\\to\\\\data.db"]' },
  { name: 'Puppeteer', desc: 'Drive a headless browser', command: 'npx', args: '["-y","@modelcontextprotocol/server-puppeteer"]' }
];

/**
 * MCP servers (Task 13).
 *
 * Definitions live in the database; the bridge lives in the main process. This
 * view is the honest window on both: what is stored, what is actually running,
 * how many tools each server reports, the last error and a filtered log. A
 * stored definition never starts a process — enabling is an explicit action
 * with a trust warning, because an MCP server runs as a local command.
 */
export function McpSection() {
  const t = useT();
  const ui = useUi();
  const { mcpServers } = useData();
  const [rows, setRows] = useState<McpRow[]>([]);
  const [status, setStatus] = useState<Record<string, McpServerStatus>>({});
  const [logOpen, setLogOpen] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => setRows(mcpServers.map((m) => ({ ...m }))), [mcpServers]);

  async function refreshStatus() {
    try {
      const res = await window.inkwell.mcpList();
      const map: Record<string, McpServerStatus> = {};
      for (const s of res?.data || []) map[s.id] = s;
      setStatus(map);
    } catch { /* plain-browser dev has no bridge */ }
  }
  useEffect(() => { refreshStatus(); }, [mcpServers]);

  async function save(row: McpRow, overrides: Partial<McpRow> = {}) {
    const merged = { ...row, ...overrides };
    let args = merged.args || '[]';
    try { JSON.parse(args); } catch { ui.toast(t('mcp.badArgs'), 'error'); args = '[]'; }
    let env = merged.env || '{}';
    try { JSON.parse(env); } catch { ui.toast(t('mcp.badEnv'), 'error'); env = '{}'; }
    await dbCall('saveMcpServer', {
      id: merged.id, name: merged.name, command: merged.command,
      args, env, enabled: Number(merged.enabled) === 1
    });
    await useData.getState().load();
    // The registry follows the database: enabling starts the process now, and
    // disabling stops it (no restart of the app required).
    try { await window.inkwell.mcpSync(); } catch { /* bridge missing */ }
    await refreshStatus();
  }

  async function restart(id: string) {
    setBusy(id);
    try {
      const res = await window.inkwell.mcpRestart(id);
      if (res?.error) ui.toast(res.error, 'error');
      else ui.toast(t('mcp.restarted'), 'ok');
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function openLogs(id: string) {
    try {
      const res = await window.inkwell.mcpLogs(id);
      setLogs(res?.data || []);
    } catch { setLogs([]); }
    setLogOpen(id);
  }

  async function setEnabled(row: McpRow, next: boolean) {
    if (next) {
      const ok = await confirmDialog({
        title: t('mcp.trustTitle'),
        message: t('mcp.trustBody').replace('{cmd}', `${row.command} ${row.args}`),
        confirmLabel: t('mcp.trustConfirm')
      });
      if (!ok) return;
    }
    await save(row, { enabled: next ? 1 : 0 });
  }

  const statusLabel = (s?: McpServerStatus) => {
    const st = s?.status || 'stopped';
    return t('mcp.st.' + st);
  };

  return (
    <div id="set-mcp-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="server" size={18} /> {t('settings.mcp')}</h1>
      <div className="subtitle">{t('mcp.sub')}</div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('mcp.recommended')}</h3>
        <div className="mcp-recs">
          {MCP_RECOMMENDATIONS.filter((r) => !mcpServers.some((m) => m.name === r.name)).map((r) => (
            <button key={r.name} className="mcp-rec" onClick={async () => {
              await dbCall('saveMcpServer', { id: uid(), name: r.name, command: r.command, args: r.args, env: '{}', enabled: 0 });
              await useData.getState().load();
            }}>
              <span className="mcp-rec-name"><Icon name="server" size={13} /> {r.name}</span>
              <span className="mcp-rec-desc">{r.desc}</span>
              <span className="mcp-rec-add"><Icon name="plus" size={12} /> {t('mcp.add')}</span>
            </button>
          ))}
          {MCP_RECOMMENDATIONS.every((r) => mcpServers.some((m) => m.name === r.name)) && (
            <div className="hint">{t('mcp.allAdded')}</div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10, gap: 8 }}>
          <button className="primary" onClick={async () => {
            await dbCall('saveMcpServer', { id: uid(), name: 'new-server', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","/path/to/dir"]', env: '{}', enabled: 0 });
            await useData.getState().load();
          }}><Icon name="plus" size={14} /> {t('mcp.add')}</button>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={async () => { await window.inkwell.mcpSync().catch(() => {}); await refreshStatus(); }}>
            <Icon name="refresh" size={13} /> {t('mcp.refresh')}
          </button>
        </div>

        {rows.length === 0 && <div className="hint">{t('mcp.none')}</div>}

        {rows.map((m) => {
          const s = status[m.id];
          const running = s?.status === 'connected' || s?.status === 'starting';
          return (
            <div className="provider-card" key={m.id}>
              <div className="head">
                <span className={`mcp-dot ${s?.status || 'stopped'}`} title={statusLabel(s)} aria-label={statusLabel(s)} />
                <input type="checkbox" checked={Number(m.enabled) === 1} aria-label={t('mcp.enabled')}
                  onChange={(e) => setEnabled(m, e.target.checked)} />
                <input style={{ flex: 1 }} value={m.name} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)))} />
                <span className="mcp-status">
                  {statusLabel(s)}{Number(m.enabled) === 1 && s ? ` · ${t('mcp.toolCount').replace('{n}', String(s.tools))}` : ''}
                </span>
                <button className="small ghost" disabled={busy === m.id || Number(m.enabled) !== 1}
                  title={t('mcp.restart')} aria-label={t('mcp.restart')} onClick={() => restart(m.id)}>
                  <Icon name="refresh" size={13} />
                </button>
                <button className="small ghost" onClick={() => openLogs(m.id)} title={t('mcp.logs')} aria-label={t('mcp.logs')}>
                  <Icon name="file" size={13} />
                </button>
                <button className="small primary" onClick={() => save(m)} title={t('mcp.save')} aria-label={t('mcp.save')}><Icon name="check" size={13} /></button>
                <button className="small danger" onClick={async () => { await dbCall('deleteMcpServer', { id: m.id }); await useData.getState().load(); await window.inkwell.mcpSync().catch(() => {}); }} title={t('mcp.delete')} aria-label={t('mcp.delete')}><Icon name="trash" size={13} /></button>
              </div>
              <div className="grid">
                <div>
                  <label>{t('mcp.command')}</label>
                  <input value={m.command} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, command: e.target.value } : x)))} />
                </div>
                <div>
                  <label>{t('mcp.args')}</label>
                  <input value={m.args} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, args: e.target.value } : x)))} />
                </div>
                <div className="full">
                  <label>{t('mcp.env')}</label>
                  <input value={m.env || '{}'} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, env: e.target.value } : x)))} />
                </div>
              </div>
              {Number(m.enabled) === 1 && running && !s?.lastError && (
                <div className="hint">{t('mcp.liveHint').replace('{n}', String(s?.tools || 0))}</div>
              )}
              {s?.lastError && <div className="mcp-error"><Icon name="x" size={12} /> {s.lastError}</div>}
            </div>
          );
        })}
      </div>

      {logOpen && (
        <Modal title={t('mcp.logs')} onClose={() => setLogOpen(null)} width={620}>
          {logs.length === 0
            ? <div className="hint">{t('mcp.noLogs')}</div>
            : <pre className="mcp-logs">{logs.join('\n')}</pre>}
        </Modal>
      )}
    </div>
  );
}
