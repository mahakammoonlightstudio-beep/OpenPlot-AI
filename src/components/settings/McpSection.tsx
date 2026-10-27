import { useEffect, useState } from 'react';
import { useData, dbCall, uid } from '../../store';
import { useT } from '../../i18nReact';
import { Icon } from '../Icons';
import type { McpRow } from '../../types';

// ---------------- MCP ----------------
const MCP_RECOMMENDATIONS = [
  { name: 'Filesystem', desc: 'Read/write files in a folder you allowlist', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","C:\\path\\to\\folder"]' },
  { name: 'Memory', desc: 'Persistent knowledge graph the model can query', command: 'npx', args: '["-y","@modelcontextprotocol/server-memory"]' },
  { name: 'Fetch', desc: 'Fetch web pages and convert to markdown', command: 'npx', args: '["-y","@modelcontextprotocol/server-fetch"]' },
  { name: 'Git', desc: 'Inspect and operate on a local git repo', command: 'npx', args: '["-y","@modelcontextprotocol/server-git"]' },
  { name: 'SQLite', desc: 'Query a local SQLite database', command: 'npx', args: '["-y","@modelcontextprotocol/server-sqlite","C:\\path\\to\\data.db"]' },
  { name: 'Puppeteer', desc: 'Drive a headless browser', command: 'npx', args: '["-y","@modelcontextprotocol/server-puppeteer"]' }
];

export function McpSection() {
  const t = useT();
  const { mcpServers } = useData();
  const [rows, setRows] = useState<McpRow[]>([]);

  useEffect(() => setRows(mcpServers.map((m) => ({ ...m }))), [mcpServers]);

  return (
    <div id="set-mcp-list">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="server" size={18} /> {t('settings.mcp')}</h1>
      <div className="subtitle">{t('mcp.sub')}</div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('mcp.recommended')}</h3>
        <div className="mcp-recs">
          {MCP_RECOMMENDATIONS.filter((r) => !mcpServers.some((m) => m.name === r.name)).map((r) => (
            <button key={r.name} className="mcp-rec" onClick={async () => {
              await dbCall('saveMcpServer', { id: uid(), name: r.name, command: r.command, args: r.args, enabled: 0 });
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
        <button className="primary" style={{ marginBottom: 10 }} onClick={async () => {
          await dbCall('saveMcpServer', { id: uid(), name: 'new-server', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","/path/to/dir"]', enabled: 1 });
          await useData.getState().load();
        }}><Icon name="plus" size={14} /> {t('mcp.add')}</button>
        {rows.map((m) => (
          <div className="provider-card" key={m.id}>
            <div className="head">
              <input type="checkbox" checked={Number(m.enabled) === 1}
                onChange={async (e) => { await dbCall('saveMcpServer', { id: m.id, name: m.name, command: m.command, args: m.args, enabled: e.target.checked }); await useData.getState().load(); }} />
              <input style={{ flex: 1 }} value={m.name} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)))} />
              <button className="small primary" onClick={async () => {
                let args = m.args || '[]';
                try { JSON.parse(args); } catch { args = '[]'; } // persist valid JSON only
                await dbCall('saveMcpServer', { id: m.id, name: m.name, command: m.command, args, enabled: Number(m.enabled) === 1 });
                await useData.getState().load();
              }}><Icon name="check" size={13} /></button>
              <button className="small danger" onClick={async () => { await dbCall('deleteMcpServer', { id: m.id }); await useData.getState().load(); }}><Icon name="trash" size={13} /></button>
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
