import { useEffect, useState } from 'react';
import { useT } from '../../i18nReact';
import { useUi } from '../../store';
import { Icon } from '../Icons';
import type { TrustEntry } from '../../types';

/**
 * Stored execution approvals (v1.2.5).
 *
 * A plugin or MCP server runs only after the user confirmed that exact code.
 * This list is the way back: every remembered approval is visible, and
 * revoking one stops it immediately (the main process reloads plugins / stops
 * the server) instead of waiting for the next restart. `stale` marks an
 * approval that no longer matches the current code — the user will be asked
 * again — and `deleted` marks a hash whose row is gone.
 */
export function TrustList({ kind, version }: { kind: 'plugin' | 'mcp'; version?: unknown }) {
  const t = useT();
  const ui = useUi();
  const [rows, setRows] = useState<TrustEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const stale = rows.filter((r) => r.stale).length;
  const orphan = rows.filter((r) => !r.present).length;
  const review = stale + orphan;

  async function refresh() {
    try {
      const res = await window.inkwell?.trustList?.();
      setRows((res?.data || []).filter((r) => r.kind === kind));
    } catch {
      setRows([]);
    }
  }
  useEffect(() => { refresh(); }, [kind, version]);

  async function revoke(id: string) {
    setBusy(id);
    try {
      const res = await window.inkwell.trustRevoke(kind, id);
      if (res?.ok) {
        setRows((res.data || []).filter((r) => r.kind === kind));
        ui.toast(t('trust.revoked'), 'ok');
      } else {
        ui.toast(res?.error || 'error', 'error');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" id={`set-trust-${kind}`}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="check" size={15} /> {t('trust.title')}
      </h3>
      <div className="hint" style={{ marginBottom: 8 }}>{t('trust.hint')}</div>
      {rows.length > 0 && (
        <div className="hint" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <span>{t('trust.count').replace('{n}', String(rows.length))}</span>
          {review > 0 && (
            <span style={{ color: 'var(--warn)' }}>
              {t('trust.review').replace('{n}', String(review))}
              {stale > 0 ? ` · ${t('trust.staleCount').replace('{n}', String(stale))}` : ''}
              {orphan > 0 ? ` · ${t('trust.orphanCount').replace('{n}', String(orphan))}` : ''}
            </span>
          )}
        </div>
      )}
      {rows.length === 0 && <div className="hint">{t('trust.empty')}</div>}
      {rows.map((r) => (
        <div className="list-row" key={`${r.kind}:${r.id}`}>
          <div className="t">
            {r.label}
            <small>
              {r.kind === 'plugin' ? t('trust.kindPlugin') : t('trust.kindMcp')}
              {!r.present ? ` · ${t('trust.orphan')}` : r.stale ? ` · ${t('trust.stale')}` : ''}
            </small>
          </div>
          <button
            className="small danger"
            disabled={busy === r.id}
            title={t('trust.revoke')}
            aria-label={t('trust.revoke')}
            onClick={() => revoke(r.id)}
          >
            <Icon name="x" size={12} /> {t('trust.revoke')}
          </button>
        </div>
      ))}
    </div>
  );
}
