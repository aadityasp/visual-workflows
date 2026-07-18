/**
 * StatusBar (docs/UI_SPEC.md): agent counts by state, session elapsed, event
 * rate, connection state, minimap toggle. A 1s tick keeps the elapsed clock
 * live and decays the event rate when the stream goes quiet.
 */
import { useEffect } from 'react';
import { useWorkspace } from '../store/workspace';
import { useUi } from '../store/ui';
import { activeSession, lifecycleCounts } from '../store/selectors';
import { formatElapsed } from './format';
import { useNow } from './hooks';

const CONN_LABEL: Record<string, string> = {
  open: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  closed: 'Offline',
};

export function StatusBar() {
  const sessionId = useUi((s) => s.activeSessionId);
  const minimapVisible = useUi((s) => s.minimapVisible);
  const toggleMinimap = useUi((s) => s.toggleMinimap);
  const connection = useWorkspace((s) => s.connection);
  const eventRate = useWorkspace((s) => s.eventRate);
  const tickRate = useWorkspace((s) => s.tickRate);
  // Select the (referentially stable) session, then derive — a selector that
  // returned a fresh counts object would loop useSyncExternalStore.
  const session = useWorkspace((s) => activeSession(s.state, sessionId));
  const counts = lifecycleCounts(session);
  const started = session?.startedTs;
  const ended = session?.endedTs;

  const now = useNow(1000, true);
  useEffect(() => {
    tickRate();
  }, [now, tickRate]);

  const elapsed =
    started != null
      ? formatElapsed((ended ? new Date(ended).getTime() : now) - new Date(started).getTime())
      : '—';

  return (
    <footer className="vw-statusbar">
      <span className="vw-count">
        <b>{counts.total}</b> agents
      </span>
      <span className="vw-count" style={{ color: 'var(--vw-running)' }}>
        <b>{counts.running}</b> running
      </span>
      {counts.attention > 0 ? (
        <span className="vw-count" style={{ color: 'var(--vw-warn)' }}>
          <b>{counts.attention}</b> waiting
        </span>
      ) : null}
      {counts.failed > 0 ? (
        <span className="vw-count" style={{ color: 'var(--vw-danger)' }}>
          <b>{counts.failed}</b> failed
        </span>
      ) : null}
      <span className="vw-count" style={{ color: 'var(--vw-success)' }}>
        <b>{counts.done}</b> done
      </span>

      <span className="vw-spacer" />

      <span className="vw-count">
        elapsed <b>{elapsed}</b>
      </span>
      <span className="vw-count">
        <b>{eventRate}</b>/s
      </span>
      <span className={`vw-conn vw-conn-${connection}`} title={CONN_LABEL[connection]}>
        <span className="vw-dot" />
        {CONN_LABEL[connection]}
      </span>
      <button
        className="vw-btn vw-btn-icon"
        style={{ minHeight: 24, height: 24, width: 24 }}
        aria-pressed={minimapVisible}
        onClick={toggleMinimap}
        title="Toggle minimap (m)"
      >
        ▦
      </button>
    </footer>
  );
}
