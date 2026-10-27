import { useEffect, useState } from 'react';
import { dbCall } from '../../store';
import { useT } from '../../i18nReact';

// ---------------- Token usage ----------------
interface UsageSummary {
  byModel: Array<{ model: string; messages: number; tin: number | null; tout: number | null; cached: number | null }>;
  byChat: Array<{ id: string; title: string; messages: number; tin: number | null; tout: number | null; cached: number | null }>;
  total: { messages: number; tin: number | null; tout: number | null; cached: number | null };
}

function fmtTok(n: number | null | undefined): string {
  if (n == null) return '—';
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n);
}

export function UsageSection() {
  const t = useT();
  const [sum, setSum] = useState<UsageSummary | null>(null);
  useEffect(() => {
    dbCall<UsageSummary>('usageSummary', {}).then(setSum).catch(() => setSum(null));
  }, []);

  if (!sum) {
    return (
      <div id="set-usage-totals">
        <h1>{t('usage.title')}</h1>
        <div className="hint">{t('usage.noData')}</div>
      </div>
    );
  }
  const hasData = (sum.total?.tin != null || sum.total?.tout != null);
  return (
    <div id="set-usage-totals">
      <h1>{t('usage.title')}</h1>
      <div className="subtitle" style={{ marginBottom: 14 }}>{t('usage.sub')}</div>
      {!hasData ? (
        <div className="empty-state" style={{ minHeight: 200 }}><div>{t('usage.noData')}</div></div>
      ) : (
        <>
          <div className="grid-4" style={{ marginBottom: 16 }}>
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtTok(sum.total?.messages)}</div>
              <div className="hint">{t('usage.messages')}</div>
            </div>
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtTok(sum.total?.tin)}</div>
              <div className="hint">{t('usage.in')}</div>
            </div>
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtTok(sum.total?.tout)}</div>
              <div className="hint">{t('usage.out')}</div>
            </div>
            {/* Prompt tokens the providers actually served from cache — the
                number that makes a caching subscription worth its price. */}
            <div className="card" style={{ margin: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: (sum.total?.cached ?? 0) > 0 ? 'var(--ok)' : undefined }}>
                {fmtTok(sum.total?.cached)}
              </div>
              <div className="hint" title={t('usage.cachedHint')}>{t('usage.cached')}</div>
            </div>
          </div>
          <h3>{t('usage.perChat')}</h3>
          {sum.byChat.map((c) => (
            <div key={c.id} className="list-row">
              <span className="t">{c.title}<small>{c.messages} msg</small></span>
              <span className="hint" style={{ fontFamily: 'var(--mono)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                ↑ {fmtTok(c.tin)} · ↓ {fmtTok(c.tout)}
                {(c.cached ?? 0) > 0 && (
                  <span className="tok-chip cached" title={t('usage.cachedHint')}>{fmtTok(c.cached)}</span>
                )}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
