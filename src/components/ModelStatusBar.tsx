import { useVerifyStore, keyOf, HealthEvent } from '../verifyStore';
import { useT } from '../i18nReact';

function fmtTime(at: number): string {
  const d = new Date(at);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtLatency(ms: number): string {
  if (!ms) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Segmented health bar (green/yellow/red) per model, like uptime pages.
 * Segments = last N recorded events (manual verifies + real generations).
 * Each segment has a hover tooltip with the exact time, outcome and latency.
 * Shows an accuracy disclaimer because it only reflects local observations.
 */
export function ModelStatusBar({ providerId, model }: { providerId?: string; model: string }) {
  const t = useT();
  const history = useVerifyStore((s) => s.history);
  const events = history[keyOf(providerId, model)] || [];

  if (!events.length) {
    return (
      <span className="status-bar-wrap" title={t('health.noData')}>
        <span className="status-bar empty">
          {Array.from({ length: 12 }).map((_, i) => <i key={i} />)}
        </span>
        <span className="status-label">—</span>
      </span>
    );
  }

  const shown = events.slice(-24);
  const okCount = shown.filter((e) => e.state === 'ok').length;
  const degradedCount = shown.filter((e) => e.state === 'degraded').length;
  const failCount = shown.filter((e) => e.state === 'fail').length;
  const reliability = Math.round(((okCount + degradedCount * 0.5) / shown.length) * 100);
  const avgLatency = Math.round(shown.reduce((a, e) => a + (e.latencyMs || 0), 0) / shown.length);

  const stateClass: Record<HealthEvent['state'], string> = { ok: 'ok', degraded: 'warn', fail: 'bad' };
  const stateLabel: Record<HealthEvent['state'], string> = {
    ok: t('health.stateOk'),
    degraded: t('health.stateDegraded'),
    fail: t('health.stateFail')
  };

  return (
    <span className="status-bar-wrap" title={t('health.disclaimer')}>
      <span className="status-bar">
        {shown.map((e, i) => (
          <i
            key={i}
            className={stateClass[e.state]}
            title={`${stateLabel[e.state]} · ${fmtTime(e.at)}${e.latencyMs ? ` · ${fmtLatency(e.latencyMs)}` : ''}`}
          />
        ))}
      </span>
      <span className="status-label">
        {reliability}%
        <em className="status-latency">{avgLatency > 0 ? fmtLatency(avgLatency) : ''}</em>
        <em className="status-count fail-count">{failCount > 0 ? `${failCount}${t('health.failShort')}` : ''}</em>
      </span>
    </span>
  );
}
