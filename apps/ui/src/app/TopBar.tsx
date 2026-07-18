/**
 * TopBar (docs/UI_SPEC.md): wordmark, session picker (live sessions +
 * recordings), live/demo/replay badges, a Run-demo action, theme toggle and
 * the shortcuts hint. Selection changes are lifted to App, which owns the
 * socket subscription and recording fetch.
 */
import { useSessions } from '../store/sessions';
import { useWorkspace } from '../store/workspace';
import { useUi, isReplaying } from '../store/ui';
import { shortId } from './format';

export interface SessionChoice {
  kind: 'live' | 'recording';
  id: string;
}

export function TopBar({
  onSelectSession,
  onRunDemo,
}: {
  onSelectSession(choice: SessionChoice): void;
  onRunDemo(): void;
}) {
  const sessions = useSessions((s) => s.sessions);
  const recordings = useSessions((s) => s.recordings);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const replaying = useUi(isReplaying);
  const replayRecordingId = useUi((s) => s.replay.recordingId);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const theme = useUi((s) => s.theme);
  const toggleShortcuts = useUi((s) => s.toggleShortcuts);

  const connection = useWorkspace((s) => s.connection);
  const source = useWorkspace((s) =>
    activeSessionId ? s.state.sessions[activeSessionId]?.source : undefined,
  );

  const value = replaying
    ? `recording:${replayRecordingId}`
    : activeSessionId
      ? `live:${activeSessionId}`
      : '';

  const onChange = (raw: string) => {
    if (!raw) return;
    const [kind, ...rest] = raw.split(':');
    const id = rest.join(':');
    if (kind === 'recording') onSelectSession({ kind: 'recording', id });
    else if (kind === 'live') onSelectSession({ kind: 'live', id });
  };

  return (
    <header className="vw-topbar">
      <div className="vw-wordmark">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#0B0E14" />
          <path d="M11 14.5 20 9M11 17.5 20 23" stroke="#3A4356" strokeWidth="2" />
          <circle cx="9" cy="16" r="3.6" fill="#4CC2FF" />
          <circle cx="23" cy="8.5" r="3" fill="#A78BFA" />
          <circle cx="23" cy="23.5" r="3" fill="#3DD68C" />
        </svg>
        <span>
          visual<span className="vw-wordmark-dim">-workflows</span>
        </span>
      </div>

      <select
        className="vw-select"
        value={value}
        aria-label="Session"
        onChange={(e) => onChange(e.target.value)}
      >
        {value === '' ? <option value="">No session</option> : null}
        {sessions.length > 0 ? (
          <optgroup label="Live sessions">
            {sessions.map((s) => (
              <option key={s.sessionId} value={`live:${s.sessionId}`}>
                {(s.title ?? shortId(s.sessionId)) + (s.active ? '' : ' (ended)')} · {s.agentCount}{' '}
                agents
              </option>
            ))}
          </optgroup>
        ) : null}
        {recordings.length > 0 ? (
          <optgroup label="Recordings">
            {recordings.map((r) => (
              <option key={r.id} value={`recording:${r.id}`}>
                {r.label} · {r.eventCount} events
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>

      {source === 'demo' && !replaying ? (
        <span className="vw-badge vw-badge-demo">Demo</span>
      ) : null}
      {replaying ? (
        <span className="vw-badge vw-badge-replay">Replay</span>
      ) : source && source !== 'demo' && connection === 'open' ? (
        <span className="vw-badge vw-badge-live">Live</span>
      ) : null}

      <div className="vw-spacer" />

      <button className="vw-btn vw-btn-primary" onClick={onRunDemo} title="Run the scripted demo">
        ▶ Run demo
      </button>
      <button
        className="vw-btn vw-btn-icon"
        onClick={toggleTheme}
        aria-label="Toggle theme"
        title="Toggle theme (t)"
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <button
        className="vw-btn vw-btn-icon"
        onClick={toggleShortcuts}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
      >
        ?
      </button>
    </header>
  );
}
